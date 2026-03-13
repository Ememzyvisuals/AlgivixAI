/**
 * agent.js — AlgivixAI Personal WhatsApp Agent v3
 * =================================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * STORAGE STRATEGY — Two-layer:
 *   1. _missionsMap (in-memory Map) — PRIMARY. Never wiped mid-session.
 *      Filled from bot_brain.json on first access, then kept in sync.
 *   2. bot_brain.json via persistBrain() — BACKUP for restarts.
 *
 * KEY FIX: missions live in-memory so they NEVER disappear between
 * "message sent" and "contact replies back" in the same session.
 */

const {
  getRawBrain, setBrainField, persistBrain,
  askGroqDirect, getMasterPersonality,
} = require("./ai");

// ─── In-Memory Mission Store (PRIMARY) ───────────────────────────────────────
let _missionsMap = null;   // null = not yet loaded

function _loadMap() {
  if (_missionsMap) return _missionsMap;
  const stored = getRawBrain().missions || {};
  _missionsMap = new Map(Object.entries(stored));
  console.log(`[Agent] 📦 Loaded ${_missionsMap.size} missions into memory`);
  return _missionsMap;
}

function _saveMap() {
  if (!_missionsMap) return;
  setBrainField("missions", Object.fromEntries(_missionsMap));
  persistBrain();
}

// ─── Phone normalisation ─────────────────────────────────────────────────────
function normPhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (/^0\d{10}$/.test(digits)) return "234" + digits.slice(1);
  return digits;
}

// ─── Mission lookup ───────────────────────────────────────────────────────────
function getMissions() { return Object.fromEntries(_loadMap()); }

function getActiveMission(phone) {
  const map  = _loadMap();
  const norm = normPhone(phone);
  if (map.has(norm))  return map.get(norm);
  if (map.has(phone)) return map.get(phone);
  // Suffix match (last 10 digits) — handles JID number vs stored number mismatches
  const suffix = norm.slice(-10);
  for (const [, m] of map) {
    if (m.targetPhone && m.targetPhone.endsWith(suffix)) return m;
  }
  return null;
}

// ─── Safety filter ────────────────────────────────────────────────────────────
const BANNED = ["fuck","stupid","idiot","bastard","bitch","kill","die",
  "hate you","curse","damn you","useless","fool","dumb","threat","harm",
  "attack","beat","slap","i will","you will regret"];
function isSafeMessage(msg) {
  const l = msg.toLowerCase();
  return !BANNED.some(w => l.includes(w));
}

// ─── Topic keywords ───────────────────────────────────────────────────────────
const STOP_WORDS = new Set(["the","a","an","is","in","on","at","to","for","of","and","or",
  "but","with","about","that","this","him","her","them","you","your","we","our","he","she","it","they"]);

function extractTopicKeywords(task) {
  return task.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

function isOnTopic(reply, mission) {
  if (!mission.topicKeywords?.length) return true;
  const lower = reply.toLowerCase();
  return mission.topicKeywords.some(kw => lower.includes(kw)) || reply.length < 50;
}

// ─── Create mission ───────────────────────────────────────────────────────────
function createMission(targetPhone, targetName, task, openingMessage, devJid) {
  const map  = _loadMap();
  const norm = normPhone(targetPhone);

  const mission = {
    id:            "M" + Date.now(),
    targetPhone:   norm,
    targetName:    targetName || norm,
    task,
    devJid,
    status:        "active",
    startTime:     new Date().toISOString(),
    openingMessage,
    topicKeywords: extractTopicKeywords(task),
    log: [{ role: "bot", content: openingMessage, time: new Date().toISOString() }],
  };

  map.set(norm, mission);
  _saveMap();
  console.log(`[Agent] ✅ Mission STORED in memory for ${norm} — "${task.slice(0,50)}"`);

  // Also write to allMemory
  const b = getRawBrain();
  b.allMemory = b.allMemory || [];
  b.allMemory.push({ model:"agent", role:"assistant",
    content:`Started mission to ${targetName||norm}: "${task}"`, time: Date.now() });
  if (b.allMemory.length > 300) b.allMemory = b.allMemory.slice(-300);
  persistBrain();

  return mission;
}

// ─── Log message to mission ───────────────────────────────────────────────────
function logMessage(targetPhone, role, content) {
  const map  = _loadMap();
  const norm = normPhone(targetPhone);
  const m    = map.get(norm) || map.get(targetPhone);
  if (!m) return;
  m.log = m.log || [];
  m.log.push({ role, content, time: new Date().toISOString() });
  _saveMap();
  const b = getRawBrain();
  b.allMemory = b.allMemory || [];
  b.allMemory.push({ model:"agent", role,
    content:`[${m.targetName}] ${content.slice(0,150)}`, time: Date.now() });
  if (b.allMemory.length > 300) b.allMemory = b.allMemory.slice(-300);
  persistBrain();
}

// ─── Stop / Pause / Resume ────────────────────────────────────────────────────
function stopMission(phone) {
  const map = _loadMap();
  const m   = map.get(normPhone(phone)) || map.get(phone);
  if (m) { m.status = "stopped"; _saveMap(); return true; }
  return false;
}

function pauseMission(phone) {
  const map = _loadMap();
  const m   = map.get(normPhone(phone)) || map.get(phone);
  if (m) { m.status = "paused"; _saveMap(); }
}

function resumeMission(phone) {
  const map = _loadMap();
  const m   = map.get(normPhone(phone)) || map.get(phone);
  if (m) { m.status = "active"; _saveMap(); }
}

// ─── List missions ────────────────────────────────────────────────────────────
function listMissions() {
  const all    = Array.from(_loadMap().values());
  const active = all.filter(m => m.status === "active");
  const paused = all.filter(m => m.status === "paused");

  if (!active.length && !paused.length)
    return "📋 *No active missions right now.*\n_Say \"message 0800000000 and tell him...\" to start one._";

  let msg = `*🕵️ Agent Missions (${active.length} active)*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  active.forEach((m, i) => {
    const n = (m.log||[]).length;
    const t = m.startTime
      ? new Date(m.startTime).toLocaleTimeString("en-NG",{timeZone:"Africa/Lagos",hour:"2-digit",minute:"2-digit"})
      : "?";
    msg += `${i+1}. 🟢 *${m.targetName}* (+${m.targetPhone})\n`;
    msg += `   📌 _${m.task.slice(0,70)}_\n`;
    msg += `   💬 ${n} message${n!==1?"s":""} · started ${t}\n\n`;
  });
  if (paused.length) {
    msg += `*Paused:*\n`;
    paused.forEach(m => { msg += `⏸️ ${m.targetName} (+${m.targetPhone})\n`; });
  }
  msg += `\n_Say "stop mission <number>" to end one._`;
  return msg.trim();
}

// ─── Generate opening message ─────────────────────────────────────────────────
async function generateOpeningMessage(task, targetName) {
  const prompt =
    `Task from EMEMZYVISUALS: ${task}\nRecipient: ${targetName || "the contact"}\n\n` +
    `Write a natural WhatsApp message. Sound like Ememzy — warm, direct, human. ` +
    `2-3 sentences max. Do NOT say "I'm a bot". Return ONLY the message text.`;
  return await askGroqDirect(getMasterPersonality(), prompt, []);
}

// ─── Generate reply to contact ────────────────────────────────────────────────
async function generateAgentReply(mission, contactReply) {
  const history = (mission.log||[]).slice(-8)
    .map(l => (l.role==="bot" ? "Ememzy: " : "Contact: ") + l.content)
    .join("\n");

  const b        = getRawBrain();
  const recentDM = (b.devConversations||[]).slice(-3)
    .map(c => (c.role==="user"?"Boss":"Me") + ": " + c.content).join("\n");

  const systemPrompt = getMasterPersonality(
    `AGENT MISSION: ${mission.task}\n\nConversation so far:\n${history}` +
    (recentDM ? `\n\nRecent DMs with boss:\n${recentDM}` : "")
  );

  const userPrompt =
    `The contact just replied: "${contactReply}"\n\n` +
    `Rules:\n` +
    `1. Stay on topic: "${mission.task}"\n` +
    `2. Sound like a real human (Ememzy), NOT a bot\n` +
    `3. Keep it short — 2-3 sentences max\n` +
    `4. Match their language (English/Pidgin/mix)\n` +
    `5. If mission goal achieved → add MISSION_COMPLETE on a new line\n` +
    `6. If contact is clearly unresponsive → add MISSION_PAUSE on a new line\n\n` +
    `Write your reply now:`;

  return await askGroqDirect(systemPrompt, userPrompt, []);
}

// ─── Report to boss ───────────────────────────────────────────────────────────
function buildReportMessage(mission, contactReply, botReply, isComplete) {
  const name = mission.targetName || mission.targetPhone;
  let msg = `📡 *Agent Report*\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `👤 *${name}* replied:\n_"${contactReply}"_\n\n`;
  msg += `🤖 *I replied:*\n_"${botReply}"_\n\n`;
  if (isComplete) {
    msg += `✅ *Mission complete!* Goal achieved with ${name}.\n`;
  } else {
    msg += `📊 ${(mission.log||[]).length} messages exchanged\n`;
    msg += `_Say "stop mission ${mission.targetPhone}" to end_`;
  }
  return msg;
}

// ─── Parse natural language mission trigger ───────────────────────────────────
function parseMissionFromText(text) {
  const numMatch = text.match(/(?:0|\+?234)([7-9][01]\d{8})/);
  let phone = numMatch ? "234" + numMatch[1] : null;
  const taskMatch = text.match(
    /(?:tell(?:ing)?(?:\s+\w+)?(?:\s+about)?|say(?:ing)?|ask(?:ing)?|inform(?:ing)?)\s+(.+)/i
  );
  const task = taskMatch ? taskMatch[1].trim() : null;
  return { phone, task };
}

module.exports = {
  parseMissionFromText, generateOpeningMessage, createMission,
  getActiveMission, generateAgentReply, logMessage,
  stopMission, pauseMission, resumeMission, listMissions,
  isSafeMessage, isOnTopic, buildReportMessage, normPhone,
  getMissions,
};
