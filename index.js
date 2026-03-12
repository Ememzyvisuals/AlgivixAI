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
  askGroqDirect, analyzeImageWithClaude,
  getPersonalityPrompt, getGroupReplyPrompt,
  detectQuestionOrProblem, answerWithContext,
  detectDrama, getDramaResponse,
  detectSnitch, checkForDisrespect,
  addMemberToGroup,
  updateMemberActivity, shouldGreetReturn, markGreeted,
  generateReturnGreeting, getInactiveMembers,
  getGreeting, getTechStory, getDevQuote,
  getSpecialDayMessage, getRandomHumanMessage,
  getMorningBriefing, getStatusContent,
  HYPE_PREFIXES,
} = require("./personality");

const { memoryManager } = require("./memory");
const { getFileType, extractTextFromBuffer, analyzeFileContent, buildFileResponse } = require("./filereader");
const { detectIntent, generateContextMessage, getGList } = require("./nlp");
const {
  buildTaskMessage, getDeadlineReminders, reviewSubmissions,
  handleSubmit, handleTaskDMCommand, executeDMAction, getTaskSetupPrompt,
  daysUntil, loadTasks,
} = require("./taskmanager");
// ─── Dev memory (in-process) ─────────────────────────────────────────────────
const devMemory = { mood: null, lastImage: null, conversations: [] };
function rememberDev(k, v) { devMemory[k] = v; }
function recordDMConversation(role, text) {
  devMemory.conversations.push({ role, content: text, time: Date.now() });
  if (devMemory.conversations.length > 60) devMemory.conversations.shift();
  memoryManager.recordDevMessage(role, text);
}

const {
  memory, recordMessage, generateWeeklySummary, generatePerformanceReport,
  generateMVPAnnouncement, startTrivia, checkTriviaAnswer, getTriviaLeaderboard,
  getGoodMorning, generateRoast, startMeeting, endMeeting, startMoodCheck,
  recordMood, getMoodSummary, handleSecretCommand, addHype, looksLikeCode,
  autoReviewCode,
} = require("./features");

// personality v5 — all imports handled above

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

// ─── State ──────────────────────────────────────────────────────────────────
const lastBotMsgKey = {};  // { groupJid: { id, remoteJid, fromMe } }──
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

// ─── Human-like Delay ────────────────────────────────────────────────────────
// Simulates human typing speed — makes bot undetectable to WhatsApp
async function humanDelay(text = "") {
  // Base delay: 1-3 seconds
  const base    = 1000 + Math.random() * 2000;
  // Extra delay based on message length (like typing speed)
  const typing  = Math.min(text.length * 15, 3000);
  const total   = base + typing;
  await new Promise(r => setTimeout(r, total));
}

// ─── Typing Indicator ─────────────────────────────────────────────────────────
async function sendWithTyping(jid, text, mentions = []) {
  try {
    // Show "typing..." indicator
    await sock.sendPresenceUpdate("composing", jid);
    // Wait realistic typing time
    await humanDelay(text);
    // Stop typing
    await sock.sendPresenceUpdate("paused", jid);
    // Send message
    await sock.sendMessage(jid, { text, mentions });
  } catch (e) {
    console.error("[sendMsg]", e.message);
    // Fallback without typing indicator
    try { await sock.sendMessage(jid, { text, mentions }); } catch {}
  }
}

// ─── Send Message ─────────────────────────────────────────────────────────────
async function sendMsg(jid, text, mentions = []) {
  try {
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise(r => setTimeout(r, Math.min(text.length * 18, 2500)));
    await sock.sendPresenceUpdate("paused", jid);
    const sent = await sock.sendMessage(jid, { text, mentions: mentions || [] });
    if (sent?.key) lastBotMsgKey[jid] = sent.key;  // track last message
  } catch (e) {
    console.error("[sendMsg]", e.message);
    try {
      const sent = await sock.sendMessage(jid, { text, mentions: mentions || [] });
      if (sent?.key) lastBotMsgKey[jid] = sent.key;
    } catch {}
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
  // Strip all non-digits, also handle local Nigerian numbers (08... → 2348...)
  let q = query.replace(/[@+\s\-]/g, "").toLowerCase();
  // Normalize Nigerian local format 08xxxxxxxx → 2348xxxxxxxx
  if (q.startsWith("0") && q.length === 11) q = "234" + q.slice(1);
  return members.find(m => {
    const phone = m.phone.replace(/\D/g, "");
    return phone.includes(q) || phone.endsWith(q) || q.endsWith(phone.slice(-8));
  }) || null;
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

    const hasImage    = !!(mc.imageMessage || mc.stickerMessage);
    const hasDocument = !!(mc.documentMessage);
    const hasAudio    = !!(mc.audioMessage);

    // ── Handle document/file uploads ─────────────────────────────────────────
    if (hasDocument) {
      const docMsg   = mc.documentMessage;
      const filename = docMsg.fileName || "unknown_file";
      const mimetype = docMsg.mimetype || "";
      const fileType = getFileType(filename, mimetype);
      const targetJid = isGroup ? jid : senderJid;

      if (!isGroup || !TARGET_GROUP || jid === TARGET_GROUP) {
        console.log(`[File] Received: ${filename} (${fileType}) from ${senderPhone}`);
        try {
          const { downloadMediaMessage } = require("@whiskeysockets/baileys");
          const buffer   = await downloadMediaMessage(msg, "buffer", {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage });
          const rawText  = extractTextFromBuffer(buffer, fileType);
          const analysis = rawText ? await analyzeFileContent(rawText, fileType, filename) : null;
          const response = buildFileResponse(filename, fileType, analysis, senderPhone);
          await sendMsg(targetJid, response);

          // If developer sent it, store for sharing
          if (isDeveloper(senderJid)) devMemory.lastImage = buffer;
        } catch (fileErr) {
          console.error("[File] Error:", fileErr.message);
          await sendMsg(targetJid, `📎 ${fmt("File received:")} ${filename}
${italic("Couldn't fully read this file type, but it's noted! 📌")}`);
        }
      }
      if (!text) return;
    }

    // ── Handle image messages (Group + DM) ──────────────────────────────────────
    if (hasImage && mc.imageMessage) {
      const targetJid = isGroup ? jid : senderJid;
      const isDev     = isDeveloper(senderJid);
      console.log("[Image] Received from " + senderPhone + " isGroup=" + isGroup);

      // Skip wrong group
      if (isGroup && TARGET_GROUP && jid !== TARGET_GROUP) return;

      try {
        const { downloadMediaMessage } = require("@whiskeysockets/baileys");
        const buffer    = await downloadMediaMessage(msg, "buffer", {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage });
        const base64Img = buffer.toString("base64");
        const mediaType = mc.imageMessage.mimetype || "image/jpeg";
        const caption   = text || "";

        // Store image for developer
        if (isDev) devMemory.lastImage = buffer;
        if (!isGroup && isDev) recordDMConversation("user", "[sent image" + (caption ? ": " + caption : "") + "]");

        // Try Groq Vision
        const analysis = await analyzeImageWithClaude(base64Img, mediaType);

        if (analysis) {
          if (isGroup) {
            await sendTagMsg(jid, "👁️ *Image Analysis:*\n━━━━━━━━━━━━━━━━━━━━\n" + analysis, [senderJid]);
          } else {
            await sendMsg(senderJid, "👁️ *Image Analysis:*\n━━━━━━━━━━━━━━━━━━━━\n" + analysis);
            if (isDev) {
              recordDMConversation("assistant", analysis);
              if (TARGET_GROUP) await sendMsg(senderJid, "_Say \"share to group\" to post this 📤_");
            }
          }
        } else {
          // Fallback — human text response
          const hour    = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" })).getHours();
          const timeCtx = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
          let prompt, userMsg;

          if (isGroup) {
            prompt  = "You are AlgivixAI, a friendly smart bot in Algivix Dev Team WhatsApp group by EMEMZYVISUALS DIGITALS.";
            userMsg = "A team member sent an image" + (caption ? " with caption: \"" + caption + "\"" : " with no caption") + ". React naturally as a team bot. Keep it short and tag them.";
          } else if (isDev) {
            prompt  = getPersonalityPrompt();
            userMsg = "I just sent you a photo" + (caption ? " — caption: \"" + caption + "\"" : ", no caption") + ". It is " + timeCtx + ". React like a real close friend — warm, funny, curious! 2-3 sentences max.";
          } else {
            prompt  = "You are AlgivixAI, a helpful WhatsApp bot.";
            userMsg = "Someone sent an image" + (caption ? " with caption: \"" + caption + "\"" : "") + ". Respond naturally.";
          }

          const reply = await askGroqDirect(prompt, userMsg, isDev ? devMemory.conversations : []);
          if (isGroup) {
            await sendTagMsg(jid, reply, [senderJid]);
          } else {
            await sendMsg(senderJid, reply);
            if (isDev) {
              recordDMConversation("assistant", reply);
              if (TARGET_GROUP) await sendMsg(senderJid, "_Say \"share to group\" to post this 📤_");
            }
          }
        }
      } catch (imgErr) {
        console.error("[Image] Error:", imgErr.message);
        const errMsg = isGroup
          ? "📸 Got the image but had a little trouble reading it 😅"
          : (isDeveloper(senderJid) ? "Yo boss! Trouble with that pic 😅 Try again?" : "📸 Got your image but couldn't read it 😄");
        await sendMsg(targetJid, errMsg);
      }
      if (!text) return;
    }

    if (!text) return;

    console.log(`[${isGroup ? "GRP" : "DM"}] ${senderPhone}: ${text.slice(0, 80)}`);

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
      memoryManager.recordGroupMessage(senderPhone, senderPhone, text);

      // ── Track member activity (for inactive detection) ───────────────────
      updateMemberActivity(senderPhone);
      memoryManager.updateLastSeen(senderPhone);

      // ── Ghost / Lockdown from persistent memory ───────────────────────────
      if (memoryManager.ghostMode && !isDev) return;
      if (memoryManager.lockdown && !adminUser && !isDev) return;
      if (memoryManager.isIgnored(senderPhone) && !isDev) {
        console.log(`[Ignore] Skipping: ${senderPhone}`); return;
      }

      // ── Drama detection ───────────────────────────────────────────────────
      if (!isDev && detectDrama(text)) {
        await sendMsg(jid, getDramaResponse());
      }

      // ── Return greeting — welcome back after 24h+ absence ────────────────
      if (shouldGreetReturn(senderPhone)) {
        const hoursGone = Math.floor((Date.now() - (memberLastSeen?.get?.(senderPhone) || Date.now())) / 3600000);
        const greeting  = await generateReturnGreeting(senderPhone, hoursGone);
        markGreeted(senderPhone);
        await sendTagMsg(jid, greeting, [senderJid]);
      }

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
        const triviaReply = await Promise.resolve(checkTriviaAnswer(senderPhone, text, sendMsg, jid));
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

      // ── Bodyguard — protect developer from disrespect ────────────────────
      const _bodyguard = !isDev ? checkForDisrespect(text) : null;
      if (_bodyguard) { await sendMsg(jid, _bodyguard); return; }


      // ── !submit in group — handled by commands.js processCommand below

      // ── Developer mentioned — notify developer privately ──────────────────
      if (!isDev && TARGET_GROUP && (
        text.toLowerCase().includes("ememzy") || text.includes(DEVELOPER_NUM)
      )) {
        const devJid = DEVELOPER_NUM + "@s.whatsapp.net";
        const notifType = text.includes("?") ? "❓ Question" : "👀 Mention";
        await sendMsg(devJid, `${notifType} in group:\n${senderPhone}: _"${text.slice(0, 120)}"_`);
      }

      // ── Auto react to messages (15% chance) ───────────────────────────────
      if (Math.random() < 0.15) {
        // auto-react removed (v5 uses message responses instead)
      }

      // ── Always react to developer messages (60% chance) ──────────────────
      if (isDev && Math.random() < 0.6) {
        const reactions = ["fire", "heart", "thumbsup"];
        // auto-react to dev message
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

      // ── Auto detect questions & problems — with full context ────────────
      if (!text.startsWith("!") && text.length > 8) {
        const qType = detectQuestionOrProblem(text);
        if (qType) {
          console.log(`[AutoQA] Detected ${qType} from ${senderPhone}`);
          // Get conversation context including previous replies
          const ctx     = memoryManager.getConversationContext(senderPhone, 8);
          const qaReply = await answerWithContext(text, qType, ctx, senderPhone);
          if (qaReply) {
            await sendTagMsg(jid, qaReply, [senderJid]);
            memoryManager.recordBotReply(qaReply);
            return;
          }
        }
      }

      // ── !delete — admin/dev replies to a message and bot deletes it ─────────
      if (text.trim().toLowerCase() === "!delete" && (adminUser || isDev)) {
        const quotedKey = mc.extendedTextMessage?.contextInfo?.stanzaId;
        const quotedSender = mc.extendedTextMessage?.contextInfo?.participant;
        if (quotedKey) {
          try {
            await sock.sendMessage(jid, { delete: {
              remoteJid: jid,
              fromMe: quotedSender === (sock.user?.id || ""),
              id: quotedKey,
              participant: quotedSender,
            }});
            console.log("[!delete] Deleted message:", quotedKey);
          } catch (e) {
            console.error("[!delete] Error:", e.message);
            await sendMsg(jid, "❌ Couldn't delete that message. Make sure I'm an admin!");
          }
        } else {
          await sendMsg(jid, "⚠️ Reply to a message first, then type *!delete*");
        }
        return;
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
      const isDev = isDeveloper(senderJid);

      // Mark developer online
      if (isDev) { rememberDev("isOnline", true); rememberDev("lastSeen", Date.now()); }

      // !broadcast
      if (text.toLowerCase().startsWith("!broadcast")) {
        await handlePrivateBroadcast(senderJid, text.slice("!broadcast".length).trim());
        return;
      }

      // post status: message
      if (isDev && (text.toLowerCase().startsWith("post status:") || text.toLowerCase().startsWith("post status "))) {
        const idx2      = text.indexOf(":");
        const statusMsg = idx2 > -1 ? text.slice(idx2 + 1).trim() : text.slice(12).trim();
        const success   = await (async () => { try { await sock.updateProfileStatus(statusMsg); return true; } catch { return false; } })();
        await sendMsg(senderJid, success
          ? `✅ *Status posted!* Your update is live on WhatsApp status! 📱`
          : `❌ Could not post status. Make sure bot has status permissions.`
        );
        return;
      }

      // ── DEVELOPER DM — Full NLP + AI Chat ───────────────────────────────
      if (isDev) {
        rememberDev("lastSeen", Date.now());
        rememberDev("isOnline", true);
        recordDMConversation("user", text);

        // ── Add task via DM natural language ─────────────────────────────
        const addTaskMatch = text.match(/^add\s+task\s*:?\s*(.+)/i);
        if (addTaskMatch) {
          const taskRaw = addTaskMatch[1].trim();
          try {
            const fs   = require("fs");
            const path = require("path");
            const tFile = path.join(__dirname, "tasks.json");
            const data  = JSON.parse(fs.readFileSync(tFile, "utf8"));

            // Parse task details from natural language using AI
            const parsed = await askGroqDirect(
              "You are a task parser. Extract task info from text and return ONLY valid JSON with keys: title, description, assignedTo, priority (high/medium/low), deadline (YYYY-MM-DD or null), status (always 'pending'). No extra text.",
              taskRaw
            );
            let taskObj;
            try {
              taskObj = JSON.parse(parsed.replace(/```json|```/g, "").trim());
            } catch {
              taskObj = { title: taskRaw, description: taskRaw, assignedTo: "all", priority: "medium", deadline: null, status: "pending" };
            }

            // Add to tasks.json
            const newId = Math.max(0, ...(data.tasks || []).map(t => t.id)) + 1;
            taskObj.id  = newId;
            data.tasks  = data.tasks || [];
            data.tasks.push(taskObj);
            data.lastUpdated = new Date().toISOString().split("T")[0];
            fs.writeFileSync(tFile, JSON.stringify(data, null, 2));

            const reply = (
              "✅ *Task Added!*\n━━━━━━━━━━━━━━━━━━━━\n" +
              "📌 *Title:* " + taskObj.title + "\n" +
              "👤 *Assigned:* " + taskObj.assignedTo + "\n" +
              "🚨 *Priority:* " + taskObj.priority + "\n" +
              (taskObj.deadline ? "📅 *Deadline:* " + taskObj.deadline + "\n" : "") +
              "\n_Say \"post tasks\" to share the updated list to the group!_"
            );
            await sendMsg(senderJid, reply);
            recordDMConversation("assistant", reply);
            return;
          } catch (e) {
            await sendMsg(senderJid, "❌ Couldn't add that task boss. Try: _add task: Fix login bug, assigned to Cyrus, deadline Friday_");
            return;
          }
        }

        // ── Remove task via DM ────────────────────────────────────────────
        const removeTaskMatch = text.match(/^(?:remove|delete|done with|complete|finish)\s+task\s*:?\s*(.+)/i);
        if (removeTaskMatch) {
          try {
            const fs   = require("fs");
            const path = require("path");
            const tFile = path.join(__dirname, "tasks.json");
            const data  = JSON.parse(fs.readFileSync(tFile, "utf8"));
            const query = removeTaskMatch[1].toLowerCase().trim();

            // Find task by title or number
            const idx = data.tasks.findIndex(t =>
              t.title.toLowerCase().includes(query) ||
              String(t.id) === query
            );

            if (idx === -1) {
              await sendMsg(senderJid, "❌ Couldn't find that task boss. Use *!task* to see the list.");
              return;
            }

            const removed = data.tasks.splice(idx, 1)[0];
            data.lastUpdated = new Date().toISOString().split("T")[0];
            fs.writeFileSync(tFile, JSON.stringify(data, null, 2));

            const reply = "✅ *Task removed:* " + removed.title + "\n_" + (data.tasks.length) + " tasks remaining._";
            await sendMsg(senderJid, reply);
            recordDMConversation("assistant", reply);
            return;
          } catch (e) {
            await sendMsg(senderJid, "❌ Couldn't remove that task boss. Try: _remove task: Fix login bug_");
            return;
          }
        }

        // ── Update task status via DM ─────────────────────────────────────
        const updateTaskMatch = text.match(/^(?:mark|set|update)\s+task\s*:?\s*(.+?)\s+(?:as|to)\s+(done|completed|in.progress|pending)/i);
        if (updateTaskMatch) {
          try {
            const fs    = require("fs");
            const path  = require("path");
            const tFile  = path.join(__dirname, "tasks.json");
            const data   = JSON.parse(fs.readFileSync(tFile, "utf8"));
            const query  = updateTaskMatch[1].toLowerCase().trim();
            const status = updateTaskMatch[2].toLowerCase().replace("-", " ").trim();

            const task = data.tasks.find(t => t.title.toLowerCase().includes(query) || String(t.id) === query);
            if (!task) { await sendMsg(senderJid, "❌ Task not found boss!"); return; }

            task.status = status;
            data.lastUpdated = new Date().toISOString().split("T")[0];
            fs.writeFileSync(tFile, JSON.stringify(data, null, 2));

            const reply = "✅ *Updated!* \"" + task.title + "\" is now *" + status + "*";
            await sendMsg(senderJid, reply);
            recordDMConversation("assistant", reply);
            return;
          } catch (e) {
            await sendMsg(senderJid, "❌ Couldn't update that task.");
            return;
          }
        }

        // ── Post tasks to group ───────────────────────────────────────────
        if (/^post\s+tasks?$/i.test(text.trim()) || /^share\s+tasks?\s+to\s+(?:the\s+)?group$/i.test(text.trim())) {
          if (TARGET_GROUP) {
            const { handleTask } = require("./commands");
            await sendMsg(TARGET_GROUP, handleTask());
            const reply = "✅ *Tasks posted to the group!* 📌";
            await sendMsg(senderJid, reply);
            recordDMConversation("assistant", reply);
          }
          return;
        }

        // ── No new tasks ──────────────────────────────────────────────────
        if (/^no\s+new\s+tasks?$/i.test(text.trim()) || /^no\s+tasks?$/i.test(text.trim())) {
          const reply = "Got it boss! 👍 I'll keep the current task list as is. Have a productive day! 💪";
          await sendMsg(senderJid, reply);
          recordDMConversation("assistant", reply);
          return;
        }

        // ── !Glist — Developer guide ──────────────────────────────────────
        if (text.toLowerCase() === "!glist" || text.toLowerCase() === "!devguide") {
          await sendMsg(senderJid, getGList());
          return;
        }

        // ── Task management DM commands ──────────────────────────────────
        if (!text.startsWith("!")) {
          const taskAction = handleTaskDMCommand(text);
          if (taskAction) {
            if (taskAction.action === "add_prompt") {
              // Parse inline add: "add task: Fix bug | assigned to Cyrus | deadline 2026-03-20 | high"
              const parts   = text.replace(/add task:?\s*/i, "").split("|").map(s => s.trim());
              const title   = parts[0];
              const assigned = (parts.find(p => /assigned to/i.test(p)) || "").replace(/assigned to/i, "").trim() || "all";
              const deadline = (parts.find(p => /deadline/i.test(p)) || "").replace(/deadline/i, "").trim() || "";
              const priority = (parts.find(p => /high|medium|low/i.test(p)) || "medium").toLowerCase().match(/high|medium|low/)?.[0] || "medium";
              const desc     = parts.find(p => p.length > 30 && !p.match(/assigned|deadline|high|medium|low/i)) || "";

              if (!title || title.length < 3) {
                const reply = "📋 To add a task say:\n_add task: <title> | assigned to <n> | deadline <YYYY-MM-DD> | high/medium/low_\n\nExample:\n_add task: Fix login bug | assigned to Cyrus | deadline 2026-03-20 | high_";
                await sendMsg(senderJid, reply);
                recordDMConversation("assistant", reply);
                return;
              }

              const reply = executeDMAction("add", { title, assignedTo: assigned, deadline: deadline || new Date(Date.now() + 7*86400000).toISOString().split("T")[0], priority, description: desc });
              await sendMsg(senderJid, reply);
              if (TARGET_GROUP) {
                const groupAnnounce = "📋 *New Task Added!*\n━━━━━━━━━━━━━━━━━━━━\n*" + title + "*\n👤 " + assigned + " | 📅 " + (deadline || "TBD") + " | Priority: " + priority + "\n\n💪 Use *!task* to see all tasks!";
                await sendMsg(TARGET_GROUP, groupAnnounce);
              }
              recordDMConversation("assistant", reply);
              return;
            }
          }

        // ── List / post tasks to group ─────────────────────────────────────
        if (/^list tasks?$|^show tasks?$|^my tasks?$/i.test(text.trim())) {
          const reply = buildTaskMessage();
          await sendMsg(senderJid, reply);
          recordDMConversation("assistant", reply);
          return;
        }

        if (/post tasks? to group|send tasks? to group/i.test(text)) {
          if (TARGET_GROUP) {
            await sendMsg(TARGET_GROUP, buildTaskMessage());
            await sendMsg(senderJid, "✅ *Tasks posted to the group!* 📋🔥");
          }
          return;
        }

        if (/^set goal:/i.test(text)) {
          const goal = text.replace(/set goal:\s*/i, "").trim();
          const tdata = loadTasks();
          tdata.weeklyGoal = goal;
          saveTasks(tdata);
          const reply = "✅ *Weekly goal updated!*\n_" + goal + "_";
          await sendMsg(senderJid, reply);
          recordDMConversation("assistant", reply);
          return;
        }

        const taskUpdateMatch = text.match(/update\s+task\s+#?(\d+)\s+status:\s*(.+)/i);
        if (taskUpdateMatch) {
          const tdata2 = loadTasks();
          const tidx   = parseInt(taskUpdateMatch[1]) - 1;
          if (tdata2.tasks[tidx]) {
            tdata2.tasks[tidx].status = taskUpdateMatch[2].trim().toLowerCase();
            saveTasks(tdata2);
            await sendMsg(senderJid, "✅ *Task #" + taskUpdateMatch[1] + " updated!* Status: " + tdata2.tasks[tidx].status);
          } else {
            await sendMsg(senderJid, "❌ Task #" + taskUpdateMatch[1] + " not found!");
          }
          return;
        }

        // ── Snitch detection ──────────────────────────────────────────────
        const snitch = detectSnitch(text);
        if (snitch && TARGET_GROUP) {
          await sendMsg(TARGET_GROUP, snitch.groupMsg);
          const snitchReply = snitch.dmReply || "😂 Snitched to the group boss! They know now 👀";
          await sendMsg(senderJid, snitchReply);
          recordDMConversation("assistant", snitchReply);
          // Still continue to AI chat after snitch
        }

        // ── NLP Intent Detection — THE BIG ONE ───────────────────────────
        if (!text.startsWith("!")) {
          const intent = await detectIntent(text, devMemory.conversations);
          console.log(`[NLP] Intent: ${intent.intent} (${intent.confidence})`);

          if (intent.intent !== "none" && intent.confidence > 0.7) {
            let nlpReply = null;

            switch (intent.intent) {

              case "send_to_group": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const msg = intent.message?.trim();
                if (!msg) { nlpReply = "⚠️ What should I send to the group boss?"; break; }
                await sendMsg(TARGET_GROUP,
                  `📢 ${fmt("From EMEMZYVISUALS:")}
${msg}`
                );
                nlpReply = `✅ ${fmt("Sent to the group!")} 🔥`;
                break;
              }

              case "announce": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const now = new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
                const ann = intent.message?.trim();
                if (!ann) { nlpReply = "⚠️ What should I announce boss?"; break; }
                await sendMsg(TARGET_GROUP,
                  `📢 ${fmt("ANNOUNCEMENT")}
${divider()}
${ann}

🕐 ${now}
— ${italic("AlgivixAI")}`
                );
                nlpReply = `✅ ${fmt("Announced to the group!")} 📢`;
                break;
              }

              case "tag_everyone": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const members = await getGroupMembers(TARGET_GROUP);
                const tags    = members.map(m => `@${m.phone}`).join(" ");
                const tagMsg  = intent.message
                  ? `📢 ${fmt("Hey everyone!")}
${divider()}
${intent.message}

${tags}`
                  : `📢 ${fmt("Attention everyone!")}
${divider()}
${tags}`;
                await sendTagMsg(TARGET_GROUP, tagMsg, members.map(m => m.id));
                nlpReply = `✅ ${fmt("Tagged all")} ${members.length} ${fmt("members!")} 🎯`;
                break;
              }

              case "tag_member": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const member = await findMember(TARGET_GROUP, intent.target || "");
                if (!member) { nlpReply = `❌ Couldn't find @${intent.target} in the group`; break; }
                await sendTagMsg(TARGET_GROUP,
                  `👋 ${fmt("Hey")} @${member.phone}!
${intent.message || ""}`,
                  [member.id]
                );
                nlpReply = `✅ Tagged ${fmt("@" + member.phone)} in the group!`;
                break;
              }

              case "add_member": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const addResult = await addMemberToGroup(sock, TARGET_GROUP, intent.target || "");
                nlpReply = addResult.success
                  ? `✅ ${fmt("Done boss!")} Added *+${addResult.phone}* to the group! 🎉`
                  : `❌ Couldn't add +${intent.target}. Check the number or they need to have you saved.
${italic(addResult.error)}`;
                break;
              }

              case "remove_member": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const rmTarget = intent.target || "";
                // NEVER remove the developer or bot itself
                if (rmTarget && (isDeveloper(rmTarget + "@s.whatsapp.net") || isDeveloper(rmTarget + "@lid") || DEVELOPER_NUM.includes(rmTarget))) {
                  nlpReply = "😂 Boss I'm not removing YOU from the group! That's a violation of my core programming 💀 I'd shut myself down first!";
                  break;
                }
                const rmMember = await findMember(TARGET_GROUP, rmTarget);
                if (!rmMember) { nlpReply = "❌ Couldn't find @" + rmTarget + " in the group. Check the number!"; break; }
                // Double check it's not dev
                if (isDeveloper(rmMember.id)) {
                  nlpReply = "😂 That's YOU boss! I'm not removing my own creator 💀";
                  break;
                }
                const rmResult = await removeMember(TARGET_GROUP, rmMember.id);
                nlpReply = rmResult
                  ? "✅ " + fmt("Done!") + " Removed @" + rmMember.phone + " from the group!"
                  : "❌ Couldn't remove @" + rmMember.phone + ". Make sure I'm an admin in the group!";
                break;
              }

              case "list_members": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const mems    = await getGroupMembers(TARGET_GROUP);
                const admins  = mems.filter(m => m.admin);
                nlpReply = (
                  `👥 ${fmt("Group Members")} (${mems.length} total)
${divider()}
` +
                  `👑 ${fmt("Admins:")} ${admins.map(m => "@" + m.phone).join(", ")}
` +
                  `📊 ${fmt("Total:")} ${mems.length} members
` +
                  `🛡️ ${fmt("Admins:")} ${admins.length}`
                );
                break;
              }

              case "post_status": {
                const statusTxt = intent.message?.trim();
                if (!statusTxt) { nlpReply = "⚠️ What status should I post boss?"; break; }
                try {
                  // Post as WhatsApp Story (visible to contacts)
                  await sock.sendMessage("status@broadcast", {
                    text: statusTxt,
                  }, { backgroundColor: "#1a1a2e", font: 0 });
                  nlpReply = `✅ ${fmt("Status posted!")} "${statusTxt.slice(0, 40)}..." is live as a WhatsApp Story! 📱`;
                } catch (e) {
                  console.error("[Status]", e.message);
                  nlpReply = `❌ Couldn't post status story. Error: ${e.message.slice(0, 60)}`;
                }
                break;
              }

              case "share_context": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const topic    = intent.reference_topic || intent.message || "";
                const ctxMsg   = await generateContextMessage(topic, devMemory.conversations);
                if (!ctxMsg) { nlpReply = "❌ Couldn't generate context message. Try being more specific!"; break; }
                await sendMsg(TARGET_GROUP,
                  `💬 ${fmt("From EMEMZYVISUALS:")}
${divider()}
${ctxMsg}`
                );
                nlpReply = `✅ ${fmt("Shared context about")} "${topic}" ${fmt("to the group!")} 🔥`;
                break;
              }

              case "start_trivia": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const { startTrivia, addHype } = require("./features");
                await sendMsg(TARGET_GROUP, addHype(startTrivia(sendMsg, TARGET_GROUP)));
                nlpReply = `✅ ${fmt("Trivia started in the group!")} 🎮`;
                break;
              }

              case "start_meeting": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const { startMeeting } = require("./features");
                await sendMsg(TARGET_GROUP, startMeeting());
                nlpReply = `✅ ${fmt("Meeting started!")} I'm recording notes 📝`;
                break;
              }

              case "end_meeting": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const { endMeeting } = require("./features");
                const meetSummary = await endMeeting();
                await sendMsg(TARGET_GROUP, meetSummary);
                nlpReply = `✅ ${fmt("Meeting ended!")} Summary posted to group 📋`;
                break;
              }

              case "roast": {
                if (!TARGET_GROUP) { nlpReply = "❌ TARGET_GROUP_JID not set!"; break; }
                const { generateRoast } = require("./features");
                const roastMsg = await generateRoast(intent.target || "", intent.message || "");
                await sendTagMsg(TARGET_GROUP, roastMsg, []);
                nlpReply = `✅ ${fmt("Roasted!")} 😂🔥`;
                break;
              }
            }

            if (nlpReply) {
              await sendMsg(senderJid, nlpReply);
              recordDMConversation("assistant", nlpReply);
              // Don't return — also give a human-like reply below
              const followUp = await askGroqDirect(
                getPersonalityPrompt(memoryManager.getGroupContext(5)),
                `I just executed: ${intent.intent}. Acknowledge briefly in 1 sentence, casual.`,
                []
              );
              await sendMsg(senderJid, followUp);
              recordDMConversation("assistant", followUp);
              return;
            }
          }
        }

        // ── Default: Chat like a human — ALWAYS respond ───────────────────
        const groupCtx = memoryManager.getGroupContext(5);
        const aiReply  = await askGroqDirect(
          getPersonalityPrompt(groupCtx),
          text,
          devMemory.conversations
        );
        recordDMConversation("assistant", aiReply);
        await sendMsg(senderJid, aiReply);
        return;
      }

      // ── Non-developer DMs ─────────────────────────────────────────────────
      const reply = await processCommand(text, false, { senderJid, isDev: false });
      if (reply) {
        await sendMsg(senderJid, reply);
      } else if (text.startsWith("!")) {
        await sendMsg(senderJid, `❓ Unknown command. Try *!help*`);
      } else {
        await sendMsg(senderJid, "👋 *Hey!* I'm AlgivixAI!\nI work best in the Algivix Dev Team group.\nType *!help* to see what I can do! 🤖");
      }
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

  // ── v5 Personality Cron Jobs ──────────────────────────────────────────────

  // Morning greeting — 7AM WAT
  cron.schedule("0 6 * * *", async () => {
    await sendMsg(groupJid, getGreeting("morning"));
  });

  // Morning quote — 7:30AM WAT
  cron.schedule("30 6 * * *", async () => {
    await sendMsg(groupJid, getDevQuote());
  });

  // Morning briefing to developer — 7AM WAT
  cron.schedule("5 6 * * 1-5", async () => {
    if (!DEVELOPER_NUM) return;
    const devJid = DEVELOPER_NUM + "@s.whatsapp.net";
    const stats  = {
      messages:      memory.messages.filter(m => Date.now() - m.time < 86400000).length,
      activeMembers: new Set(memory.messages.filter(m => Date.now() - m.time < 86400000).map(m => m.phone)).size,
      triviaPlayed:  0,
    };
    await sendMsg(devJid, getMorningBriefing(stats));
  });

  // Afternoon greeting — 1PM WAT
  cron.schedule("0 12 * * *", async () => {
    if (Math.random() < 0.5) await sendMsg(groupJid, getGreeting("afternoon"));
  });

  // Afternoon quote — 2PM WAT
  cron.schedule("0 13 * * 1-5", async () => {
    await sendMsg(groupJid, getDevQuote());
  });

  // Evening greeting — 7PM WAT
  cron.schedule("0 18 * * *", async () => {
    await sendMsg(groupJid, getGreeting("evening"));
  });

  // Tech story — Mon, Wed, Fri at 11AM WAT
  cron.schedule("0 10 * * 1,3,5", async () => {
    const story = await getTechStory();
    await sendMsg(groupJid, story);
  });

  // Evening quote — 8PM WAT
  cron.schedule("0 19 * * *", async () => {
    if (Math.random() < 0.4) await sendMsg(groupJid, getDevQuote());
  });

  // Random human message — twice a day
  cron.schedule("0 9,15 * * 1-5", async () => {
    if (Math.random() < 0.6) await sendMsg(groupJid, getRandomHumanMessage());
  });

  // Post WhatsApp Story status every 6 hours
  cron.schedule("0 */6 * * *", async () => {
    try {
      const statusText = getStatusContent();
      await sock.sendMessage("status@broadcast", { text: statusText });
      console.log("[Status] Story posted:", statusText.slice(0, 40));
    } catch (e) { console.error("[Status]", e.message); }
  });

  // Inactive member detection — every day at 11AM WAT
  cron.schedule("0 10 * * *", async () => {
    try {
      const inactive = getInactiveMembers(26);
      if (inactive.length === 0) return;
      const members  = await getGroupMembers(groupJid);
      const toTag    = inactive
        .map(({ phone, hoursAgo }) => {
          const m = members.find(m => m.phone === phone);
          return m ? { jid: m.id, phone, hoursAgo } : null;
        })
        .filter(Boolean)
        .slice(0, 5); // Max 5 at once

      if (toTag.length === 0) return;

      const tags = toTag.map(m => `@${m.phone}`).join(" ");
      const msg  = (
        `👀 ${fmt("Hey! We miss you!")}
${divider()}
` +
        `${tags}

` +
        `You've been quiet for a while! 😴
` +
        `Hope everything's good — come back and contribute! 💪
` +
        `Use ${fmt("!ai")} if you need help with anything 🤖`
      );
      await sendTagMsg(groupJid, msg, toTag.map(m => m.jid));
      console.log(`[Inactive] Tagged ${toTag.length} inactive members`);

      // Also notify developer privately
      if (DEVELOPER_NUM) {
        const devJid = DEVELOPER_NUM + "@lid";
        const inactiveList = toTag.map(m => "• @" + m.phone + " (" + m.hoursAgo + "h absent)").join("\n");
        await sendMsg(devJid,
          "😴 *Inactive Member Report:*\n" + inactiveList + "\n\nI tagged them in the group!"
        );
      }
    } catch (e) { console.error("[InactiveCheck]", e.message); }
  });

  // ── Deadline reminders — check every day at 9AM WAT ────────────────────────
  cron.schedule("0 8 * * *", async () => {
    if (!TARGET_GROUP) return;
    try {
      const reminders = getDeadlineReminders();
      for (const r of reminders) {
        await new Promise(res => setTimeout(res, 2000));
        await sendMsg(TARGET_GROUP, r.message);

        // If overdue — auto review submissions
        if (r.type === "overdue") {
          await new Promise(res => setTimeout(res, 3000));
          const review = await reviewSubmissions(r.taskIdx);
          if (review) await sendMsg(TARGET_GROUP, review);

          // Also notify developer
          if (DEVELOPER_NUM) {
            const devJid = DEVELOPER_NUM + "@lid";
            const subs   = r.task.submissions?.length || 0;
            await sendMsg(devJid, "🚨 *Task Overdue Alert!*\n" + r.task.title + "\nSubmissions: " + subs + "\n\n_Want to extend the deadline? Say: update task #" + (r.taskIdx+1) + " deadline to <YYYY-MM-DD>_");
          }
        }
      }

      // Morning task summary to dev
      if (DEVELOPER_NUM) {
        const devJid = DEVELOPER_NUM + "@lid";
        const prompt = getTaskSetupPrompt();
        await sendMsg(devJid, prompt);
      }
    } catch (e) { console.error("[DeadlineCheck]", e.message); }
  });

  // ── Evening reminder for due-today tasks — 5PM WAT ────────────────────────
  cron.schedule("0 16 * * *", async () => {
    if (!TARGET_GROUP) return;
    try {
      const data     = loadTasks();
      const dueToday = data.tasks.filter(t => daysUntil(t.deadline) === 0 && t.status !== "completed");
for (const task of dueToday) {

        const idx = data.tasks.indexOf(task);
        await sendMsg(TARGET_GROUP, "⏰ *Final Reminder!* " + task.title + " is due *TODAY* — submit before midnight!\n📬 !submit " + (idx+1) + " <your work>");
      }
    } catch (e) { console.error("[EveningReminder]", e.message); }
  });

  // ── Bot randomly DMs developer first — 4 times a day ───────────────────────

  // Morning check-in + task prompt — 8AM WAT (weekdays)
  cron.schedule("0 7 * * 1-5", async () => {
    if (!DEVELOPER_NUM) return;
    const devJid = DEVELOPER_NUM + "@lid";
    const fs     = require("fs");
    const path   = require("path");

    // Load current tasks
    let taskCount = 0;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(__dirname, "tasks.json"), "utf8"));
      taskCount = (t.tasks || []).filter(x => x.status !== "done" && x.status !== "completed").length;
    } catch {}

    const msg = (
      "🌅 *Good morning boss!*\n━━━━━━━━━━━━━━━━━━━━\n" +
      "Hope you slept well! I've got the group covered 🤖\n\n" +
      "📌 *Current open tasks:* " + taskCount + "\n\n" +
      "*Do you have any new tasks for the team today?*\n" +
      "_Reply with the task details and I'll add it! E.g:_\n" +
      "_\"Add task: Fix login bug, assigned to Cyrus, deadline Friday\"_\n\n" +
      "Or just say *\"no new tasks\"* and I'll leave it! 😄"
    );
    await sendMsg(devJid, msg);
  });

  // Afternoon check-in — 1PM WAT (weekdays only)
  cron.schedule("0 12 * * 1-5", async () => {
    if (!DEVELOPER_NUM) return;
    const devJid  = DEVELOPER_NUM + "@lid";
    const msgs    = [
      "Afternoon boss! 😄 How's the grind going? Anything I can help with? 🤖",
      "Hey boss! Quick check-in ☀️ — making progress today? The team is active btw! 💪",
      "Yo boss! How far? 😄 Halfway through the day — you eating? Don't forget to take breaks! 🍽️",
      "Boss! It's afternoon already 😂 Hope you're not too deep in code to eat! How's everything going?",
    ];
    await sendMsg(devJid, msgs[Math.floor(Math.random() * msgs.length)]);
  });

  // Evening check-in — 8PM WAT
  cron.schedule("0 19 * * *", async () => {
    if (!DEVELOPER_NUM) return;
    const devJid  = DEVELOPER_NUM + "@lid";
    const msgs    = [
      "Evening boss! 🌙 How was the day? Hope you shipped something good 😄 Don't overwork yourself!",
      "Boss! It's evening 🌆 — wrapping up for the day? You've been putting in work! Rest is part of the grind too 💪",
      "Hey boss 👋 Just checking in this evening! Any wins today? Big or small — tell me! 🔥",
      "Yo boss! Evening! 🌙 You still coding or have you rested? Either way — proud of you! 😄",
    ];
    await sendMsg(devJid, msgs[Math.floor(Math.random() * msgs.length)]);
  });

  // Random "thinking of you" message — twice a week at random time
  cron.schedule("0 14 * * 2,4", async () => {
    if (!DEVELOPER_NUM) return;
    const devJid  = DEVELOPER_NUM + "@lid";
    const randoms = [
      "Boss I was just thinking — we really built something special with this bot 😄 You're talented fr! 👑",
      "Yo boss! Random thought — the team has been more active since I joined 😂 You're welcome! 🤖🔥",
      "Just wanted to remind you boss — whatever you're building, keep going! EMEMZYVISUALS DIGITALS is going places 🚀",
      "Boss! The group has been quiet today 👀 You should pop in and say something 😄",
      "Hey boss! Quick question — what's the next big feature you want me to have? 🤔 I'm always evolving!",
      "Yo boss I was doing some thinking 😂 — have you eaten today? Hydrated? Sleep enough? You matter more than code! ❤️",
    ];
    await sendMsg(devJid, randoms[Math.floor(Math.random() * randoms.length)]);
  });

  // ── Deadline checker — every hour ────────────────────────────────────────
  cron.schedule("0 * * * *", async () => {
    if (!TARGET_GROUP) return;
    try {
      await checkDeadlines(sendMsg, sendTagMsg, TARGET_GROUP, getGroupMembers, reviewSubmissions);
    } catch (e) { console.error("[DeadlineCheck]", e.message); }
  });

  // ── Monday 8AM — bot asks developer for new tasks ─────────────────────────
  cron.schedule("0 7 * * 1", async () => {
    if (!DEVELOPER_NUM) return;
    const devJid = DEVELOPER_NUM + "@lid";
    await sendMsg(devJid, getWeeklyTaskPrompt());
  });

  console.log(`[Cron] ✅ All 29 jobs scheduled`);
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
    // ── Anti-ban settings ──────────────────────────────────────────────────
    connectTimeoutMs:        60000,
    defaultQueryTimeoutMs:   60000,
    keepAliveIntervalMs:     25000,
    emitOwnEvents:           false,
    fireInitQueries:         true,
    generateHighQualityLinkPreview: false,
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

      // ── Simulate human online presence ───────────────────────────────────
      // Go online like a real person
      await sock.sendPresenceUpdate("available");
      // Randomly go "unavailable" every few hours to look human
      setInterval(async () => {
        try {
          const isOnline = Math.random() > 0.3; // 70% chance online
          await sock.sendPresenceUpdate(isOnline ? "available" : "unavailable");
        } catch {}
      }, (30 + Math.random() * 60) * 60 * 1000); // every 30-90 mins

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
for (const msg of messages) {

      // Mark message as read (blue ticks) — looks human
      try {
        await sock.readMessages([msg.key]);
      } catch {}
      await onMessage(msg);
    }
  });

  sock.ev.on("group-participants.update", onGroupUpdate);
}

// ─── Startup Banner ───────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════╗");
console.log("║    AlgivixAI — PERSONALITY EDITION v5    ║");
console.log("║    Developed by EMEMZYVISUALS DIGITALS   ║");
console.log("╠══════════════════════════════════════════╣");
console.log("║  ✅ Human-like DM with developer         ║");
console.log("║  ✅ Snitch mode 😂                       ║");
console.log("║  ✅ WhatsApp status posting              ║");
console.log("║  ✅ Bodyguard mode                       ║");
console.log("║  ✅ Auto reactions                       ║");
console.log("║  ✅ Tech stories                         ║");
console.log("║  ✅ Daily quotes & greetings             ║");
console.log("║  ✅ Morning briefing to developer        ║");
console.log("║  ✅ Developer mention notifications      ║");
console.log("║  ✅ Random human messages                ║");
console.log("║  ✅ 21 scheduled jobs                    ║");
console.log("╚══════════════════════════════════════════╝\n");

connect().catch(err => { console.error("[Fatal]", err); process.exit(1); });

process.on("SIGINT",             () => process.exit(0));
process.on("uncaughtException",  e  => console.error("[Uncaught]", e.message));
process.on("unhandledRejection", r  => console.error("[Unhandled]", r));
