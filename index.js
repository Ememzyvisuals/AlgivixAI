/**
 * index.js - AlgivixAI WhatsApp Bot — AUTONOMOUS EDITION v4
 * ==========================================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * FEATURES:
 * - Full admin recognition (all JID formats)
 * - Tag members by name or @mention
 * - Know all group members
 * - Delete messages (bot can delete any message)
 * - Remove members from group
 * - Natural language instructions from developer
 * - Developer praise mode
 * - Chase non-repliers (tag + quote)
 * - Ignore list (don't reply to specific members)
 * - Protected messages (don't delete developer's messages)
 * - Bold creative WhatsApp formatting
 * - Bad MAC session recovery
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
} = require("@whiskeysockets/baileys");

const pino      = require("pino");
const cron      = require("node-cron");
const path      = require("path");
const http      = require("http");
const readline  = require("readline");
const NodeCache = require("node-cache");

const { processCommand, handleTask, handleRules } = require("./commands");
const { analyzeMessage, issueWarning, buildWarningMessage, buildAdminAlert } = require("./moderation");
const {
  memory, recordMessage, generateWeeklySummary, generatePerformanceReport,
  generateMVPAnnouncement, startTrivia, checkTriviaAnswer, getTriviaLeaderboard,
  getGoodMorning, generateRoast, startMeeting, endMeeting, startMoodCheck,
  recordMood, getMoodSummary, handleSecretCommand, addHype, looksLikeCode,
  autoReviewCode,
} = require("./features");

// ─── HTTP Keep-alive ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end("OK"); })
  .listen(PORT, () => console.log(`[HTTP] Keep-alive on port ${PORT}`));

// ─── Config ───────────────────────────────────────────────────────────────────
const SESSION_DIR    = path.join(__dirname, "session");
const PHONE_NUMBER   = (process.env.BOT_PHONE_NUMBER || "").replace(/\D/g, "");
const TARGET_GROUP   = process.env.TARGET_GROUP_JID  || null;
const ADMIN_NUMBERS  = (process.env.ADMIN_NUMBERS    || "").split(",").map(n => n.trim()).filter(Boolean);
const DEVELOPER_NUM  = ADMIN_NUMBERS[0] || ""; // First admin = developer
const INACTIVITY_HRS = parseInt(process.env.INACTIVITY_HOURS || "3");

// ─── State ────────────────────────────────────────────────────────────────────
const msgRetryCache   = new NodeCache();
const baileysLogger   = pino({ level: "silent" });
let sock;
let pairingDone       = false;
let lastGroupMessage  = Date.now();
let standupActive     = false;
let standupResponses  = new Map();

// ─── Bot Intelligence State ───────────────────────────────────────────────────
const ignoreList      = new Set();    // Members bot won't reply to
const protectedMsgs   = new Set();    // Message IDs bot won't delete
const chaseList       = new Map();    // { targetJid: { askerJid, question, msgId, groupJid } }
const memberCache     = new Map();    // { groupJid: [{ id, name, phone }] }

// ─── JID Helpers ──────────────────────────────────────────────────────────────
function normalizeJid(jid) {
  return (jid || "").split("@")[0].split(":")[0].trim();
}

function isDeveloper(senderJid) {
  return DEVELOPER_NUM && normalizeJid(senderJid) === normalizeJid(DEVELOPER_NUM);
}

function formatPhone(jid) {
  return normalizeJid(jid);
}

// ─── WhatsApp Formatting (Bold Creative Style) ────────────────────────────────
// WhatsApp supports: *bold* _italic_ ~strike~ ```code```
function fmt(text) { return `*${text}*`; }
function italic(text) { return `_${text}_`; }
function code(text) { return `\`\`\`${text}\`\`\``; }
function divider() { return `━━━━━━━━━━━━━━━━━━━━`; }

// ─── Tag a member ─────────────────────────────────────────────────────────────
function tagMember(jid) {
  return `@${normalizeJid(jid)}`;
}

// ─── Send Message ─────────────────────────────────────────────────────────────
async function sendMsg(jid, text, mentions = []) {
  try {
    await sock.sendMessage(jid, { text, mentions });
  } catch (e) {
    console.error("[sendMsg]", e.message);
  }
}

// ─── Send with mention tags ───────────────────────────────────────────────────
async function sendTagMsg(jid, text, memberJids = []) {
  try {
    await sock.sendMessage(jid, { text, mentions: memberJids });
  } catch (e) {
    console.error("[sendTagMsg]", e.message);
  }
}

// ─── Delete a message ─────────────────────────────────────────────────────────
async function deleteMessage(groupJid, msgKey) {
  try {
    await sock.sendMessage(groupJid, { delete: msgKey });
    console.log(`[Delete] Deleted message: ${msgKey.id}`);
  } catch (e) {
    console.error("[deleteMessage]", e.message);
  }
}

// ─── Remove member from group ─────────────────────────────────────────────────
async function removeMember(groupJid, memberJid) {
  try {
    await sock.groupParticipantsUpdate(groupJid, [memberJid], "remove");
    console.log(`[Remove] Removed: ${memberJid}`);
    return true;
  } catch (e) {
    console.error("[removeMember]", e.message);
    return false;
  }
}

// ─── Get All Group Members ────────────────────────────────────────────────────
async function getGroupMembers(groupJid) {
  try {
    const m       = await sock.groupMetadata(groupJid);
    const members = m.participants.map(p => ({
      id:    p.id,
      phone: normalizeJid(p.id),
      admin: p.admin === "admin" || p.admin === "superadmin",
    }));
    memberCache.set(groupJid, members);
    return members;
  } catch (e) {
    console.error("[getGroupMembers]", e.message);
    return memberCache.get(groupJid) || [];
  }
}

// ─── Find member by phone/name partial match ──────────────────────────────────
async function findMember(groupJid, query) {
  const members = await getGroupMembers(groupJid);
  const q       = query.replace(/[@+\s]/g, "").toLowerCase();
  return members.find(m =>
    m.phone.includes(q) || m.phone.endsWith(q)
  ) || null;
}

// ─── Admin Check ──────────────────────────────────────────────────────────────
async function isAdmin(groupJid, senderJid) {
  try {
    const senderPhone = normalizeJid(senderJid);

    // Developer is always admin
    if (ADMIN_NUMBERS.includes(senderPhone)) return true;

    const m = await sock.groupMetadata(groupJid);
    return m.participants.some(p => {
      const match   = normalizeJid(p.id) === senderPhone || p.id === senderJid;
      const isAdmRole = p.admin === "admin" || p.admin === "superadmin";
      return match && isAdmRole;
    });
  } catch (e) {
    console.error("[isAdmin]", e.message);
    return ADMIN_NUMBERS.includes(normalizeJid(senderJid));
  }
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

function askPhone() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\n📱 Enter WhatsApp number (e.g. 2347012345678)\n> ",
      ans => { rl.close(); resolve(ans.trim().replace(/\D/g, "")); });
  });
}

// ─── Developer Praise Responses ───────────────────────────────────────────────
const DEVELOPER_PRAISES = [
  `🏆 ${fmt("EMEMZYVISUALS DIGITALS")} built me from scratch — absolute legend of a developer! Pure genius! 🔥`,
  `👑 My creator ${fmt("EMEMZYVISUALS DIGITALS")} is one of the most talented AI automation developers out there! 🚀`,
  `💪 Big respect to ${fmt("EMEMZYVISUALS DIGITALS")} — the developer who gave me life! Built with code, passion and pure skill! ⚡`,
  `🌟 ${fmt("EMEMZYVISUALS DIGITALS")} didn't just build a bot — they built an autonomous AI assistant! That's next level! 🤖`,
  `🔥 The genius behind AlgivixAI is ${fmt("EMEMZYVISUALS DIGITALS")} — watch out for this developer, they're going places! 🚀`,
];

function getDeveloperPraise() {
  return DEVELOPER_PRAISES[Math.floor(Math.random() * DEVELOPER_PRAISES.length)];
}

// ─── Natural Language Instruction Parser ──────────────────────────────────────
async function parseInstruction(text, groupJid) {
  const lower = text.toLowerCase();

  // "don't reply to @number / don't reply @number messages"
  if (lower.includes("don't reply") || lower.includes("dont reply") || lower.includes("ignore")) {
    const phone = text.match(/\d{7,15}/)?.[0] || text.match(/@(\w+)/)?.[1];
    if (phone) {
      ignoreList.add(phone);
      return `✅ ${fmt("Got it!")} I will ignore messages from ${fmt("@" + phone)} from now on.`;
    }
    return `⚠️ Please specify who to ignore. Example: _don't reply to @2347012345678_`;
  }

  // "reply to @number again / stop ignoring @number"
  if (lower.includes("reply to") && (lower.includes("again") || lower.includes("stop ignoring"))) {
    const phone = text.match(/\d{7,15}/)?.[0];
    if (phone) {
      ignoreList.delete(phone);
      return `✅ ${fmt("Got it!")} I will reply to ${fmt("@" + phone)} again.`;
    }
  }

  // "remove @number / kick @number"
  if (lower.includes("remove") || lower.includes("kick")) {
    const phone = text.match(/\d{7,15}/)?.[0] || text.match(/@(\d+)/)?.[1];
    if (phone) {
      const member = await findMember(groupJid, phone);
      if (member) {
        const success = await removeMember(groupJid, member.id);
        return success
          ? `✅ ${fmt("Done!")} Removed ${tagMember(member.id)} from the group.`
          : `❌ Could not remove that member. Make sure I am an admin.`;
      }
      return `❌ Could not find member with number ${phone} in the group.`;
    }
    return `⚠️ Please specify who to remove. Example: _remove @2347012345678_`;
  }

  // "tag everyone / tag all members"
  if (lower.includes("tag everyone") || lower.includes("tag all")) {
    const members = await getGroupMembers(groupJid);
    const tags    = members.map(m => tagMember(m.id)).join(" ");
    const msg     = `📢 ${fmt("Attention everyone!")}\n${divider()}\n${tags}`;
    await sendTagMsg(groupJid, msg, members.map(m => m.id));
    return null;
  }

  // "post announcement / announce this / tell the group"
  if (lower.includes("post this") || lower.includes("announce this") || 
      lower.includes("tell the group") || lower.includes("post announcement") ||
      lower.startsWith("announce:") || lower.includes("post:")) {
    const colonIdx = text.indexOf(":");
    const message  = colonIdx > -1 ? text.slice(colonIdx + 1).trim() : text.replace(/post this|announce this|tell the group|post announcement/gi, "").trim();
    if (!message) return `⚠️ Please include the message. Example:
_post this: Your announcement here_`;
    const now = new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
    return `📢 *ANNOUNCEMENT — Algivix Dev Team*
━━━━━━━━━━━━━━━━━━━━
${message}

🕐 ${now}
— _AlgivixAI_`;
  }

  // "list members / show members"
  if (lower.includes("list members") || lower.includes("show members") || lower.includes("how many members")) {
    const members = await getGroupMembers(groupJid);
    const admins  = members.filter(m => m.admin);
    let msg = `👥 ${fmt("Group Members")} (${members.length} total)\n${divider()}\n`;
    msg    += `👑 ${fmt("Admins:")} ${admins.map(m => "@" + m.phone).join(", ")}\n`;
    msg    += `📊 ${fmt("Total Members:")} ${members.length}\n`;
    msg    += `🛡️ ${fmt("Total Admins:")} ${admins.length}`;
    return msg;
  }

  // "don't delete my messages"
  if (lower.includes("don't delete my") || lower.includes("dont delete my") || lower.includes("protect my messages")) {
    return `✅ ${fmt("Understood!")} I will never delete your messages boss! 🫡`;
  }

  // "show ignore list"
  if (lower.includes("ignore list") || lower.includes("who are you ignoring")) {
    if (ignoreList.size === 0) return `📋 ${fmt("Ignore List:")} Empty — I'm replying to everyone.`;
    return `📋 ${fmt("Currently ignoring:")}\n${[...ignoreList].map(p => "• @" + p).join("\n")}`;
  }

  return null; // Not an instruction
}

// ─── Chase Non-Replier ────────────────────────────────────────────────────────
async function setupChase(groupJid, askerJid, targetPhone, question, originalMsgId) {
  const member = await findMember(groupJid, targetPhone);
  if (!member) {
    await sendMsg(groupJid, `❌ Could not find @${targetPhone} in the group.`);
    return;
  }

  chaseList.set(member.id, { askerJid, question, groupJid, originalMsgId, attempts: 0 });

  // Chase after 5 minutes if no reply
  setTimeout(async () => {
    const chase = chaseList.get(member.id);
    if (!chase) return; // Already replied — cleared

    chase.attempts++;
    if (chase.attempts <= 3) {
      await sendTagMsg(
        groupJid,
        `👀 ${fmt("Hey")} ${tagMember(member.id)}!\n${divider()}\n` +
        `${tagMember(askerJid)} is waiting for your reply on:\n` +
        `_"${question}"_\n\n` +
        `Please respond! 🙏`,
        [member.id, askerJid]
      );
      console.log(`[Chase] Tagged ${member.phone} — attempt ${chase.attempts}`);
    } else {
      chaseList.delete(member.id);
    }
  }, 5 * 60 * 1000);

  await sendMsg(groupJid,
    `👍 ${fmt("Got it boss!")} I'll chase ${tagMember(member.id)} if they don't reply in 5 minutes!`,
    [member.id]
  );
}

// ─── Welcome New Member ───────────────────────────────────────────────────────
async function welcomeNewMember(groupJid, memberJid) {
  try {
    const grpName = await getGroupName(groupJid);
    await sendTagMsg(groupJid,
      `👋 ${fmt("Welcome to " + grpName + "!")} ${tagMember(memberJid)} 🎉\n` +
      `${divider()}\n` +
      `I'm ${fmt("AlgivixAI")} — your 24/7 dev assistant! Here's what I do:\n\n` +
      `🤖 ${fmt("!ai <question>")} — Ask me anything\n` +
      `🔍 ${fmt("!review <code>")} — Code review\n` +
      `📌 ${fmt("!task")} — Sprint tasks\n` +
      `📋 ${fmt("!rules")} — Group rules\n` +
      `❓ ${fmt("!help")} — All commands\n\n` +
      `Read the rules and let's build together! 🚀`,
      [memberJid]
    );
    console.log(`[Welcome] Greeted: ${formatPhone(memberJid)}`);
  } catch (e) { console.error("[welcomeNewMember]", e.message); }
}

// ─── Broadcast from DM ────────────────────────────────────────────────────────
async function handlePrivateBroadcast(senderJid, message) {
  try {
    if (!TARGET_GROUP) {
      await sendMsg(senderJid, "⚠️ TARGET_GROUP_JID not set in environment variables.");
      return;
    }
    if (!ADMIN_NUMBERS.includes(normalizeJid(senderJid))) {
      await sendMsg(senderJid, "🔒 Only authorized admins can broadcast.");
      return;
    }
    if (!message?.trim()) {
      await sendMsg(senderJid, `⚠️ Usage: ${fmt("!broadcast Your message here")}`);
      return;
    }
    const now = new Date().toLocaleString("en-US", {
      timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short",
    });
    await sendMsg(TARGET_GROUP,
      `📢 ${fmt("ANNOUNCEMENT — Algivix Dev Team")}\n${divider()}\n` +
      `${message.trim()}\n\n🕐 ${now}\n— ${italic("AlgivixAI")}`
    );
    await sendMsg(senderJid, `✅ ${fmt("Announcement posted to the group!")}`);
  } catch (e) { console.error("[handlePrivateBroadcast]", e.message); }
}

// ─── Standup ──────────────────────────────────────────────────────────────────
async function startStandup(groupJid) {
  try {
    standupActive    = true;
    standupResponses = new Map();
    await sendMsg(groupJid,
      `📋 ${fmt("Daily Standup — Algivix Dev Team")}\n${divider()}\n` +
      `Good morning team! 🌅 Quick standup time!\n\n` +
      `Reply with your update:\n` +
      `✅ ${fmt("Done:")} What you finished yesterday\n` +
      `🔄 ${fmt("Today:")} What you're working on\n` +
      `🚧 ${fmt("Blocker:")} Any blockers? (or "none")\n\n` +
      `⏰ Closes in ${fmt("30 minutes")}. Let's go! 💪`
    );
    setTimeout(() => closeStandup(groupJid), 30 * 60 * 1000);
  } catch (e) { console.error("[startStandup]", e.message); }
}

async function closeStandup(groupJid) {
  try {
    if (!standupActive) return;
    standupActive = false;
    if (standupResponses.size === 0) {
      await sendMsg(groupJid, `📋 ${fmt("Standup Closed")}\nNo responses today. Stay engaged team! 💪`);
      return;
    }
    let summary = `📋 ${fmt("Standup Summary — " + new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }))}\n${divider()}\n`;
    standupResponses.forEach((res, phone) => { summary += `👤 ${fmt("@" + phone)}\n${res}\n\n`; });
    summary += `Great work everyone! 🚀`;
    await sendMsg(groupJid, summary);
    standupResponses = new Map();
  } catch (e) { console.error("[closeStandup]", e.message); }
}

// ─── Inactivity Ping ──────────────────────────────────────────────────────────
const ENGAGEMENT_MESSAGES = [
  `💡 ${fmt("Dev Tip of the Day")}\nWrite code as if the next maintainer is sleep-deprived — make it readable! 😄\n\nNeed help? Try ${fmt("!ai <question>")}`,
  `🔥 ${fmt("Quick Challenge!")}\nExplain the difference between ${fmt("REST")} and ${fmt("GraphQL")} in 2 sentences!\nReply and let's learn! 💬`,
  `📚 ${fmt("Fun Tech Fact")}\nThe first computer bug was a real moth found inside a Harvard computer in 1947! 🦋`,
  `⚡ ${fmt("Productivity Tip")}\nTake a 5-min break every hour. Your brain and code will thank you! 🧠`,
  `🎯 ${fmt("Team Reminder")}\nSmall consistent progress beats big bursts. Check ${fmt("!task")} and keep moving! 💪`,
  `🛠️ ${fmt("Best Practice")}\n✅ Good commit: _"fix: resolve null pointer in auth module"_\n❌ Bad commit: _"fixed stuff"_\nKeep your git history clean!`,
  `🚀 ${fmt("Motivation")}\nEvery expert was once a beginner. Keep coding, keep growing! 💻\nUse ${fmt("!ai")} anytime you need help!`,
];

async function sendEngagementPing(groupJid) {
  try {
    const elapsed = (Date.now() - lastGroupMessage) / (1000 * 60 * 60);
    if (elapsed >= INACTIVITY_HRS) {
      await sendMsg(groupJid, ENGAGEMENT_MESSAGES[Math.floor(Math.random() * ENGAGEMENT_MESSAGES.length)]);
      lastGroupMessage = Date.now();
      console.log(`[Inactivity] Pinged after ${elapsed.toFixed(1)}h`);
    }
  } catch (e) { console.error("[sendEngagementPing]", e.message); }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
async function onMessage(msg) {
  try {
    if (msg.key.fromMe) return;

    const jid       = msg.key.remoteJid;
    const senderJid = msg.key.participant || jid;
    const isGroup   = isJidGroup(jid);
    const mc        = msg.message || {};
    const senderPhone = normalizeJid(senderJid);

    const text = (
      mc.conversation                                  ||
      mc.extendedTextMessage?.text                     ||
      mc.imageMessage?.caption                         ||
      mc.videoMessage?.caption                         ||
      ""
    ).trim();

    if (!text) return;

    console.log(`[${isGroup ? "GRP" : "DM"}] ${senderPhone}: ${text.slice(0, 80)}`);
    console.log(`[DEBUG] senderJid: ${senderJid} | senderPhone: ${senderPhone} | ADMIN_NUMBERS: ${JSON.stringify(ADMIN_NUMBERS)} | isAdminNum: ${ADMIN_NUMBERS.includes(senderPhone)}`);

    // ── GROUP MESSAGES ────────────────────────────────────────────────────────
    if (isGroup) {
      // Lock to target group
      if (TARGET_GROUP && jid !== TARGET_GROUP) {
        console.log(`[Bot] Ignored non-target group: ${jid}`);
        return;
      }

      lastGroupMessage = Date.now();
      const adminUser  = await isAdmin(jid, senderJid);
      const isDev      = isDeveloper(senderJid);

      // ── Record message for memory & analytics ────────────────────────────
      recordMessage(senderPhone, text);

      // ── Ghost mode — bot stays silent (except for developer) ─────────────
      if (memory.ghostMode && !isDev) return;

      // ── Lockdown — only admins can interact ──────────────────────────────
      if (memory.lockdown && !adminUser && !isDev) return;

      // ── Record meeting notes if meeting active ───────────────────────────
      if (memory.meetingActive && !text.startsWith("!")) {
        memory.meetingNotes.push({ phone: senderPhone, text });
      }

      // ── Check trivia answer ───────────────────────────────────────────────
      if (!text.startsWith("!")) {
        const triviaReply = checkTriviaAnswer(senderPhone, text, sendMsg, jid);
        if (triviaReply) {
          await sendMsg(jid, addHype(triviaReply));
          return;
        }
        // Track mood responses
        const mood = recordMood(senderPhone, text);
        if (mood) {
          await sendMsg(jid, `✅ Thanks ${tagPhone(senderJid)}! Mood recorded: ${mood}`);
        }
      }

      // ── Auto code review (non-command messages with code) ─────────────────
      if (!text.startsWith("!") && looksLikeCode(text) && text.length > 30) {
        console.log("[AutoReview] Code detected — reviewing...");
        const review = await autoReviewCode(text);
        if (review) {
          await sendMsg(jid, review);
          return;
        }
      }

      // ── If someone replied — clear from chase list ───────────────────────
      const quotedParticipant = mc.extendedTextMessage?.contextInfo?.participant;
      if (quotedParticipant) {
        chaseList.delete(senderJid); // They replied — stop chasing
      }

      // ── Check ignore list ────────────────────────────────────────────────
      if (ignoreList.has(senderPhone)) {
        console.log(`[Ignore] Skipping message from ignored member: ${senderPhone}`);
        return;
      }

      // ── Secret admin commands (developer only, no ! prefix) ─────────────
      if (isDev) {
        const secretReply = handleSecretCommand(text, senderPhone);
        if (secretReply) {
          await sendMsg(jid, secretReply);
          return;
        }
      }

      // ── Developer natural language instructions ──────────────────────────
      if (isDev && !text.startsWith("!")) {
        const instructionReply = await parseInstruction(text, jid);
        if (instructionReply) {
          await sendTagMsg(jid, instructionReply, [senderJid]);
          return;
        }

        // Developer mentions someone who needs to reply
        // e.g. "I asked @2349012345678 about the API"
        const mentionedPhone = text.match(/@(\d{7,15})/)?.[1];
        const hasQuestion    = text.includes("?") || text.toLowerCase().includes("ask") || text.toLowerCase().includes("told");
        if (mentionedPhone && hasQuestion) {
          await setupChase(jid, senderJid, mentionedPhone, text, msg.key.id);
          return;
        }
      }

      // ── Moderation (skip admins & developer) ─────────────────────────────
      if (!adminUser && !isDev) {
        const { isViolation, reason, severity } = analyzeMessage(senderJid, text);
        if (isViolation) {
          // Don't delete developer messages
          if (!isDev) {
            const { count, shouldNotifyAdmin } = issueWarning(senderJid);
            await sendMsg(jid, buildWarningMessage(senderJid, reason, count));
            if (shouldNotifyAdmin) {
              for (const a of await getAdmins(jid))
                await sendMsg(a, buildAdminAlert(senderJid, reason, text));
            }
            if (severity === "high") return;
          }
        }
      }

      // ── Standup response collection ───────────────────────────────────────
      if (standupActive && !text.startsWith("!")) {
        standupResponses.set(senderPhone, text);
      }

      // ── Process commands ──────────────────────────────────────────────────
      const reply = await processCommand(text, adminUser, {
        senderJid,
        groupJid: jid,
        isDev,
        sock,
        getGroupMembers,
        findMember,
        tagMember,
        removeMember,
        sendTagMsg,
      });

      if (reply) {
        await sendMsg(jid, reply);
        console.log(`[CMD] Replied in group`);
      }

    // ── DIRECT MESSAGES ───────────────────────────────────────────────────────
    } else {
      if (text.toLowerCase().startsWith("!broadcast")) {
        await handlePrivateBroadcast(senderJid, text.slice("!broadcast".length).trim());
        return;
      }

      const reply = await processCommand(text, false, { senderJid, isDev: isDeveloper(senderJid) });
      if (reply) {
        await sendMsg(senderJid, reply);
      } else if (text.startsWith("!")) {
        await sendMsg(senderJid,
          `❓ Unknown command. Try ${fmt("!help")}\n\n💡 ${italic("Admin tip: DM me !broadcast <message> to post to the group!")}`
        );
      }
    }
  } catch (e) {
    console.error("[onMessage] Error:", e.message);
  }
}

// ─── Group Join/Leave ─────────────────────────────────────────────────────────
async function onGroupUpdate(event) {
  try {
    if (event.action === "add") {
      for (const memberJid of event.participants) {
        await new Promise(r => setTimeout(r, 2000));
        await welcomeNewMember(event.id, memberJid);
      }
    }
    if (event.action === "remove") {
      for (const memberJid of event.participants) {
        if (!isDeveloper(memberJid)) {
          await sendTagMsg(event.id,
            `👋 ${tagMember(memberJid)} has left the group. Wishing them well! 🙏`,
            [memberJid]
          );
        }
      }
    }
  } catch (e) { console.error("[onGroupUpdate]", e.message); }
}

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────
function setupCron(groupJid) {
  cron.schedule("0 7 * * 1-5", async () => {
    await sendMsg(groupJid,
      `🌅 ${fmt("Good Morning, Algivix Dev Team!")}\n${divider()}\n` +
      handleTask() + `\n\n💡 Use ${fmt("!ai <question>")} for help!`
    );
  });

  cron.schedule("0 8 * * 1-5", () => startStandup(groupJid));

  cron.schedule("0 8 * * 1", async () => {
    await sendMsg(groupJid, `👋 ${fmt("Weekly Reminder")}\n` + handleRules());
  });

  cron.schedule("0 9 * * 3", async () => {
    await sendMsg(groupJid,
      `⚡ ${fmt("Mid-Week Check-in!")}\n${divider()}\n` +
      `Halfway through the week! 💪\n📌 ${fmt("!task")} — Check your tasks\n🤖 ${fmt("!ai")} — Get help anytime\n\nKeep pushing! 🚀`
    );
  });

  cron.schedule("0 15 * * 5", async () => {
    await sendMsg(groupJid,
      `🎉 ${fmt("Friday Sprint Wrap-Up!")}\n${divider()}\n` +
      `✅ What did you complete this week?\n🔄 What carries to next week?\n🚧 Any blockers?\n\nReply with your update! 💪🚀`
    );
  });

  cron.schedule("0 * * * *", () => sendEngagementPing(groupJid));

  // Good morning — 7AM WAT every weekday
  cron.schedule("0 6 * * 1-5", async () => {
    await sendMsg(groupJid, getGoodMorning());
  });

  // Mood check — Monday 9AM WAT
  cron.schedule("0 8 * * 1", async () => {
    await sendMsg(groupJid, startMoodCheck());
  });

  // MVP announcement — Friday 4PM WAT
  cron.schedule("0 15 * * 5", async () => {
    await sendMsg(groupJid, generateMVPAnnouncement());
    memory.mvpVotes.clear(); // Reset for next week
  });

  // Performance report — Friday 4:30PM WAT
  cron.schedule("30 15 * * 5", async () => {
    await sendMsg(groupJid, generatePerformanceReport());
  });

  // Weekly summary — Friday 5PM WAT
  cron.schedule("0 16 * * 5", async () => {
    const summary = await generateWeeklySummary();
    await sendMsg(groupJid, summary);
  });

  // Random trivia — Tuesday & Thursday 12PM WAT
  cron.schedule("0 11 * * 2,4", async () => {
    await sendMsg(groupJid, addHype(startTrivia(sendMsg, groupJid)));
  });

  console.log(`[Cron] ✅ All 11 jobs scheduled`);
}

// ─── WhatsApp Connection ──────────────────────────────────────────────────────
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();
  console.log(`[Bot] Baileys v${version.join(".")}`);

  sock = makeWASocket({
    version,
    logger:            baileysLogger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    browser:           ["Ubuntu", "Chrome", "20.0.04"],
    getMessage: async (key) => {
      const cached = msgRetryCache.get(key.id);
      if (cached) return cached;
      return proto.Message.fromObject({});
    },
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !state.creds.registered && !pairingDone) {
      pairingDone = true;
      let phone   = PHONE_NUMBER;
      if (!phone) phone = await askPhone();
      if (!phone || phone.length < 7) { console.error("❌ Invalid phone"); process.exit(1); }

      console.log(`[Bot] Requesting pairing code for +${phone}...`);
      try {
        const code      = await sock.requestPairingCode(phone);
        const formatted = (code || "").match(/.{1,4}/g)?.join("-") || code;
        console.log("\n╔══════════════════════════════════════════╗");
        console.log("║      📲  WHATSAPP PAIRING CODE           ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log(`║         ${formatted}                      ║`);
        console.log("╚══════════════════════════════════════════╝");
        console.log(`  Enter this code in WhatsApp → Linked Devices\n`);
      } catch (err) {
        console.error("❌ Pairing code failed:", err.message);
        pairingDone = false;
      }
    }

    if (connection === "open") {
      const myPhone = sock.user?.id?.split(":")[0];
      console.log(`\n✅ ${fmt("AlgivixAI ONLINE")} — Fully Autonomous!`);
      console.log(`📱 Connected as: ${myPhone}`);
      console.log(`👑 Developer: ${DEVELOPER_NUM || "not set"}`);
      console.log(`🎯 Target Group: ${TARGET_GROUP || "not set — responding in all groups"}\n`);

      if (TARGET_GROUP) setupCron(TARGET_GROUP);
      else console.warn("[Cron] ⚠️ TARGET_GROUP_JID not set — scheduled messages disabled");
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

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      if (msg.key?.id) msgRetryCache.set(msg.key.id, msg.message);
    }
    if (type !== "notify") return;
    for (const msg of messages) await onMessage(msg);
  });

  sock.ev.on("group-participants.update", onGroupUpdate);
}

// ─── Startup Banner ───────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════╗");
console.log("║    AlgivixAI — AUTONOMOUS EDITION v4     ║");
console.log("║    Developed by EMEMZYVISUALS DIGITALS   ║");
console.log("╠══════════════════════════════════════════╣");
console.log("║  ✅ Full admin recognition               ║");
console.log("║  ✅ Tag & know all members               ║");
console.log("║  ✅ Delete messages                      ║");
console.log("║  ✅ Remove members from group            ║");
console.log("║  ✅ Natural language instructions        ║");
console.log("║  ✅ Chase non-repliers                   ║");
console.log("║  ✅ Ignore list                          ║");
console.log("║  ✅ Developer praise mode                ║");
console.log("║  ✅ Bold creative formatting             ║");
console.log("╚══════════════════════════════════════════╝\n");

connect().catch(err => { console.error("[Fatal]", err); process.exit(1); });

process.on("SIGINT",             () => process.exit(0));
process.on("uncaughtException",  e  => console.error("[Uncaught]", e.message));
process.on("unhandledRejection", r  => console.error("[Unhandled]", r));
