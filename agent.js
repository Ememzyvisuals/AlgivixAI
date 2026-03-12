/**
 * agent.js — AlgivixAI Personal WhatsApp Agent v2
 * =================================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * Uses the UNIFIED BRAIN (ai.js bot_brain.json) so:
 * - All missions survive redeploys
 * - Agent knows full DM + group history
 * - Agent shares same personality as text/vision/imagegen
 * - Every sent/received message logged to allMemory
 */

const https = require("https");
const {
  getRawBrain, setBrainField, persistBrain,
  askGroqDirect, getMasterPersonality,
  addDevMessage, addGroupMessage,
} = require("./ai");

// ─── Mission helpers using unified brain ──────────────────────────────────────
function getMissions()            { return getRawBrain().missions || {}; }
function saveMissions(missions)   { setBrainField("missions", missions); }

function getActiveMission(phone) {
  const missions = getMissions();
  const norm     = normPhone(phone);
  return missions[norm] || missions[phone] || null;
}

function normPhone(phone) {
  return phone.replace(/\D/g, "").replace(/^0(\d{10})$/, "234$1");
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
  const missions = getMissions();
  const norm     = normPhone(targetPhone);
  const id       = "M" + Date.now();

  missions[norm] = {
    id, targetPhone: norm, targetName: targetName || norm,
    task, devJid,
    status:        "active",
    startTime:     new Date().toISOString(),
    openingMessage,
    topicKeywords: extractTopicKeywords(task),
    log: [{ role: "bot", content: openingMessage, time: new Date().toISOString() }],
  };
  saveMissions(missions);

  // Also log to allMemory so the unified brain knows
  const b = getRawBrain();
  b.allMemory = b.allMemory || [];
  b.allMemory.push({
    model: "agent", role: "assistant",
    content: `Started mission to ${targetName||norm}: "${task}"`,
    time: Date.now(),
  });
  if (b.allMemory.length > 300) b.allMemory = b.allMemory.slice(-300);
  persistBrain();

  return missions[norm];
}

// ─── Log message to mission ───────────────────────────────────────────────────
function logMessage(targetPhone, role, content) {
  const missions = getMissions();
  const norm     = normPhone(targetPhone);
  const mission  = missions[norm] || missions[targetPhone];
  if (!mission) return;
  mission.log = mission.log || [];
  mission.log.push({ role, content, time: new Date().toISOString() });
  saveMissions(missions);
  // Log to unified allMemory
  const b = getRawBrain();
  b.allMemory = b.allMemory || [];
  b.allMemory.push({ model: "agent", role, content: `[${mission.targetName}] ${content.slice(0,150)}`, time: Date.now() });
  if (b.allMemory.length > 300) b.allMemory = b.allMemory.slice(-300);
  persistBrain();
}

// ─── Stop / Pause / Resume ────────────────────────────────────────────────────
function stopMission(phone) {
  const missions = getMissions();
  const norm = normPhone(phone);
  if (missions[norm])    { missions[norm].status = "stopped";  saveMissions(missions); return true; }
  if (missions[phone])   { missions[phone].status = "stopped"; saveMissions(missions); return true; }
  return false;
}

function pauseMission(phone) {
  const missions = getMissions();
  const norm = normPhone(phone);
  const m = missions[norm] || missions[phone];
  if (m) { m.status = "paused"; saveMissions(missions); }
}

function resumeMission(phone) {
  const missions = getMissions();
  const norm = normPhone(phone);
  const m = missions[norm] || missions[phone];
  if (m) { m.status = "active"; saveMissions(missions); }
}

// ─── List missions ────────────────────────────────────────────────────────────
function listMissions() {
  const all    = Object.values(getMissions());
  const active = all.filter(m => m.status === "active");
  const paused = all.filter(m => m.status === "paused");
  if (!active.length && !paused.length) return "📋 No active missions right now.";

  let msg = "*📋 Active Agent Missions:*\n━━━━━━━━━━━━━━━━━━━━\n";
  active.forEach((m, i) => {
    msg += `${i+1}. 🟢 *${m.targetName}* (+${m.targetPhone})\n   _${m.task.slice(0, 60)}_\n   💬 ${(m.log||[]).length} messages\n\n`;
  });
  paused.forEach((m, i) => {
    msg += `• ⏸️ *${m.targetName}* (paused)\n`;
  });
  return msg.trim();
}

// ─── Generate opening message ─────────────────────────────────────────────────
async function generateOpeningMessage(task, targetName) {
  // Uses full master personality — same brain, same tone
  const prompt =
    `Task from EMEMZYVISUALS: ${task}\nRecipient: ${targetName || "the contact"}\n\n` +
    `Write a natural WhatsApp opening message. Sound like Ememzy personally — warm, direct, human. ` +
    `2-3 sentences max. Do NOT say "I'm a bot" or "on behalf of". Just write the message as if you ARE Ememzy. ` +
    `Return ONLY the message text.`;

  return await askGroqDirect(getMasterPersonality(), prompt, []);
}

// ─── Generate reply to contact ────────────────────────────────────────────────
async function generateAgentReply(mission, contactReply) {
  const history = (mission.log || []).slice(-8).map(l =>
    (l.role === "bot" ? "Ememzy (me): " : "Contact: ") + l.content
  ).join("\n");

  // Read shared brain for full context
  const b       = getRawBrain();
  const recentDM = b.devConversations.slice(-3).map(c =>
    (c.role === "user" ? "Boss" : "Me") + ": " + c.content
  ).join("\n");

  const systemPrompt = getMasterPersonality(
    `AGENT MISSION: ${mission.task}\n\nMission conversation so far:\n${history}` +
    (recentDM ? `\n\nRecent DMs with boss for context:\n${recentDM}` : "")
  );

  const userPrompt =
    `The contact just replied: "${contactReply}"\n\n` +
    `Rules:\n` +
    `1. Stay STRICTLY on the mission topic: "${mission.task}"\n` +
    `2. Never send abuse, threats, or inappropriate content\n` +
    `3. Sound like a real person (Ememzy), not a bot\n` +
    `4. Keep replies short for WhatsApp (2-3 sentences)\n` +
    `5. If mission goal achieved → add MISSION_COMPLETE on a new line\n` +
    `6. If contact is clearly unresponsive/busy → add MISSION_PAUSE on a new line\n` +
    `7. If contact goes off-topic → politely redirect back\n` +
    `8. Match their language (English/Pidgin/mix)\n\n` +
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
    msg += `_Say "stop mission ${mission.targetPhone}" to fully end_`;
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
    /(?:tell(?:ing)?(?:\s+him\/her|\s+him|\s+her|\s+them)?(?:\s+about)?|say(?:ing)?|ask(?:ing)?|inform(?:ing)?|message\s+\w+\s+(?:and\s+)?(?:ask|tell|say|inform))\s+(.+)/i
  );
  const task = taskMatch ? taskMatch[1].trim() : null;
  return { phone, task };
}

module.exports = {
  parseMissionFromText,
  generateOpeningMessage,
  createMission,
  getActiveMission,
  generateAgentReply,
  logMessage,
  stopMission,
  pauseMission,
  resumeMission,
  listMissions,
  isSafeMessage,
  isOnTopic,
  buildReportMessage,
  normPhone,
};
