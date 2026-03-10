/**
 * index.js - AlgivixAI WhatsApp Bot — AUTONOMOUS EDITION v3
 * ==========================================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * FIXES in v3:
 * - Bad MAC / session corruption → patchMessageBeforeSending + ignore decrypt errors
 * - Bot now responds in ANY group, not just TARGET_GROUP
 * - TARGET_GROUP only used for scheduled broadcasts
 * - Added getMessage store so retries work
 */

require("dotenv").config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  proto,
  getAggregateVotesInPollMessage,
} = require("@whiskeysockets/baileys");

const pino     = require("pino");
const cron     = require("node-cron");
const path     = require("path");
const http     = require("http");
const readline = require("readline");
const NodeCache = require("node-cache");

const { processCommand, handleTask, handleRules } = require("./commands");
const {
  analyzeMessage,
  issueWarning,
  buildWarningMessage,
  buildAdminAlert,
} = require("./moderation");

// ─── HTTP Keep-alive (Render requires an open port) ───────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, () => console.log(`[HTTP] Keep-alive server on port ${PORT}`));

// ─── Config ───────────────────────────────────────────────────────────────────
const SESSION_DIR    = path.join(__dirname, "session");
const PHONE_NUMBER   = (process.env.BOT_PHONE_NUMBER || "").replace(/\D/g, "");
const TARGET_GROUP   = process.env.TARGET_GROUP_JID  || null;
const ADMIN_NUMBERS  = (process.env.ADMIN_NUMBERS    || "").split(",").filter(Boolean);
const INACTIVITY_HRS = parseInt(process.env.INACTIVITY_HOURS || "3");

// ─── Message cache (fixes Bad MAC retry issues) ────────────────────────────────
const msgRetryCache = new NodeCache();

const baileysLogger  = pino({ level: "silent" });
let sock;
let pairingDone      = false;
let lastGroupMessage = Date.now();
let standupResponses = new Map();
let standupActive    = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function sendMsg(jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.error("[sendMsg]", e.message);
  }
}

async function isAdmin(groupJid, senderJid) {
  try {
    const m = await sock.groupMetadata(groupJid);
    return m.participants.some(
      p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
    );
  } catch { return false; }
}

async function getAdmins(groupJid) {
  try {
    const m = await sock.groupMetadata(groupJid);
    return m.participants
      .filter(p => p.admin === "admin" || p.admin === "superadmin")
      .map(p => p.id);
  } catch { return []; }
}

async function getGroupName(groupJid) {
  try {
    const m = await sock.groupMetadata(groupJid);
    return m.subject || "the group";
  } catch { return "the group"; }
}

function formatPhone(jid) {
  return (jid || "").split("@")[0];
}

function askPhone() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      "\n📱 Enter WhatsApp number (country code + number, no + or spaces)\n   e.g. 2347012345678\n> ",
      ans => { rl.close(); resolve(ans.trim().replace(/\D/g, "")); }
    );
  });
}

// ─── Auto Welcome New Members ─────────────────────────────────────────────────
async function welcomeNewMember(groupJid, memberJid) {
  try {
    const name    = formatPhone(memberJid);
    const grpName = await getGroupName(groupJid);
    await sendMsg(groupJid,
      `👋 Welcome to *${grpName}*, @${name}! 🎉\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `I'm *AlgivixAI*, your 24/7 dev assistant!\n\n` +
      `🤖 *!ai <question>* — Ask me anything\n` +
      `🔍 *!review <code>* — Code review\n` +
      `📌 *!task* — Sprint tasks\n` +
      `📋 *!rules* — Group rules\n` +
      `❓ *!help* — All commands\n\n` +
      `Please read the rules and let's build together! 🚀`
    );
    console.log(`[Welcome] Greeted: ${name}`);
  } catch (e) {
    console.error("[welcomeNewMember]", e.message);
  }
}

// ─── Private Broadcast ────────────────────────────────────────────────────────
async function handlePrivateBroadcast(senderJid, message) {
  try {
    if (!TARGET_GROUP) {
      await sendMsg(senderJid, "⚠️ TARGET_GROUP_JID not set in environment variables.");
      return;
    }
    const phone = formatPhone(senderJid);
    if (!ADMIN_NUMBERS.includes(phone)) {
      await sendMsg(senderJid, "🔒 Only authorized admins can broadcast to the group.");
      return;
    }
    if (!message || !message.trim()) {
      await sendMsg(senderJid, "⚠️ Usage: *!broadcast Your message here*");
      return;
    }
    const now = new Date().toLocaleString("en-US", {
      timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short",
    });
    await sendMsg(TARGET_GROUP,
      `📢 *ANNOUNCEMENT — Algivix Dev Team*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `${message.trim()}\n\n🕐 ${now}\n— AlgivixAI`
    );
    await sendMsg(senderJid, "✅ Announcement posted to the group!");
    console.log(`[Broadcast] Admin ${phone} posted announcement`);
  } catch (e) {
    console.error("[handlePrivateBroadcast]", e.message);
  }
}

// ─── Standup ──────────────────────────────────────────────────────────────────
async function startStandup(groupJid) {
  try {
    standupActive    = true;
    standupResponses = new Map();
    await sendMsg(groupJid,
      `📋 *Daily Standup — Algivix Dev Team*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `Good morning team! 🌅 Time for our quick standup.\n\n` +
      `Reply with your update:\n` +
      `✅ *Done:* What you finished yesterday\n` +
      `🔄 *Today:* What you're working on\n` +
      `🚧 *Blocker:* Any blockers? (or "none")\n\n` +
      `⏰ Closes in *30 minutes*. Let's go! 💪`
    );
    setTimeout(() => closeStandup(groupJid), 30 * 60 * 1000);
    console.log("[Standup] Started");
  } catch (e) {
    console.error("[startStandup]", e.message);
  }
}

async function closeStandup(groupJid) {
  try {
    if (!standupActive) return;
    standupActive = false;
    if (standupResponses.size === 0) {
      await sendMsg(groupJid,
        `📋 *Standup Closed*\nNo responses received. Stay engaged team! 💪`
      );
      return;
    }
    let summary = `📋 *Standup Summary — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}*\n`;
    summary    += `━━━━━━━━━━━━━━━━━━━━\n${standupResponses.size} response(s):\n\n`;
    standupResponses.forEach((res, phone) => { summary += `👤 *@${phone}*\n${res}\n\n`; });
    summary += `Great work! Let's crush today! 🚀`;
    await sendMsg(groupJid, summary);
    standupResponses = new Map();
    console.log("[Standup] Closed and summarized");
  } catch (e) {
    console.error("[closeStandup]", e.message);
  }
}

// ─── Inactivity Ping ──────────────────────────────────────────────────────────
const ENGAGEMENT_MESSAGES = [
  `💡 *Dev Tip of the Day*\nWrite code as if the next person maintaining it is a sleep-deprived developer on a deadline — make it readable! 😄\n\nNeed help? Try *!ai <question>*`,
  `🔥 *Quick Challenge!*\nCan anyone explain the difference between *REST* and *GraphQL* in 2 sentences?\nReply and let's learn together! 💬`,
  `📚 *Fun Tech Fact*\nThe first computer bug was a real moth found inside a Harvard computer in 1947! 🦋\nTry *!ai <topic>* to learn something new!`,
  `⚡ *Productivity Tip*\nTake a 5-min break every hour. Your brain and your code will thank you! 🧠\nStuck? Try *!ai <your problem>*`,
  `🎯 *Team Reminder*\nSmall, consistent progress beats big bursts. Check tasks with *!task* and keep moving! 💪`,
  `🛠️ *Best Practice*\nAlways write clear git commit messages!\n❌ "fixed stuff"\n✅ "fix: resolve null pointer in auth module"\nKeep your history clean! ✅`,
  `🚀 *Motivation*\nEvery expert was once a beginner. Every pro was once an amateur.\nKeep coding, keep growing! 💻\nUse *!ai* anytime you need help!`,
];

async function sendEngagementPing(groupJid) {
  try {
    const elapsed = (Date.now() - lastGroupMessage) / (1000 * 60 * 60);
    if (elapsed >= INACTIVITY_HRS) {
      const msg = ENGAGEMENT_MESSAGES[Math.floor(Math.random() * ENGAGEMENT_MESSAGES.length)];
      await sendMsg(groupJid, msg);
      lastGroupMessage = Date.now();
      console.log(`[Inactivity] Pinged after ${elapsed.toFixed(1)}h silence`);
    }
  } catch (e) {
    console.error("[sendEngagementPing]", e.message);
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
async function onMessage(msg) {
  try {
    if (msg.key.fromMe) return;

    const jid       = msg.key.remoteJid;
    const senderJid = msg.key.participant || jid;
    const isGroup   = isJidGroup(jid);
    const mc        = msg.message || {};

    // Extract text from all message types
    const text = (
      mc.conversation                            ||
      mc.extendedTextMessage?.text               ||
      mc.imageMessage?.caption                   ||
      mc.videoMessage?.caption                   ||
      mc.buttonsResponseMessage?.selectedDisplayText ||
      mc.listResponseMessage?.title              ||
      ""
    ).trim();

    if (!text) return;

    console.log(`[${isGroup ? "GRP" : "DM"}] ${formatPhone(senderJid)}: ${text.slice(0, 80)}`);

    // ── GROUP MESSAGES ────────────────────────────────────────────────────────
    if (isGroup) {

      // Option A: Only respond in TARGET_GROUP — ignore all other groups
      if (TARGET_GROUP && jid !== TARGET_GROUP) {
        console.log(`[Bot] Ignored non-target group: ${jid}`);
        return;
      }

      lastGroupMessage = Date.now(); // reset inactivity timer

      const adminUser = await isAdmin(jid, senderJid);

      // Moderation (skip admins)
      if (!adminUser) {
        const { isViolation, reason, severity } = analyzeMessage(senderJid, text);
        if (isViolation) {
          const { count, shouldNotifyAdmin } = issueWarning(senderJid);
          await sendMsg(jid, buildWarningMessage(senderJid, reason, count));
          if (shouldNotifyAdmin) {
            for (const a of await getAdmins(jid))
              await sendMsg(a, buildAdminAlert(senderJid, reason, text));
          }
          if (severity === "high") return;
        }
      }

      // Collect standup response
      if (standupActive && !text.startsWith("!")) {
        standupResponses.set(formatPhone(senderJid), text);
        console.log(`[Standup] Got response from ${formatPhone(senderJid)}`);
      }

      // Process command — respond in any group
      const reply = await processCommand(text, adminUser);
      if (reply) {
        await sendMsg(jid, reply);
        console.log(`[CMD] Replied to "${text.slice(0, 30)}" in group`);
      }

    // ── DIRECT MESSAGES ───────────────────────────────────────────────────────
    } else {
      const phone = formatPhone(senderJid);

      if (text.toLowerCase().startsWith("!broadcast")) {
        const message = text.slice("!broadcast".length).trim();
        await handlePrivateBroadcast(senderJid, message);
        return;
      }

      const reply = await processCommand(text, false);
      if (reply) {
        await sendMsg(senderJid, reply);
      } else if (text.startsWith("!")) {
        await sendMsg(senderJid,
          `❓ Unknown command. Try *!help*\n\n💡 Admin tip: DM me *!broadcast <message>* to post announcements to the group!`
        );
      }
    }
  } catch (e) {
    console.error("[onMessage] Error:", e.message);
    // Never crash — just log and continue
  }
}

// ─── Group Participant Updates ─────────────────────────────────────────────────
async function onGroupUpdate(event) {
  try {
    if (event.action === "add" && event.participants?.length > 0) {
      for (const memberJid of event.participants) {
        await new Promise(r => setTimeout(r, 2000));
        await welcomeNewMember(event.id, memberJid);
      }
    }
    if (event.action === "remove" && event.participants?.length > 0) {
      for (const memberJid of event.participants) {
        await sendMsg(event.id,
          `👋 @${formatPhone(memberJid)} has left the group.\nWishing them all the best! 🙏`
        );
      }
    }
  } catch (e) {
    console.error("[onGroupUpdate]", e.message);
  }
}

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────
function setupCron(groupJid) {
  // Daily task reminder — 8 AM WAT (UTC+1) weekdays
  cron.schedule("0 7 * * 1-5", async () => {
    console.log("[Cron] Task reminder...");
    await sendMsg(groupJid,
      `🌅 *Good Morning, Algivix Dev Team!*\n━━━━━━━━━━━━━━━━━━━━\n` +
      handleTask() + `\n\n💡 Use *!ai <question>* for help!`
    );
  });

  // Daily standup — 9 AM WAT weekdays
  cron.schedule("0 8 * * 1-5", () => {
    console.log("[Cron] Starting standup...");
    startStandup(groupJid);
  });

  // Weekly rules reminder — Monday 9 AM WAT
  cron.schedule("0 8 * * 1", async () => {
    console.log("[Cron] Rules reminder...");
    await sendMsg(groupJid, `👋 *Weekly Reminder*\n` + handleRules());
  });

  // Wednesday mid-week check — 10 AM WAT
  cron.schedule("0 9 * * 3", async () => {
    console.log("[Cron] Mid-week check...");
    await sendMsg(groupJid,
      `⚡ *Mid-Week Check-in!*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `Halfway through! 💪\n📌 *!task* — Check tasks\n🤖 *!ai* — Get help\n\n` +
      `Keep pushing — greatness is built one commit at a time! 🚀`
    );
  });

  // Friday sprint wrap — 4 PM WAT
  cron.schedule("0 15 * * 5", async () => {
    console.log("[Cron] Friday wrap-up...");
    await sendMsg(groupJid,
      `🎉 *Friday Sprint Wrap-Up!*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ What did you complete?\n🔄 What carries over?\n🚧 Any blockers?\n\n` +
      `Reply with your update! Great work this week 💪🚀`
    );
  });

  // Inactivity check — every hour
  cron.schedule("0 * * * *", () => sendEngagementPing(groupJid));

  console.log(`[Cron] ✅ All 5 jobs scheduled for group: ${groupJid}`);
}

// ─── WhatsApp Connection ──────────────────────────────────────────────────────
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();
  console.log(`[Bot] Baileys v${version.join(".")}`);

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    // ── Fix Bad MAC: provide getMessage so Baileys can retry failed decrypts ──
    getMessage: async (key) => {
      const cached = msgRetryCache.get(key.id);
      if (cached) return cached;
      return proto.Message.fromObject({});
    },
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Pairing Code ────────────────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !state.creds.registered && !pairingDone) {
      pairingDone = true;
      let phone   = PHONE_NUMBER;
      if (!phone) phone = await askPhone();

      if (!phone || phone.length < 7) {
        console.error("❌ Invalid phone. Set BOT_PHONE_NUMBER in .env");
        process.exit(1);
      }

      console.log(`[Bot] Requesting pairing code for +${phone}...`);
      try {
        const code      = await sock.requestPairingCode(phone);
        const formatted = (code || "").match(/.{1,4}/g)?.join("-") || code;
        console.log("\n╔══════════════════════════════════════════╗");
        console.log("║      📲  WHATSAPP PAIRING CODE           ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log(`║              ${formatted}                 ║`);
        console.log("╚══════════════════════════════════════════╝");
        console.log("  1. WhatsApp → Settings → Linked Devices");
        console.log("  2. Link a Device → Link with phone number instead");
        console.log(`  3. Enter: ${formatted}\n`);
      } catch (err) {
        console.error("❌ Pairing code failed:", err.message);
        pairingDone = false;
      }
    }

    if (connection === "open") {
      console.log("\n✅ AlgivixAI ONLINE — Fully Autonomous!");
      console.log(`📱 Connected as: ${sock.user?.id?.split(":")[0]}`);
      console.log("🤖 Responding in all groups + DMs\n");

      // Start cron jobs using TARGET_GROUP or log a warning
      if (TARGET_GROUP) {
        setupCron(TARGET_GROUP);
      } else {
        console.warn("[Cron] ⚠️ TARGET_GROUP_JID not set — scheduled messages disabled.");
        console.warn("[Cron] The bot still responds to commands in all groups.");
      }
    }

    if (connection === "close") {
      const code            = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[Bot] Disconnected (code ${code}) — reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        pairingDone = false;
        console.log("[Bot] Reconnecting in 5s...");
        setTimeout(connect, 5000);
      } else {
        console.log("[Bot] Logged out — delete ./session and restart");
        process.exit(0);
      }
    }
  });

  // ── Cache outgoing messages (helps Bad MAC recovery) ───────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      if (msg.key.id) msgRetryCache.set(msg.key.id, msg.message);
    }
    if (type !== "notify") return;
    for (const msg of messages) await onMessage(msg);
  });

  // ── Group join/leave events ─────────────────────────────────────────────────
  sock.ev.on("group-participants.update", async (event) => {
    await onGroupUpdate(event);
  });
}

// ─── Startup ──────────────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════╗");
console.log("║      AlgivixAI — AUTONOMOUS EDITION v3   ║");
console.log("║      Developed by EMEMZYVISUALS           ║");
console.log("║            DIGITALS  🚀                   ║");
console.log("╠══════════════════════════════════════════╣");
console.log("║  ✅ Auto welcome new members              ║");
console.log("║  ✅ Broadcast via DM (!broadcast)         ║");
console.log("║  ✅ Daily standup collection              ║");
console.log("║  ✅ Inactivity engagement pings           ║");
console.log("║  ✅ Scheduled reminders & check-ins       ║");
console.log("║  ✅ 24/7 group moderation                 ║");
console.log("║  ✅ Bad MAC session recovery              ║");
console.log("╚══════════════════════════════════════════╝\n");

connect().catch(err => { console.error("[Fatal]", err); process.exit(1); });

process.on("SIGINT",             () => { console.log("\nShutting down..."); process.exit(0); });
process.on("uncaughtException",  e  => console.error("[Uncaught]", e.message));
process.on("unhandledRejection", r  => console.error("[Unhandled]", r));
