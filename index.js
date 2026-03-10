/**
 * index.js - AlgivixAI WhatsApp Bot — FULLY AUTONOMOUS Edition
 * =============================================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * Autonomous Features (zero human input needed):
 *  ✅ Auto welcome new members
 *  ✅ Auto announcements via private DM to bot
 *  ✅ Daily standup prompt + collection
 *  ✅ Inactivity detection + engagement ping
 *  ✅ Scheduled task reminders (weekday mornings)
 *  ✅ Weekly rules reminder (Monday)
 *  ✅ Friday sprint check-in
 *  ✅ 24/7 group moderation (spam, flood, bad content)
 *  ✅ Auto-reconnect on disconnect
 */

require("dotenv").config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const pino     = require("pino");
const cron     = require("node-cron");
const path     = require("path");
const http     = require("http");
const readline = require("readline");

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
  res.end("AlgivixAI is running 24/7 ✅\nDeveloped by EMEMZYVISUALS DIGITALS");
}).listen(PORT, () => console.log(`[HTTP] Keep-alive server on port ${PORT}`));

// ─── Config ───────────────────────────────────────────────────────────────────
const SESSION_DIR    = path.join(__dirname, "session");
const PHONE_NUMBER   = (process.env.BOT_PHONE_NUMBER || "").replace(/\D/g, "");
const TARGET_GROUP   = process.env.TARGET_GROUP_JID  || null;
const ADMIN_NUMBERS  = (process.env.ADMIN_NUMBERS    || "").split(",").filter(Boolean);
const INACTIVITY_HRS = parseInt(process.env.INACTIVITY_HOURS || "6"); // hours before ping

// ─── State Tracking ───────────────────────────────────────────────────────────
const baileysLogger  = pino({ level: "silent" });
let sock;
let pairingDone      = false;
let lastGroupMessage = Date.now(); // Track last message time for inactivity detection
let standupResponses = new Map();  // { phoneNumber: response } for daily standups
let standupActive    = false;      // Is standup collection currently open?

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

async function getGroupMembers(groupJid) {
  try {
    const m = await sock.groupMetadata(groupJid);
    return m.participants.map(p => p.id);
  } catch { return []; }
}

async function getGroupName(groupJid) {
  try {
    const m = await sock.groupMetadata(groupJid);
    return m.subject || "the group";
  } catch { return "the group"; }
}

function formatPhone(jid) {
  return jid.split("@")[0];
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
  const name    = formatPhone(memberJid);
  const grpName = await getGroupName(groupJid);

  const welcomeMsg =
    `👋 Welcome to *${grpName}*, @${name}! 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `We're glad to have you here! I'm *AlgivixAI*, your 24/7 dev assistant.\n\n` +
    `Here's how I can help you:\n` +
    `🤖 *!ai <question>* — Ask me anything dev-related\n` +
    `🔍 *!review <code>* — Get your code reviewed\n` +
    `📌 *!task* — See current sprint tasks\n` +
    `📋 *!rules* — Read the group rules\n` +
    `❓ *!help* — See all commands\n\n` +
    `📖 Please read the rules to keep our community great.\n` +
    `Let's build something amazing together! 💻🚀`;

  await sendMsg(groupJid, welcomeMsg);
  console.log(`[Welcome] Greeted new member: ${name}`);
}

// ─── Private Broadcast (DM → Group Announcement) ─────────────────────────────
// Admins can DM the bot: !broadcast Your message here
// Bot will post it as an official announcement in the group
async function handlePrivateBroadcast(senderJid, message) {
  if (!TARGET_GROUP) {
    await sendMsg(senderJid, "⚠️ No group configured. Set TARGET_GROUP_JID in environment variables.");
    return;
  }

  const phone   = formatPhone(senderJid);
  const isAdm   = ADMIN_NUMBERS.includes(phone);

  if (!isAdm) {
    await sendMsg(senderJid, "🔒 Only authorized admins can broadcast to the group.");
    return;
  }

  if (!message || message.trim().length === 0) {
    await sendMsg(senderJid, "⚠️ Usage: *!broadcast Your announcement message here*");
    return;
  }

  const now = new Date().toLocaleString("en-US", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const announcement =
    `📢 *ANNOUNCEMENT — Algivix Dev Team*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${message.trim()}\n\n` +
    `🕐 ${now}\n` +
    `— AlgivixAI`;

  await sendMsg(TARGET_GROUP, announcement);
  await sendMsg(senderJid, "✅ Announcement posted to the group successfully!");
  console.log(`[Broadcast] Admin ${phone} posted announcement`);
}

// ─── Standup Collection ───────────────────────────────────────────────────────
async function startStandup() {
  if (!TARGET_GROUP) return;
  standupActive    = true;
  standupResponses = new Map();

  await sendMsg(TARGET_GROUP,
    `📋 *Daily Standup — Algivix Dev Team*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Good morning team! 🌅 Time for our quick daily standup.\n\n` +
    `Please reply with your update in this format:\n\n` +
    `✅ *Done:* What you completed yesterday\n` +
    `🔄 *Today:* What you're working on today\n` +
    `🚧 *Blocker:* Any blockers? (or "none")\n\n` +
    `⏰ Responses close in *30 minutes*. Let's go! 💪`
  );

  // Close standup and post summary after 30 minutes
  setTimeout(closeStandup, 30 * 60 * 1000);
  console.log("[Standup] Started — collecting responses for 30 minutes");
}

async function closeStandup() {
  if (!TARGET_GROUP || !standupActive) return;
  standupActive = false;

  if (standupResponses.size === 0) {
    await sendMsg(TARGET_GROUP,
      `📋 *Standup Summary*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `No responses received today. Let's stay engaged team! 💪`
    );
    return;
  }

  let summary = `📋 *Standup Summary — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}*\n`;
  summary    += `━━━━━━━━━━━━━━━━━━━━\n`;
  summary    += `${standupResponses.size} member(s) responded:\n\n`;

  standupResponses.forEach((response, phone) => {
    summary += `👤 *@${phone}*\n${response}\n\n`;
  });

  summary += `Great work everyone! Let's crush today's tasks! 🚀`;
  await sendMsg(TARGET_GROUP, summary);
  standupResponses = new Map();
  console.log(`[Standup] Closed — ${standupResponses.size} responses summarized`);
}

// ─── Inactivity Engagement Ping ───────────────────────────────────────────────
const ENGAGEMENT_MESSAGES = [
  `💡 *Dev Tip of the Day*\nAlways write code as if the person maintaining it is a violent psychopath who knows where you live. — Keep it clean! 😄\n\nUse *!ai <question>* if you need help with anything!`,
  `🔥 *Quick Challenge!*\nCan anyone explain the difference between *REST* and *GraphQL* in 2 sentences?\n\nReply and let's learn together! 💬`,
  `📚 *Learning Moment*\nDid you know? The first computer bug was an actual bug — a moth found in a Harvard computer in 1947! 🦋\n\nUse *!ai <topic>* to learn something new today!`,
  `⚡ *Productivity Tip*\nTake a 5-minute break every hour. Your brain — and your code — will thank you! 🧠\n\nStuck on something? Try *!ai <your problem>*`,
  `🎯 *Team Reminder*\nGreat teams ship regularly. Small, consistent progress beats big bursts.\n\nCheck your tasks with *!task* and keep moving forward! 💪`,
  `🛠️ *Best Practice Reminder*\nAlways commit your work with clear, descriptive messages.\n\nBad: "fixed stuff"\nGood: "fix: resolve null pointer in user auth module"\n\nKeep your git history clean! ✅`,
];

async function sendEngagementPing() {
  if (!TARGET_GROUP) return;
  const now     = Date.now();
  const elapsed = (now - lastGroupMessage) / (1000 * 60 * 60); // hours

  if (elapsed >= INACTIVITY_HRS) {
    const msg = ENGAGEMENT_MESSAGES[Math.floor(Math.random() * ENGAGEMENT_MESSAGES.length)];
    await sendMsg(TARGET_GROUP, msg);
    lastGroupMessage = now; // Reset timer
    console.log(`[Inactivity] Group was quiet for ${elapsed.toFixed(1)}h — sent engagement ping`);
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
    const text      = (
      mc.conversation ||
      mc.extendedTextMessage?.text ||
      mc.imageMessage?.caption || ""
    ).trim();

    if (!text) return;

    console.log(`[${isGroup ? "GRP" : "DM"}] ${formatPhone(senderJid)}: ${text.slice(0, 80)}`);

    // ── Group messages ────────────────────────────────────────────────────────
    if (isGroup && jid === TARGET_GROUP) {
      lastGroupMessage = Date.now(); // Reset inactivity timer on any message

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

      // Collect standup response if standup is active
      if (standupActive && !text.startsWith("!")) {
        const phone = formatPhone(senderJid);
        standupResponses.set(phone, text);
        console.log(`[Standup] Response from ${phone}`);
        // Don't return — still process commands if any
      }

      // Process commands
      const reply = await processCommand(text, adminUser);
      if (reply) await sendMsg(jid, reply);

    // ── Direct Messages ───────────────────────────────────────────────────────
    } else if (!isGroup) {
      const phone = formatPhone(senderJid);

      // !broadcast command via DM (admin only)
      if (text.toLowerCase().startsWith("!broadcast ")) {
        const message = text.slice("!broadcast ".length).trim();
        await handlePrivateBroadcast(senderJid, message);
        return;
      }

      // !broadcast with no message
      if (text.toLowerCase() === "!broadcast") {
        await sendMsg(senderJid,
          `📢 *Broadcast Usage*\n` +
          `Send: *!broadcast Your message here*\n` +
          `The bot will post it as an announcement in the group.\n\n` +
          `Only authorized admin numbers can use this.`
        );
        return;
      }

      // Regular DM commands
      const reply = await processCommand(text, false);
      if (reply) await sendMsg(senderJid, reply);
      else if (text.startsWith("!")) {
        await sendMsg(senderJid,
          `❓ Unknown command. Try *!help*\n\n` +
          `💡 *Admin tip:* Use *!broadcast <message>* to post announcements to the group from here!`
        );
      }
    }
  } catch (e) {
    console.error("[onMessage]", e.message);
  }
}

// ─── Group Events (welcome, member changes) ───────────────────────────────────
async function onGroupUpdate(events) {
  for (const event of events) {
    if (!event.id || event.id !== TARGET_GROUP) continue;

    // New members joining
    if (event.action === "add" && event.participants?.length > 0) {
      for (const memberJid of event.participants) {
        // Small delay so the message appears after system notice
        await new Promise(r => setTimeout(r, 2000));
        await welcomeNewMember(event.id, memberJid);
      }
    }

    // Member removed/left
    if (event.action === "remove" && event.participants?.length > 0) {
      for (const memberJid of event.participants) {
        const name = formatPhone(memberJid);
        await sendMsg(TARGET_GROUP,
          `👋 @${name} has left the group.\nWishing them all the best! 🙏\n\nRemember team — *!task* to stay on track!`
        );
      }
    }
  }
}

// ─── Scheduled Cron Jobs ──────────────────────────────────────────────────────
function setupCron() {
  if (!TARGET_GROUP) {
    console.warn("[Cron] No TARGET_GROUP_JID set — all scheduled messages disabled");
    return;
  }

  // Daily standup — 9:00 AM WAT (UTC+1), Mon–Fri
  cron.schedule("0 8 * * 1-5", () => {
    console.log("[Cron] Starting daily standup...");
    startStandup();
  });

  // Daily task reminder — 8:00 AM WAT, Mon–Fri
  cron.schedule("0 7 * * 1-5", async () => {
    console.log("[Cron] Sending task reminder...");
    await sendMsg(TARGET_GROUP,
      `🌅 *Good Morning, Algivix Dev Team!*\n━━━━━━━━━━━━━━━━━━━━\n` +
      handleTask() +
      `\n\n💡 Use *!ai <question>* if you need help with any task!`
    );
  });

  // Weekly rules reminder — Monday 9:00 AM WAT
  cron.schedule("0 8 * * 1", async () => {
    console.log("[Cron] Sending rules reminder...");
    await sendMsg(TARGET_GROUP,
      `👋 *Weekly Community Reminder*\nLet's keep Algivix Dev Team professional!\n\n` +
      handleRules()
    );
  });

  // Friday sprint wrap-up — 4:00 PM WAT
  cron.schedule("0 15 * * 5", async () => {
    console.log("[Cron] Sending Friday check-in...");
    await sendMsg(TARGET_GROUP,
      `🎉 *It's Friday, Team!*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `Let's wrap up the sprint:\n\n` +
      `✅ What did you complete this week?\n` +
      `🔄 What's carrying over to next week?\n` +
      `🚧 Any blockers to resolve over the weekend?\n\n` +
      `Reply with your update! Great work this week 💪🚀`
    );
  });

  // Wednesday mid-week motivation — 10:00 AM WAT
  cron.schedule("0 9 * * 3", async () => {
    console.log("[Cron] Sending mid-week motivation...");
    await sendMsg(TARGET_GROUP,
      `⚡ *Mid-Week Check-in — Algivix Dev Team!*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `We're halfway through the week! 💪\n\n` +
      `📌 Check your tasks: *!task*\n` +
      `🤖 Need help? *!ai <your question>*\n` +
      `🔍 Code stuck? *!review <your code>*\n\n` +
      `Keep pushing — greatness is built one commit at a time! 🚀`
    );
  });

  // Inactivity check — every hour
  cron.schedule("0 * * * *", () => {
    sendEngagementPing();
  });

  console.log("[Cron] ✅ All 5 scheduled jobs active");
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
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Pairing code ────────────────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !state.creds.registered && !pairingDone) {
      pairingDone = true;
      let phone   = PHONE_NUMBER;
      if (!phone) phone = await askPhone();

      if (!phone || phone.length < 7) {
        console.error("❌ Invalid phone number. Set BOT_PHONE_NUMBER in .env");
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
        console.log("  1. Open WhatsApp → Settings");
        console.log("  2. Linked Devices → Link a Device");
        console.log("  3. Tap 'Link with phone number instead'");
        console.log(`  4. Enter code: ${formatted}\n`);
      } catch (err) {
        console.error("❌ Pairing code failed:", err.message);
        pairingDone = false;
      }
    }

    if (connection === "open") {
      console.log("\n✅ AlgivixAI is ONLINE and fully autonomous!");
      console.log(`📱 Connected as: ${sock.user?.id?.split(":")[0]}`);
      console.log("🤖 All autonomous features active 24/7\n");
      setupCron();
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

  // ── Incoming messages ───────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) await onMessage(msg);
  });

  // ── Group participant updates (join/leave) ──────────────────────────────────
  sock.ev.on("group-participants.update", async (event) => {
    await onGroupUpdate([event]);
  });
}

// ─── Startup Banner ───────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════╗");
console.log("║      AlgivixAI — AUTONOMOUS EDITION      ║");
console.log("║      Developed by EMEMZYVISUALS          ║");
console.log("║            DIGITALS  🚀                  ║");
console.log("╠══════════════════════════════════════════╣");
console.log("║  ✅ Auto welcome new members             ║");
console.log("║  ✅ Broadcast via DM (!broadcast)        ║");
console.log("║  ✅ Daily standup collection             ║");
console.log("║  ✅ Inactivity engagement pings          ║");
console.log("║  ✅ Scheduled reminders & check-ins      ║");
console.log("║  ✅ 24/7 group moderation                ║");
console.log("╚══════════════════════════════════════════╝\n");

connect().catch(err => { console.error("[Fatal]", err); process.exit(1); });

process.on("SIGINT",             () => { console.log("\n[Bot] Shutting down..."); process.exit(0); });
process.on("uncaughtException",  e  => console.error("[Uncaught]", e.message));
process.on("unhandledRejection", r  => console.error("[Unhandled]", r));
