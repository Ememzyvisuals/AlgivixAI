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
  await sendWithTyping(jid, text, mentions);
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

    // ── Handle image messages ─────────────────────────────────────────────────
    if (hasImage && mc.imageMessage) {
      console.log(`[Image] Received image from ${senderPhone}`);
      try {
        const { downloadMediaMessage } = require("@whiskeysockets/baileys");
        const buffer    = await downloadMediaMessage(msg, "buffer", {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage });
        const base64Img = buffer.toString("base64");
        const mediaType = mc.imageMessage.mimetype || "image/jpeg";

        // Store for developer (in case they want to share)
        if (isDeveloper(senderJid)) {
          devMemory.lastImage = buffer;
        }

        console.log(`[Image] Analyzing with Claude Vision...`);
        const analysis = await analyzeImageWithClaude(base64Img, mediaType);
        if (analysis) {
          const response = `👁️ *Image Analysis:*\n━━━━━━━━━━━━━━━━━━━━\n${analysis}`;
          const targetJid = isGroup ? jid : senderJid;

          // Only respond in target group or DMs
          if (!isGroup || !TARGET_GROUP || jid === TARGET_GROUP) {
            await sendMsg(targetJid, response);
          }
        }
      } catch (imgErr) {
        console.error("[Image] Error processing image:", imgErr.message);
      }
      if (!text) return; // No caption — done
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

        // ── !Glist — Developer guide ──────────────────────────────────────
        if (text.toLowerCase() === "!glist" || text.toLowerCase() === "!devguide") {
          await sendMsg(senderJid, getGList());
          return;
        }

        // ── ! commands ────────────────────────────────────────────────────
        if (text.startsWith("!")) {
          const cmdReply = await processCommand(text, true, { senderJid, isDev: true });
          if (cmdReply) {
            await sendMsg(senderJid, cmdReply);
            recordDMConversation("assistant", cmdReply);
            return;
          }
        }

        // ── Share last image to group ─────────────────────────────────────
        if (devMemory.lastImage && (
          text.toLowerCase().includes("share to group") ||
          text.toLowerCase().includes("post to group") ||
          text.toLowerCase().includes("send to group")
        )) {
          const caption = text.replace(/share to group|post to group|send to group/gi, "").trim();
          if (TARGET_GROUP) {
            await sock.sendMessage(TARGET_GROUP, { image: devMemory.lastImage, caption: caption || "📸 From EMEMZYVISUALS" });
            const reply = "✅ Shared to the group boss! 🔥";
            await sendMsg(senderJid, reply);
            recordDMConversation("assistant", reply);
            devMemory.lastImage = null;
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
                const rmMember = await findMember(TARGET_GROUP, intent.target || "");
                if (!rmMember) { nlpReply = `❌ Couldn't find @${intent.target} in the group`; break; }
                const rmResult = await removeMember(TARGET_GROUP, rmMember.id);
                nlpReply = rmResult
                  ? `✅ ${fmt("Done!")} Removed @${rmMember.phone} from the group!`
                  : `❌ Couldn't remove that member. Make sure I'm an admin!`;
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
                  await sock.updateProfileStatus(statusTxt);
                  nlpReply = `✅ ${fmt("Status updated!")} "${statusTxt}" is live! 📱`;
                } catch { nlpReply = "❌ Couldn't update status. Try again!"; }
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
        await sendMsg(senderJid,
          `👋 *Hey!* I'm AlgivixAI!
I work best in the Algivix Dev Team group.
Type *!help* to see what I can do! 🤖`
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

  // Post WhatsApp status every 6 hours
  cron.schedule("0 */6 * * *", async () => {
    try {
      await sock.updateProfileStatus(getStatusContent());
      console.log("[Status] Updated");
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

  console.log(`[Cron] ✅ All 23 jobs scheduled`);
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
