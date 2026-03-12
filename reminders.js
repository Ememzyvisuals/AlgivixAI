/**
 * reminders.js — AlgivixAI Reminder, Poll, Warn & Digest System
 * ==============================================================
 * Developer: EMEMZYVISUALS DIGITALS
 */

const fs   = require("fs");
const path = require("path");
const https = require("https");

const REMINDERS_FILE = path.join(__dirname, "reminders.json");
const POLLS_FILE     = path.join(__dirname, "polls.json");
const WARNS_FILE     = path.join(__dirname, "warnings.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function load(file)       { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }
function save(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {} }
function fmt(t)           { return `*${t}*`; }

// ═══════════════════════════════════════════════════════════
// REMINDER SYSTEM
// ═══════════════════════════════════════════════════════════

function addReminder({ message, date, devJid }) {
  const data = load(REMINDERS_FILE);
  if (!data.reminders) data.reminders = [];
  const id = "R" + Date.now();
  data.reminders.push({ id, message, date, devJid, done: false, created: new Date().toISOString() });
  save(REMINDERS_FILE, data);
  return id;
}

function getDueReminders() {
  const data  = load(REMINDERS_FILE);
  if (!data.reminders) return [];
  const now   = new Date();
  const due   = data.reminders.filter(r => !r.done && new Date(r.date) <= now);
  // Mark as done
  due.forEach(r => r.done = true);
  save(REMINDERS_FILE, data);
  return due;
}

function listReminders() {
  const data = load(REMINDERS_FILE);
  const upcoming = (data.reminders || []).filter(r => !r.done);
  if (!upcoming.length) return "📅 No upcoming reminders.";
  let msg = `📅 ${fmt("Upcoming Reminders:")}\n━━━━━━━━━━━━━━━━━━━━\n`;
  upcoming.forEach((r, i) => {
    const d = new Date(r.date).toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
    msg += `${i+1}. ${r.message}\n   ⏰ ${d}\n\n`;
  });
  return msg.trim();
}

// Parse reminder from natural language
// "Remind me on March 20 that Cyrus birthday" or "Remind me in 2 hours to push code"
function parseReminder(text) {
  // "remind me on YYYY-MM-DD" or "remind me on March 20"
  const dateMatch = text.match(/remind\s+me\s+(?:on\s+)?(.+?)\s+(?:that|to|about)\s+(.+)/i);
  if (!dateMatch) return null;

  const rawDate = dateMatch[1].trim();
  const message = dateMatch[2].trim();

  // Parse relative times
  let date = null;
  const inMatch = rawDate.match(/in\s+(\d+)\s+(minute|hour|day|week)s?/i);
  if (inMatch) {
    const num  = parseInt(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    date = new Date();
    if (unit === "minute") date.setMinutes(date.getMinutes() + num);
    if (unit === "hour")   date.setHours(date.getHours() + num);
    if (unit === "day")    date.setDate(date.getDate() + num);
    if (unit === "week")   date.setDate(date.getDate() + num * 7);
  } else {
    // Try to parse absolute date
    const parsed = new Date(rawDate + " 2026");
    date = isNaN(parsed) ? new Date(rawDate) : parsed;
    if (isNaN(date)) return null;
    // Default to 9AM WAT if no time specified
    if (date.getHours() === 0) date.setHours(8);
  }

  if (!date || isNaN(date)) return null;
  return { message, date: date.toISOString() };
}

// ═══════════════════════════════════════════════════════════
// POLL SYSTEM
// ═══════════════════════════════════════════════════════════

function createPoll(question, options, groupJid, durationHours = 24) {
  const data = load(POLLS_FILE);
  if (!data.polls) data.polls = {};

  const id = "P" + Date.now();
  const endsAt = new Date(Date.now() + durationHours * 3600000).toISOString();

  data.polls[id] = {
    id, question, options,
    votes: {}, // { phone: optionIndex }
    groupJid, endsAt,
    active: true,
    created: new Date().toISOString(),
  };
  save(POLLS_FILE, data);
  return data.polls[id];
}

function getActivePoll(groupJid) {
  const data = load(POLLS_FILE);
  return Object.values(data.polls || {}).find(p => p.active && p.groupJid === groupJid) || null;
}

function castVote(pollId, phone, optionIndex) {
  const data = load(POLLS_FILE);
  const poll = data.polls?.[pollId];
  if (!poll || !poll.active) return { error: "No active poll" };
  if (optionIndex < 0 || optionIndex >= poll.options.length) return { error: "Invalid option" };
  const already = poll.votes[phone];
  poll.votes[phone] = optionIndex;
  save(POLLS_FILE, data);
  return { success: true, changed: already !== undefined };
}

function getPollResults(pollId) {
  const data = load(POLLS_FILE);
  const poll = data.polls?.[pollId];
  if (!poll) return null;

  const counts = poll.options.map(() => 0);
  Object.values(poll.votes).forEach(v => counts[v]++);
  const total  = Object.keys(poll.votes).length;
  const winner = counts.indexOf(Math.max(...counts));

  return { poll, counts, total, winner };
}

function closePoll(pollId) {
  const data = load(POLLS_FILE);
  if (data.polls?.[pollId]) {
    data.polls[pollId].active = false;
    save(POLLS_FILE, data);
  }
  return getPollResults(pollId);
}

function buildPollMessage(poll) {
  let msg = `📊 ${fmt("POLL: " + poll.question)}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  poll.options.forEach((opt, i) => {
    msg += `${i+1}️⃣ ${opt}\n`;
  });
  const endsAt = new Date(poll.endsAt).toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "short", timeStyle: "short" });
  msg += `\n⏰ Closes: ${endsAt}\n`;
  msg += `_Reply with a number (1-${poll.options.length}) to vote!_`;
  return msg;
}

function buildResultsMessage(results) {
  if (!results) return "❌ Poll not found.";
  const { poll, counts, total, winner } = results;
  const bar = (count) => "█".repeat(Math.round((count / Math.max(total, 1)) * 10)) || "░";

  let msg = `📊 ${fmt("POLL RESULTS: " + poll.question)}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  poll.options.forEach((opt, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const crown = i === winner ? " 👑" : "";
    msg += `${i+1}. ${opt}${crown}\n   ${bar(counts[i])} ${counts[i]} votes (${pct}%)\n\n`;
  });
  msg += `👥 Total votes: ${fmt(total)}\n`;
  msg += `🏆 Winner: ${fmt(poll.options[winner])}`;
  return msg;
}

function getExpiredPolls() {
  const data = load(POLLS_FILE);
  const now  = new Date();
  return Object.values(data.polls || {}).filter(p => p.active && new Date(p.endsAt) <= now);
}

// ═══════════════════════════════════════════════════════════
// WARNING SYSTEM
// ═══════════════════════════════════════════════════════════

const MAX_WARNINGS = 3;

function addWarning(phone, reason, issuedBy) {
  const data = load(WARNS_FILE);
  if (!data.warnings) data.warnings = {};
  if (!data.warnings[phone]) data.warnings[phone] = { count: 0, log: [] };

  data.warnings[phone].count++;
  data.warnings[phone].log.push({
    reason, issuedBy,
    time: new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "short", timeStyle: "short" }),
  });
  save(WARNS_FILE, data);

  return {
    count:     data.warnings[phone].count,
    shouldKick: data.warnings[phone].count >= MAX_WARNINGS,
  };
}

function getWarnings(phone) {
  const data = load(WARNS_FILE);
  return data.warnings?.[phone] || { count: 0, log: [] };
}

function clearWarnings(phone) {
  const data = load(WARNS_FILE);
  if (data.warnings?.[phone]) {
    data.warnings[phone] = { count: 0, log: [] };
    save(WARNS_FILE, data);
  }
}

function buildWarnMessage(phone, reason, count) {
  const strikes = "⚠️".repeat(count) + (count < MAX_WARNINGS ? "🔘".repeat(MAX_WARNINGS - count) : "");
  return `⚠️ ${fmt("Warning issued to @" + phone)}\n━━━━━━━━━━━━━━━━━━━━\n` +
    `Reason: ${reason}\n\n` +
    `${strikes} Warning ${count}/${MAX_WARNINGS}\n\n` +
    (count >= MAX_WARNINGS
      ? `🚨 ${fmt("3 strikes reached — removing from group!")}`
      : `_${MAX_WARNINGS - count} more warning(s) before removal_`);
}

// ═══════════════════════════════════════════════════════════
// GROUP DIGEST (nightly summary)
// ═══════════════════════════════════════════════════════════

async function generateGroupDigest(groupHistory, memberStats) {
  if (!groupHistory || groupHistory.length < 3) {
    return "_No significant activity today to summarize._";
  }

  // Build context from today's messages only
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayMsgs = groupHistory.filter(m => m.time >= todayStart.getTime());
  if (todayMsgs.length < 2) return "_Quiet day in the group — nothing major to report._";

  const context = todayMsgs.slice(-80)
    .map(m => `${m.name || m.phone}: ${m.text}`)
    .join("\n");

  // Most active members today
  const activity = {};
  todayMsgs.forEach(m => {
    if (m.phone !== "BOT") activity[m.name || m.phone] = (activity[m.name || m.phone] || 0) + 1;
  });
  const topMembers = Object.entries(activity).sort((a, b) => b[1] - a[1]).slice(0, 3);

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `You are AlgivixAI summarizing the Algivix Dev Team WhatsApp group for the day.

Today's messages:
${context}

Most active today: ${topMembers.map(([n,c]) => n + " (" + c + " msgs)").join(", ")}

Write a concise nightly digest for the developer (EMEMZYVISUALS DIGITALS) covering:
1. Key topics/discussions today
2. Any decisions made or tasks mentioned
3. Who was most active
4. Any issues or drama
5. Overall vibe/mood

Use *bold* for section headers. Keep it under 200 words. Be direct and useful.`
      }]
    });

    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.GROQ_API_KEY,
        "Content-Length": Buffer.byteLength(body),
      }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d).choices?.[0]?.message?.content?.trim() || "_Digest unavailable_"); }
        catch { resolve("_Digest generation failed_"); }
      });
    });
    req.on("error", () => resolve("_Digest generation failed_"));
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
// AUTO-REPLY WHEN BUSY
// ═══════════════════════════════════════════════════════════

const busyState = { active: false, message: "", startTime: null };

function setBusy(message) {
  busyState.active    = true;
  busyState.message   = message || "I'm currently unavailable. I'll get back to you soon.";
  busyState.startTime = Date.now();
}

function clearBusy() {
  busyState.active  = false;
  busyState.message = "";
}

function isBusy()         { return busyState.active; }
function getBusyMessage() { return busyState.message; }

module.exports = {
  // Reminders
  addReminder, getDueReminders, listReminders, parseReminder,
  // Polls
  createPoll, getActivePoll, castVote, closePoll,
  buildPollMessage, buildResultsMessage, getExpiredPolls, getPollResults,
  // Warnings
  addWarning, getWarnings, clearWarnings, buildWarnMessage, MAX_WARNINGS,
  // Digest
  generateGroupDigest,
  // Busy
  setBusy, clearBusy, isBusy, getBusyMessage,
};
