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
  generateImage, editImage, downloadImageBuffer,
  addDevMessage, addGroupMessage, getDevHistory, getGroupContext,
  getFullBrainStats, getRawBrain, setBrainField, persistBrain, learnFact,
  looksLikeCode: looksLikeCodeAI,
} = require("./ai");
const {
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
const {
  parseMissionFromText, generateOpeningMessage, createMission,
  getActiveMission, generateAgentReply, logMessage,
  stopMission, pauseMission, resumeMission, listMissions,
  isSafeMessage, isOnTopic, buildReportMessage,
} = require("./agent");
// persist.js is superseded by ai.js unified brain (bot_brain.json)
const {
  addReminder, parseReminder, getDueReminders, listReminders,
  createPoll, getActivePoll, castVote, closePoll,
  buildPollMessage, buildResultsMessage, getExpiredPolls, getPollResults,
  addWarning: addWarnRecord, getWarnings, clearWarnings, buildWarnMessage,
  generateGroupDigest,
  setBusy, clearBusy, isBusy, getBusyMessage,
} = require("./reminders");

// ─── Dev memory — ALL backed by unified ai.js brain (survives redeploy) ──────
const devMemory = {
  mood:      null,
  lastImage: null,
  get conversations() { return getDevHistory(60); },
};
function rememberDev(k, v) { devMemory[k] = v; }
function recordDMConversation(role, text) {
  addDevMessage(role, text);           // → ai.js brain (persistent)
  memoryManager.recordDevMessage(role, text); // → memory.js (in-process)
}

const {
  memory, recordMessage, generateWeeklySummary, generatePerformanceReport,
  generateMVPAnnouncement, startTrivia, checkTriviaAnswer, getTriviaLeaderboard,
  getGoodMorning, generateRoast, startMeeting, endMeeting, startMoodCheck,
  recordMood, getMoodSummary, handleSecretCommand, addHype, looksLikeCode,
  autoReviewCode,
} = require("./features");

// personality v5 — all imports handled above

// ─── HTTP Keep-alive + Self-Ping (prevents Render free tier sleep) ─────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end("OK"); })
  .listen(PORT, () => {
    console.log(`[HTTP] Keep-alive on port ${PORT}`);
    // Self-ping every 10 minutes so Render never sleeps
    const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
      try {
        http.get(SELF_URL, () => {}).on("error", () => {});
      } catch {}
    }, 10 * 60 * 1000); // every 10 minutes
  });

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

    // ── BLOCK status/broadcast messages — never respond to WhatsApp statuses ──
    if (!jid || jid === "status@broadcast" || jid.endsWith("@broadcast")) return;
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
          // Pass caption/question sent WITH the file for smarter analysis
          const userQuestion = text || "";
          const analysis = rawText ? await analyzeFileContent(rawText, fileType, filename, userQuestion) : null;
          // If user asked something specific with the file, answer that — not generic analysis
          const response = buildFileResponse(filename, fileType, analysis, senderPhone, userQuestion);
          await sendMsg(targetJid, response);
          // If there was a caption question and we have analysis, give a direct answer too
          if (userQuestion && analysis && isDeveloper(senderJid)) {
            const directPrompt = getPersonalityPrompt();
            const directMsg = "I sent you a file named \"" + filename + "\" and asked: \"" + userQuestion + "\". Based on its content: " + analysis.slice(0, 600) + ". Answer my question directly and naturally.";
            const directReply = await askGroqDirect(directPrompt, directMsg, devMemory.conversations);
            if (directReply) await sendMsg(targetJid, directReply);
          }

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

    // ── Handle video messages ──────────────────────────────────────────────────
    if (mc.videoMessage) {
      const targetJid    = isGroup ? jid : senderJid;
      const videoCap     = mc.videoMessage?.caption || "";
      const videoCapFull = text || videoCap;
      if (isGroup && TARGET_GROUP && jid !== TARGET_GROUP) return;

      if (videoCapFull) {
        // User sent video WITH a caption/question — answer the question directly
        const isDev2  = isDeveloper(senderJid);
        const prompt  = isDev2 ? getPersonalityPrompt() : "You are AlgivixAI, a smart WhatsApp bot by EMEMZYVISUALS DIGITALS.";
        const fname   = mc.videoMessage?.fileName || "";
        const userMsg = "The user sent a video" + (fname ? ' named "' + fname + '"' : "") +
          " and said/asked: \"" + videoCapFull + "\". " +
          "IMPORTANT: Answer their question or respond to their caption FIRST and directly. " +
          "Only mention that you cannot watch the video if they are explicitly asking about the visual content. " +
          "If they are sharing context or making a statement with the video, just respond to that naturally.";
        const reply = await askGroqDirect(prompt, userMsg, isDev2 ? devMemory.conversations : []);
        if (isGroup) {
          await sendTagMsg(jid, reply, [senderJid]);
        } else {
          await sendMsg(senderJid, reply);
          if (isDev2) recordDMConversation("assistant", reply);
        }
      } else {
        // No caption — acknowledge receipt naturally
        const ack = isGroup
          ? "🎥 Got the video! Drop a caption or question with it and I'll help 😊"
          : "🎥 Got your video boss! I can't play videos but tell me what you need and I'm on it 🔥";
        await sendMsg(targetJid, ack);
      }
      return;
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

        // Try Groq Vision — pass caption so analysis directly addresses the question
        const analysis = await analyzeImageWithClaude(base64Img, mediaType, caption);

        if (analysis) {
          // If there was a caption/question, lead with a direct answer, then analysis
          const prefix = caption ? "" : "👁️ *Image Analysis:*\n━━━━━━━━━━━━━━━━━━━━\n";
          const fullReply = prefix + analysis;
          if (isGroup) {
            await sendTagMsg(jid, fullReply, [senderJid]);
          } else {
            await sendMsg(senderJid, fullReply);
            if (isDev) {
              recordDMConversation("assistant", fullReply);
              if (TARGET_GROUP) await sendMsg(senderJid, "_Say \"share to group\" to post this 📤_");
            }
          }
        } else {
          // Fallback — human text response that still addresses caption
          const hour    = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" })).getHours();
          const timeCtx = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
          let prompt, userMsg;

          if (isGroup) {
            prompt  = "You are AlgivixAI, a friendly smart bot in Algivix Dev Team WhatsApp group by EMEMZYVISUALS DIGITALS.";
            userMsg = "A team member sent an image" + (caption ? " with this question/caption: \"" + caption + "\". Answer their question directly first, then describe the image." : " with no caption. React naturally as a team bot. Keep it short and tag them.");
          } else if (isDev) {
            prompt  = getPersonalityPrompt();
            userMsg = "I just sent you a photo" + (caption ? " and asked: \"" + caption + "\". Answer my question directly and naturally." : ", no caption. It is " + timeCtx + ". React like a real close friend — warm, funny, curious! 2-3 sentences max.");
          } else {
            prompt  = "You are AlgivixAI, a helpful WhatsApp bot.";
            userMsg = "Someone sent an image" + (caption ? " and asked: \"" + caption + "\". Answer their question." : ". Respond naturally.") ;
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
      memoryManager.recordGroupMessage(senderPhone, msg.pushName || senderPhone, text);
      if (text) addGroupMessage(senderPhone, msg.pushName || senderPhone, text); // → unified brain

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

      // ── !imagine — Image Generation ─────────────────────────────────────────
      if (text.startsWith("!imagine") || text.startsWith("!generate")) {
        const prompt = text.replace(/^!(imagine|generate)\s*/i, "").trim();
        if (!prompt) {
          await sendMsg(jid, "🎨 Usage: *!imagine <description>*\nExample: _!imagine a futuristic Lagos skyline at night_");
          return;
        }
        await sendMsg(jid, `🎨 _Generating: "${prompt.slice(0, 60)}"..._ ⏳`);
        const result = await generateImage(prompt, senderPhone);
        if (!result.success) {
          await sendMsg(jid, result.error || "❌ Image generation failed. Try again.");
          return;
        }
        try {
          const buf = result.isB64
            ? Buffer.from(result.url, "base64")
            : await downloadImageBuffer(result.url);
          await sock.sendMessage(jid, {
            image:   buf,
            caption: `🎨 *"${prompt}"*
_Generated by AlgivixAI_ ✨`,
            mimetype: result.mimeType || "image/png",
          });
          addGroupMessage("BOT", "AlgivixAI", `Generated image: "${prompt}"`);
        } catch (e) {
          console.error("[ImageGen] Send error:", e.message);
          await sendMsg(jid, "❌ Generated but couldn't send. Try again!");
        }
        return;
      }

      // ── !poll — Create a poll ─────────────────────────────────────────────
      if (text.startsWith("!poll")) {
        const parts = text.slice(5).trim().match(/"([^"]+)"/g);
        if (!parts || parts.length < 3) {
          await sendMsg(jid, '📊 Usage: *!poll "Question" "Option 1" "Option 2" "Option 3"*\n_Min 2 options, max 5_');
          return;
        }
        const question = parts[0].replace(/"/g, "");
        const options  = parts.slice(1).map(p => p.replace(/"/g, "")).slice(0, 5);
        const poll     = createPoll(question, options, jid, 24);
        await sendMsg(jid, buildPollMessage(poll));
        return;
      }

      // ── Poll voting — detect "1", "2", "3" as votes ───────────────────────
      if (/^[1-5]$/.test(text.trim()) && !text.startsWith("!")) {
        const activePoll = getActivePoll(jid);
        if (activePoll) {
          const idx    = parseInt(text.trim()) - 1;
          const result = castVote(activePoll.id, senderPhone, idx);
          if (result.success) {
            const totalVotes = Object.keys(activePoll.votes).length + 1;
            await sendMsg(jid, result.changed
              ? `🔄 @${senderPhone} changed vote to *${activePoll.options[idx]}*`
              : `✅ @${senderPhone} voted for *${activePoll.options[idx]}* (${totalVotes} total)`,
              [senderJid]);
          }
          return;
        }
      }

      // ── !endpoll — Close a poll ────────────────────────────────────────────
      if (text.toLowerCase() === "!endpoll" && (isDev || adminUser)) {
        const activePoll = getActivePoll(jid);
        if (!activePoll) { await sendMsg(jid, "❌ No active poll."); return; }
        const results = closePoll(activePoll.id);
        await sendMsg(jid, buildResultsMessage(results));
        return;
      }

      // ── !warn — Warn a member (admin/dev only) ────────────────────────────
      if (text.startsWith("!warn") && (isDev || adminUser)) {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
                       || msg.message?.extendedTextMessage?.contextInfo?.participant;
        const reason    = text.replace(/^!warn\s*@?\S+\s*/i, "").trim() || "Violation of group rules";
        if (!mentioned) {
          await sendMsg(jid, "⚠️ Usage: *!warn @member reason*");
          return;
        }
        const targetPhone = normalizeJid(mentioned);
        const { count, shouldKick } = addWarnRecord(targetPhone, reason, senderPhone);
        const warnMsg = buildWarnMessage(targetPhone, reason, count);
        await sendTagMsg(jid, warnMsg, [mentioned]);

        if (shouldKick) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            await removeMember(jid, mentioned);
            await sendMsg(jid, `🚨 @${targetPhone} has been *removed* after 3 warnings.`);
            clearWarnings(targetPhone);
          } catch {
            await sendMsg(jid, `⚠️ Couldn't remove @${targetPhone} — make me admin first.`);
          }
        }
        return;
      }

      // ── !clearwarn — Clear warnings (dev/admin only) ─────────────────────
      if (text.startsWith("!clearwarn") && (isDev || adminUser)) {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mentioned) { await sendMsg(jid, "Usage: *!clearwarn @member*"); return; }
        const targetPhone = normalizeJid(mentioned);
        clearWarnings(targetPhone);
        await sendMsg(jid, `✅ Warnings cleared for @${targetPhone}`, [mentioned]);
        return;
      }

      // ── !pin — Pin a replied-to message ──────────────────────────────────
      if (text.toLowerCase() === "!pin" && (isDev || adminUser)) {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        if (!quoted) { await sendMsg(jid, "⚠️ Reply to the message you want to pin, then type *!pin*"); return; }
        try {
          await sock.sendMessage(jid, { pin: { type: 1, time: 604800 }, id: quoted }, { quoted: msg });
          await sendMsg(jid, "📌 Message pinned!");
        } catch {
          await sendMsg(jid, "❌ Couldn't pin — make me admin with pin permission.");
        }
        return;
      }

      // ── !brainstats — Show bot memory/brain stats ─────────────────────────
      if (text.toLowerCase() === "!brainstats" && isDev) {
        const s = getFullBrainStats();
        await sendMsg(jid,
          `🧠 *AlgivixAI Brain Stats*
━━━━━━━━━━━━━━━━━━━━
` +
          `💬 DM history: ${s.devConversations} messages
` +
          `📱 Group history: ${s.groupHistory} messages
` +
          `🎨 Images generated: ${s.generatedImages}
` +
          `👁️ Images analyzed: ${s.analyzedImages}
` +
          `📚 Facts learned: ${s.facts}
` +
          `📋 Total messages: ${s.totalMessages}
` +
          `🎯 Active missions: ${s.activeMissions}
` +
          `⏰ Pending reminders: ${s.pendingReminders}
` +
          `📅 Running since: ${new Date(s.startDate).toLocaleDateString()}
` +
          `🔄 Last restart: ${s.lastRestart ? new Date(s.lastRestart).toLocaleString("en-US", { timeZone: "Africa/Lagos" }) : "N/A"}`
        );
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

        // ── Agent Mission Commands (stop) handled in Agent block above ──────────

        // ── !imagine in DM ───────────────────────────────────────────────────
        // !imagine command: open to everyone in DMs
        // Natural language trigger (generate an image of...): dev only
        if ((text.startsWith("!imagine") || text.startsWith("!generate")) ||
            (isDev && /generate.*(image|picture|photo|art|illustration)|draw me|create.*(image|picture)/i.test(text))) {
          const prompt = text.replace(/^!(imagine|generate)\s*/i, "")
            .replace(/generate\s*(an?\s*)?(image|picture|photo|art|illustration)\s*(of|showing|depicting)?\s*/i, "")
            .replace(/draw\s+me\s+/i, "")
            .replace(/create\s*(an?\s*)?(image|picture)\s*(of)?\s*/i, "")
            .trim();
          if (!prompt || prompt.length < 3) {
            await sendMsg(senderJid, "🎨 What should I generate?\n_!imagine a futuristic Lagos at sunset_");
            recordDMConversation("assistant", "Asked for image prompt");
            return;
          }
          await sendMsg(senderJid, `🎨 _Generating: "${prompt.slice(0, 60)}"..._ ⏳\nThis takes about 10-30 seconds!`);
          const result = await generateImage(prompt, senderPhone);
          if (!result.success) {
            await sendMsg(senderJid, result.error || "❌ Image generation failed.");
            return;
          }
          try {
            const buf = result.isB64
              ? Buffer.from(result.url, "base64")
              : await downloadImageBuffer(result.url);
            await sock.sendMessage(senderJid, { image: buf, caption: `🎨 *"${prompt}"*
_Generated by AlgivixAI_ ✨` });
            recordDMConversation("assistant", `Generated image: "${prompt}"`);
          } catch {
            await sendMsg(senderJid, `✅ Image ready!
${result.url}`);
          }
          return;
        }

        // ── Image Editing — "edit this image", "change style to", "make it..." ──
        // Triggered when dev sends an image WITH an edit instruction, OR replies
        // to a previously generated image with an edit command
        if (isDev && devMemory.lastImage && (
          /edit.*(image|this|it)|change.*style|make it|restyle|add.*to.*image|remove.*from.*image|turn.*into|convert.*to.*style/i.test(text)
        )) {
          await sendMsg(senderJid, `🖌️ _Editing image: "${text.slice(0, 60)}"..._ ⏳\nThis takes ~15-30 seconds!`);
          const base64 = devMemory.lastImage.toString("base64");
          const result = await editImage(base64, text, senderPhone);
          if (!result.success) {
            await sendMsg(senderJid, result.error || "❌ Image edit failed. Try again!");
            recordDMConversation("assistant", "Image edit failed");
          } else {
            try {
              const buf = result.isB64
                ? Buffer.from(result.url, "base64")
                : await downloadImageBuffer(result.url);
              await sock.sendMessage(senderJid, {
                image:   buf,
                caption: `🖌️ *Edited!*\n_"${text.slice(0, 80)}"_\n_by AlgivixAI_ ✨`,
              });
              devMemory.lastImage = buf; // update lastImage to edited version
              recordDMConversation("assistant", `Edited image: "${text}"`);
            } catch {
              await sendMsg(senderJid, `✅ Edited image ready!\n${result.url}`);
            }
          }
          return;
        }

        // ── Scheduled message — "send this to group at 9AM tomorrow: ..." ──────
        if (isDev) {
          const schedMatch = text.match(/send\s+(?:this\s+)?to\s+(?:the\s+)?group\s+at\s+(.+?):\s+(.+)/i);
          if (schedMatch) {
            const timeStr = schedMatch[1].trim();
            const msgText = schedMatch[2].trim();
            let sendAt    = new Date(timeStr);
            // Handle "9AM tomorrow", "3PM Friday" etc
            if (isNaN(sendAt)) {
              sendAt = new Date();
              const ampm = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
              if (ampm) {
                let h = parseInt(ampm[1]);
                const m = parseInt(ampm[2] || 0);
                if (ampm[3].toLowerCase() === "pm" && h < 12) h += 12;
                if (ampm[3].toLowerCase() === "am" && h === 12) h = 0;
                sendAt.setHours(h - 1, m, 0, 0); // -1 for WAT offset
                if (/tomorrow/i.test(timeStr)) sendAt.setDate(sendAt.getDate() + 1);
              }
            }
            if (!isNaN(sendAt) && sendAt > new Date()) {
              const b = getRawBrain();
              b.scheduledMessages = b.scheduledMessages || [];
              b.scheduledMessages.push({ text: msgText, groupJid: TARGET_GROUP, sendAt: sendAt.getTime(), sent: false });
              setBrainField("scheduledMessages", b.scheduledMessages);
              const d = sendAt.toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "short", timeStyle: "short" });
              const r = `✅ *Scheduled!*\n_"${msgText.slice(0, 80)}"_\n📅 Will post to group at ${d} WAT`;
              await sendMsg(senderJid, r);
              recordDMConversation("assistant", r);
              return;
            }
          }
        }

        // ── Reminder commands ────────────────────────────────────────────────
        if (isDev) {
          const tl0 = text.toLowerCase().trim();
          if (tl0.startsWith("remind me") || tl0.startsWith("set reminder")) {
            const parsed = parseReminder(text);
            if (parsed) {
              addReminder(parsed.message, parsed.date, senderJid);
              const d = new Date(parsed.date).toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
              const r = `⏰ *Reminder set!*
_"${parsed.message}"_
📅 ${d}`;
              await sendMsg(senderJid, r);
              recordDMConversation("assistant", r);
              return;
            } else {
              await sendMsg(senderJid, '⏰ Format: _"Remind me on March 20 that Cyrus birthday"_ or _"Remind me in 2 hours to push code"_');
              return;
            }
          }
          if (tl0 === "my reminders" || tl0 === "show reminders" || tl0 === "list reminders") {
            const upcoming = listReminders();
            if (!upcoming.length) { await sendMsg(senderJid, "📅 No upcoming reminders."); return; }
            let msg = `📅 *Upcoming Reminders:*
━━━━━━━━━━━━━━━━━━━━
`;
            upcoming.forEach((r, i) => {
              const d = new Date(r.date).toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
              msg += `${i+1}. ${r.message}
   ⏰ ${d}

`;
            });
            await sendMsg(senderJid, msg.trim());
            return;
          }
        }

        // ── Busy mode ────────────────────────────────────────────────────────
        if (isDev) {
          const tl0 = text.toLowerCase().trim();
          if (/i('m| am) (in a meeting|busy|unavailable|not available|sleeping|resting)/i.test(tl0) || tl0.startsWith("busy mode")) {
            const custom = text.replace(/i('m| am) (in a meeting|busy|unavailable|not available|sleeping|resting)/i, "").trim();
            const msg = custom.length > 3 ? custom : "I'm currently unavailable. I'll get back to you soon 🙏";
            setBusy(msg);
            const r = `⏸️ *Busy mode ON!*
Anyone who DMs the bot number will get:
_"${msg}"_

Say "I'm back" or "busy mode off" to turn it off.`;
            await sendMsg(senderJid, r);
            recordDMConversation("assistant", r);
            return;
          }
          if (/i'?m back|busy (mode )?off|available now/i.test(tl0)) {
            clearBusy();
            const r = "✅ *Busy mode OFF!* Back to normal replies.";
            await sendMsg(senderJid, r);
            recordDMConversation("assistant", r);
            return;
          }
        }

        // ── Brain stats ──────────────────────────────────────────────────────
        if (isDev && /brain stats|memory stats|how much do you remember|what do you remember/i.test(text)) {
          const s = getFullBrainStats();
          const r = `🧠 *My Brain Stats*
━━━━━━━━━━━━━━━━━━━━
` +
            `💬 Our DM history: *${s.devConversations} messages*
` +
            `📱 Group history: *${s.groupHistory} messages*
` +
            `🎨 Images I've generated: *${s.generatedImages}*
` +
            `👁️ Images I've analyzed: *${s.analyzedImages}*
` +
            `📚 Facts learned: *${s.facts}*
` +
            `🎯 Active missions: *${s.activeMissions}*
` +
            `⏰ Pending reminders: *${s.pendingReminders}*
` +
            `📅 Running since: ${new Date(s.startDate).toLocaleDateString()}
` +
            `🔄 Last restart: ${s.lastRestart ? new Date(s.lastRestart).toLocaleString("en-US", { timeZone: "Africa/Lagos" }) : "unknown"}

` +
            `_Everything above survives redeploys 🧠_`;
          await sendMsg(senderJid, r);
          recordDMConversation("assistant", r);
          return;
        }

        // ── Schedule a message ──────────────────────────────────────────────
        if (isDev && /^schedule\s+|^send\s+.+\s+at\s+\d|^send\s+this\s+to\s+.+\s+at\s+/i.test(text)) {
          // "schedule this to the group at 9AM tomorrow: Good morning team!"
          const schedMatch = text.match(/send\s+(.+?)\s+(?:to\s+(?:the\s+)?group\s+)?at\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s+(?:tomorrow\s+)?[:–-]?\s*(.*)/i)
                          || text.match(/schedule\s+(?:this\s+)?(?:message\s+)?(?:to\s+(?:the\s+)?group\s+)?at\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*[:–-]?\s*(.*)/i);
          if (schedMatch) {
            const timeStr = schedMatch[2] || schedMatch[1];
            const msgText = schedMatch[3] || schedMatch[2] || "No message";
            const d       = new Date();
            // Parse time
            const tMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
            if (tMatch) {
              let h = parseInt(tMatch[1]);
              const m = parseInt(tMatch[2] || "0");
              if (tMatch[3]?.toUpperCase() === "PM" && h !== 12) h += 12;
              if (tMatch[3]?.toUpperCase() === "AM" && h === 12) h = 0;
              d.setHours(h - 1, m, 0, 0); // -1 for WAT
              if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); // tomorrow
              const b = getRawBrain();
              if (!b.scheduledMessages) b.scheduledMessages = [];
              b.scheduledMessages.push({ text: msgText, sendAt: d.getTime(), groupJid: TARGET_GROUP, sent: false, created: Date.now() });
              setBrainField("scheduledMessages", b.scheduledMessages);
              const r = `⏰ *Message scheduled!*
_"${msgText.slice(0, 60)}"_
📅 ${d.toLocaleString("en-US", { timeZone: "Africa/Lagos" })}`;
              await sendMsg(senderJid, r);
              recordDMConversation("assistant", r);
              return;
            }
          }
        }

        // ── Request group digest ─────────────────────────────────────────────
        if (isDev && /digest|summary|what happened today|group summary|daily report/i.test(text)) {
          await sendMsg(senderJid, "📊 _Generating group digest..._");
          const history = getRawBrain().groupHistory || [];
          const digest  = await generateGroupDigest(history, {});
          const r = `📊 *Today's Group Digest*
━━━━━━━━━━━━━━━━━━━━
${digest}`;
          await sendMsg(senderJid, r);
          recordDMConversation("assistant", r);
          return;
        }

        if (!text.startsWith("!")) {
          const tl = text.toLowerCase().trim();

          // "post on your status", "update your status", "post status nah" etc
          const statusTrigger = /post.*(status|story)|update.*(status|story)|put.*(status|story)|status.*post|story.*post/i.test(tl);
          if (statusTrigger) {
            // Strip ALL trigger phrases to get only the actual content
            let extracted = text
              .replace(/post\s+something\s+on\s+(your\s+)?(status|story)\s*(nah|now|please|bro|boss)?/i, "")
              .replace(/post\s+(on\s+)?(your\s+)?(status|story)\s*(nah|now|please|bro|boss)?/i, "")
              .replace(/update\s+(your\s+)?(status|story)\s*(nah|now|please|bro|boss)?/i, "")
              .replace(/put\s+(this\s+)?(on\s+)?(your\s+)?(status|story)\s*(nah|now|please|bro|boss)?/i, "")
              .replace(/^(nah|now|please|bro|boss|this|ok|okay)\s*/i, "")
              .trim();

            let statusTxt = (extracted && extracted.length >= 5) ? extracted : null;

            // If nothing meaningful extracted — generate from recent context
            if (!statusTxt) {
              try {
                const recentCtx = devMemory.conversations.slice(-4).map(c => c.content).join(" | ") || "building AlgivixAI in Nigeria";
                statusTxt = await askGroqDirect(
                  "You are AlgivixAI by EMEMZYVISUALS DIGITALS. Generate ONE punchy WhatsApp status update (max 100 chars, 1-2 emojis) inspired by this recent chat context. Return ONLY the status text, nothing else, no quotes.",
                  "Context: " + recentCtx,
                  []
                );
                statusTxt = statusTxt?.trim().replace(/^["']|["']$/g, "").slice(0, 100);
              } catch { statusTxt = getStatusContent(); }
            }
            if (!statusTxt) statusTxt = getStatusContent();
            try {
              await sock.sendMessage("status@broadcast", { text: statusTxt });
              const reply = "✅ Done boss! Posted on status:\n_\"" + statusTxt + "\"_ 📱🔥";
              await sendMsg(senderJid, reply);
              recordDMConversation("assistant", reply);
            } catch (e) {
              const reply = "❌ Couldn't post status: " + e.message.slice(0, 60);
              await sendMsg(senderJid, reply);
              recordDMConversation("assistant", reply);
            }
            return;
          }

          // "send this to the group", "post this to the group", "share to the group" etc
          const groupTrigger = /send.*(to the group|to group|group now)|post.*(to the group|to group)|share.*(to the group|to group)/i.test(tl);
          if (groupTrigger && TARGET_GROUP) {
            // Strip trigger phrase to get content
            let extracted2 = text
              .replace(/send\s+(this\s+)?to\s+(the\s+)?group(\s+now)?/i, "")
              .replace(/post\s+(this\s+)?to\s+(the\s+)?group/i, "")
              .replace(/share\s+(this\s+)?to\s+(the\s+)?group/i, "")
              .replace(/^(this|it|that)\s*/i, "")
              .trim();

            // If "this/it" with no content — use the last message the bot sent
            if (!extracted2 || extracted2.length < 4) {
              const lastBotMsg = devMemory.conversations.slice().reverse().find(c => c.role === "assistant");
              extracted2 = lastBotMsg ? lastBotMsg.content.slice(0, 500) : null;
            }

            if (extracted2) {
              await sendMsg(TARGET_GROUP, "📢 *From EMEMZYVISUALS:*\n" + extracted2);
              const reply = "✅ Sent to the group boss! 🔥";
              await sendMsg(senderJid, reply);
              recordDMConversation("assistant", reply);
              return;
            }
          }
        }

        // ── Send DM to any number (text + optional image) ───────────────────
        if (!text.startsWith("!")) {
          const dmMatch = tl.match(
            /(?:send\s+(?:a\s+)?(?:message|msg|dm)\s+to|message|dm|whatsapp|text|ping)\s+[+]?([\d]{7,15})[,\s]+(?:telling?|saying?|about|that|:)?\s*([\s\S]+)/i
          ) || tl.match(
            /(?:tell|inform|notify)\s+[+]?([\d]{7,15})[,\s]+(?:that|about|:)?\s*([\s\S]+)/i
          );

          if (dmMatch) {
            let rawNum  = dmMatch[1].replace(/\D/g, "");
            const about = dmMatch[2]?.trim();

            // Normalize Nigerian number
            if (rawNum.startsWith("0") && rawNum.length === 11) rawNum = "234" + rawNum.slice(1);
            if (rawNum.length <= 10) rawNum = "234" + rawNum;

            const targetJid = rawNum + "@s.whatsapp.net";

            if (!about || about.length < 2) {
              const reply = "⚠️ What should I tell them?\nExamples:\n_send a message to 09047114612 telling him meeting is 3PM_\n_message 09047114612 with an image of our logo and tell him it's the new design_\n_send a message to 09047114612 with this image and say check this out_";
              await sendMsg(senderJid, reply);
              recordDMConversation("assistant", reply);
              return;
            }

            // ── Detect image intent ──────────────────────────────────────
            // "with an image of X" — generate image from description
            const genImgMatch = about.match(/with\s+(?:an?\s+)?image\s+of\s+(.+?)(?:\s+and\s+(?:tell|say|ask)|$)/i)
                             || about.match(/generate\s+(?:an?\s+)?image\s+of\s+(.+?)(?:\s+and\s+|$)/i)
                             || about.match(/include\s+(?:an?\s+)?image\s+of\s+(.+?)(?:\s+and\s+|$)/i);
            const imgPrompt = genImgMatch ? genImgMatch[1].trim() : null;

            // "send this image" / "with this image" — use last image boss sent
            const useLastImg = !imgPrompt && devMemory.lastImage &&
              /send.*this.*image|with.*this.*image|attach.*this|include.*this.*image/i.test(tl);

            // Strip image instructions to get clean text content
            const cleanAbout = about
              .replace(/with\s+(?:an?\s+)?image\s+of\s+.+?(?=\s+and\s+(?:tell|say|ask)|$)/i, "")
              .replace(/generate\s+(?:an?\s+)?image\s+of\s+.+?(?=\s+and\s+|$)/i, "")
              .replace(/include\s+(?:an?\s+)?image\s+of\s+.+?(?=\s+and\s+|$)/i, "")
              .replace(/with\s+this\s+image/i, "")
              .replace(/send\s+this\s+image/i, "")
              .trim();

            // Generate natural message text
            let msgToSend;
            try {
              msgToSend = await askGroqDirect(
                "You are AlgivixAI sending a WhatsApp message on behalf of EMEMZYVISUALS DIGITALS. Write a short, natural, human-sounding WhatsApp message. No preamble. Plain WhatsApp style.",
                "Message content: " + (cleanAbout || about),
                []
              );
              msgToSend = msgToSend?.trim().replace(/^["']|["']$/g, "");
            } catch { msgToSend = cleanAbout || about; }

            try {
              if (imgPrompt) {
                // ── Generate image then send with message ────────────────
                await sendMsg(senderJid, "🎨 _Generating image of \"" + imgPrompt.slice(0,50) + "\" to send..._ ⏳");
                const imgResult = await generateImage(imgPrompt, senderPhone);

                if (imgResult.success) {
                  const imgBuf = Buffer.from(imgResult.url, "base64");
                  await sock.sendMessage(targetJid, {
                    image:    imgBuf,
                    caption:  msgToSend,
                    mimetype: imgResult.mimeType || "image/png",
                  });
                  const reply = "✅ *Image + message sent to +* " + rawNum + "!\n🎨 _Image: \"" + imgPrompt.slice(0,50) + "\"_\n📨 _\"" + msgToSend.slice(0,60) + "\"_";
                  await sendMsg(senderJid, reply);
                  recordDMConversation("assistant", reply);
                } else {
                  // Image gen failed — send text only
                  await sendMsg(senderJid, "⚠️ Image failed (" + (imgResult.error||"").slice(0,50) + "). Sending text only...");
                  await sock.sendMessage(targetJid, { text: msgToSend });
                  const reply = "✅ *Text sent to +* " + rawNum + " _(image failed)_\n📨 _\"" + msgToSend.slice(0,60) + "\"_";
                  await sendMsg(senderJid, reply);
                  recordDMConversation("assistant", reply);
                }

              } else if (useLastImg) {
                // ── Send the image boss already has ─────────────────────
                await sock.sendMessage(targetJid, {
                  image:   devMemory.lastImage,
                  caption: msgToSend,
                });
                const reply = "✅ *Image + message sent to +* " + rawNum + "!\n📨 _\"" + msgToSend.slice(0,60) + "\"_";
                await sendMsg(senderJid, reply);
                recordDMConversation("assistant", reply);

              } else {
                // ── Text only ────────────────────────────────────────────
                await sock.sendMessage(targetJid, { text: msgToSend });
                const reply = "✅ *Message sent to +* " + rawNum + "!\n📨 _\"" + msgToSend.slice(0,80) + (msgToSend.length>80?"...":"") + "\"_";
                await sendMsg(senderJid, reply);
                recordDMConversation("assistant", reply);
              }

              console.log("[DM-Send] Sent to " + rawNum + ":", msgToSend.slice(0, 50));
            } catch (e) {
              console.error("[DM-Send] Error:", e.message);
              const reply = "❌ Couldn't send to +" + rawNum + ". They may not be on WhatsApp or the number is wrong.\nError: " + e.message.slice(0, 60);
              await sendMsg(senderJid, reply);
              recordDMConversation("assistant", reply);
            }
            return;
          }
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
              // Only give a follow-up if it was a SUCCESS — and tell AI exactly what happened
              const wasSuccess = nlpReply.startsWith("✅");
              const wasFail    = nlpReply.startsWith("❌") || nlpReply.startsWith("⚠️") || nlpReply.startsWith("😂");
              if (wasSuccess) {
                const followUp = await askGroqDirect(
                  getPersonalityPrompt(memoryManager.getGroupContext(5)),
                  "I just successfully executed: " + intent.intent + ". Result: " + nlpReply + ". Give ONE short casual human reaction (1 sentence, no repetition of the result).",
                  devMemory.conversations
                );
                if (followUp) {
                  await sendMsg(senderJid, followUp);
                  recordDMConversation("assistant", followUp);
                }
              }
              // If it failed — no extra AI message, the error message is enough
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

      // ── Busy auto-reply for non-dev DMs ───────────────────────────────────
      if (!isDev && isBusy()) {
        const busyMsg = getBusyMessage();
        await sendMsg(senderJid,
          `👋 Hey! EMEMZYVISUALS is currently unavailable.

_"${busyMsg}"_

Your message has been noted. They'll get back to you! 🙏`
        );
        // Forward the DM to boss
        if (DEVELOPER_NUM) {
          const devJid = DEVELOPER_NUM + "@s.whatsapp.net";
          await sendMsg(devJid, `📩 *While you were busy, @${senderPhone} messaged:*
_"${text}"_`);
        }
        return;
      }

      // ── Agent Mission Reply Handler ───────────────────────────────────────
      if (!isDev && text) {
        const mission = getActiveMission(senderPhone);
        if (mission && mission.status === "active") {
          console.log("[Agent] Mission reply from " + senderPhone + ":", text.slice(0, 60));
          logMessage(senderPhone, "contact", text);

          const agentReply = await generateAgentReply(mission, text);
          if (!agentReply) return;

          const isComplete = agentReply.includes("MISSION_COMPLETE");
          const isPause    = agentReply.includes("MISSION_PAUSE");
          const cleanReply = agentReply.replace(/MISSION_COMPLETE|MISSION_PAUSE/g, "").trim();

          if (!isSafeMessage(cleanReply)) {
            console.warn("[Agent] Unsafe reply blocked");
            return;
          }

          await sock.sendMessage(senderJid, { text: cleanReply });
          logMessage(senderPhone, "bot", cleanReply);

          const devJid = mission.devJid;
          await sendMsg(devJid, buildReportMessage(mission, text, cleanReply, isComplete));

          if (isComplete) {
            stopMission(senderPhone);
          } else if (isPause) {
            pauseMission(senderPhone);
            await sendMsg(devJid, "⏸️ Mission paused — " + (mission.targetName || senderPhone) + " seems busy. Say _resume mission " + senderPhone + "_ to continue.");
          } else if (mission.log.length % 5 === 0) {
            await sendMsg(devJid,
              "📊 *Mission check-in* — " + mission.log.length + " messages with " + (mission.targetName || senderPhone) + ".\n" +
              "_Say stop mission " + senderPhone + " to end or ignore to keep going 💪_"
            );
          }
          return;
        }
      }

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

  // ── Auto WhatsApp Status — 3x daily (8AM, 1PM, 8PM WAT) ───────────────────
  async function postAutoStatus(label) {
    try {
      // Generate fresh AI status content
      const topics = [
        "building tech products in Nigeria",
        "software development grind",
        "AI and the future",
        "developer motivation",
        "startup life in Africa",
        "coding late at night",
        "shipping products fast",
      ];
      const topic = topics[Math.floor(Math.random() * topics.length)];
      let statusText;
      try {
        statusText = await askGroqDirect(
          "You are AlgivixAI, a WhatsApp bot by EMEMZYVISUALS DIGITALS. Generate ONE short punchy WhatsApp status update (max 120 characters) about: " + topic + ". Use 1-2 emojis. Make it feel real and human, not corporate. No quotes, just the status text itself.",
          "Generate the status now.",
          []
        );
        statusText = statusText?.trim().replace(/^"|"$/g, "").slice(0, 120);
      } catch {
        statusText = getStatusContent(); // fallback to static
      }
      if (!statusText) statusText = getStatusContent();
      await sock.sendMessage("status@broadcast", { text: statusText });
      console.log("[Status] " + label + " posted:", statusText.slice(0, 60));
      // DM dev with confirmation
      if (DEVELOPER_NUM) {
        const devJid = DEVELOPER_NUM + "@lid";
        await sendMsg(devJid, "📱 *Auto status posted!*\n_\"" + statusText + "\"_");
      }
    } catch (e) {
      console.error("[Status] Auto post failed:", e.message);
      if (DEVELOPER_NUM) {
        const devJid = DEVELOPER_NUM + "@lid";
        await sendMsg(devJid, "⚠️ Auto status failed: " + e.message.slice(0, 80));
      }
    }
  }

  cron.schedule("0 7 * * *",  () => postAutoStatus("Morning"));   // 8AM WAT
  cron.schedule("0 12 * * *", () => postAutoStatus("Afternoon")); // 1PM WAT
  cron.schedule("0 19 * * *", () => postAutoStatus("Evening"));   // 8PM WAT

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

  // ── Reminder checker — every 5 minutes ─────────────────────────────────────
  cron.schedule("*/5 * * * *", async () => {
    try {
      const due = getDueReminders();
      for (const r of due) {
        const devJid = r.devJid || (DEVELOPER_NUM + "@s.whatsapp.net");
        await sendMsg(devJid,
          `⏰ *REMINDER!*
━━━━━━━━━━━━━━━━━━━━
_"${r.message}"_

_Set earlier — firing now!_`
        );
        console.log("[Reminder] Fired:", r.message.slice(0, 50));
      }
    } catch (e) { console.error("[Reminder] Error:", e.message); }
  });

  // ── Poll expiry checker — every 30 minutes ───────────────────────────────────
  cron.schedule("*/30 * * * *", async () => {
    try {
      const expired = getExpiredPolls();
      for (const poll of expired) {
        const results = closePoll(poll.id);
        await sendMsg(poll.groupJid, "⏰ *Poll closed!*\n\n" + buildResultsMessage(results));
      }
    } catch (e) { console.error("[Poll] Expiry check error:", e.message); }
  });

  // ── Nightly Group Digest — 10PM WAT ─────────────────────────────────────────
  cron.schedule("0 21 * * *", async () => {
    if (!DEVELOPER_NUM) return;
    try {
      const devJid  = DEVELOPER_NUM + "@s.whatsapp.net";
      const history = getRawBrain().groupHistory || [];
      const digest  = await generateGroupDigest(history, {});
      await sendMsg(devJid,
        `📊 *Nightly Group Digest*
━━━━━━━━━━━━━━━━━━━━
${digest}

_Say "digest" anytime for a fresh summary 📋_`
      );
      console.log("[Digest] Nightly digest sent to dev");
    } catch (e) { console.error("[Digest] Error:", e.message); }
  });

  // ── Scheduled messages — forward queued ones (every minute) ─────────────────
  cron.schedule("* * * * *", async () => {
    try {
      const b = getRawBrain();
      if (!b.scheduledMessages) return;
      const now = Date.now();
      const due = b.scheduledMessages.filter(m => !m.sent && m.sendAt <= now);
      for (const m of due) {
        const target = m.groupJid || (DEVELOPER_NUM + "@s.whatsapp.net");
        await sendMsg(target, m.text);
        m.sent = true;
        console.log("[Scheduled] Sent:", m.text.slice(0, 50));
      }
      if (due.length) {
        setBrainField("scheduledMessages", b.scheduledMessages);
      }
    } catch {}
  });

  console.log(`[Cron] ✅ All 33 jobs scheduled (+ reminders, polls, digest, scheduled msgs)`);
}

// ─── WhatsApp Connection ──────────────────────────────────────────────────────
async function connect() {
  // ai.js brain auto-records lastRestart on first load
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
      const remoteJid = msg.key?.remoteJid || "";

      // ── BLOCK ALL STATUS/STORY MESSAGES — never process or respond to them ──
      // Status messages come from "status@broadcast" or have isViewOnce on broadcast
      if (
        remoteJid === "status@broadcast" ||
        remoteJid.endsWith("@broadcast") ||
        msg.message?.ephemeralMessage ||
        msg.key?.id?.startsWith("3EB0") && msg.message?.imageMessage?.viewOnce
      ) {
        // Only view developer's status — but NEVER respond
        const statusSender = msg.key?.participant || "";
        if (statusSender && isDeveloper(statusSender)) {
          try { await sock.readMessages([msg.key]); } catch {} // view it (shows as seen)
          console.log("[Status] Viewed developer status — no response sent");
        }
        continue; // NEVER process as a normal message
      }

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
