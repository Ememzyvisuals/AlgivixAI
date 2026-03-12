/**
 * persist.js — AlgivixAI Persistent Memory across redeploys
 * ==========================================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * Saves EVERYTHING to disk so bot remembers after redeploy:
 * - Full DM conversation history with developer
 * - Group chat history (last 500 messages)
 * - Developer mood, lastImage reference, custom prefs
 * - Scheduled reminders
 * - Poll data
 * - Warning counts
 * - Agent missions
 * - Bot operational state (ghostMode, hypeMode etc)
 *
 * Auto-saves every 90 seconds + on every write
 */

const fs   = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "bot_brain.json");

function defaultBrain() {
  return {
    version: 2,
    // Developer DM history — survives redeploy
    devConversations: [],     // [{ role, content, time }]
    devMood: null,
    devPrefs: {},             // custom preferences bot learns
    // Group history
    groupHistory: [],         // last 500 msgs
    // Operational state
    ghostMode:  false,
    hypeMode:   false,
    lockdown:   false,
    busyMode:   false,
    busyMessage: "",
    // Reminders [{ id, message, date, devJid, done }]
    reminders: [],
    // Polls { pollId: { ... } }
    polls: {},
    // Warnings { phone: { count, log } }
    warnings: {},
    // Agent missions { phone: { ... } }
    missions: {},
    // Last known status for context
    lastStatusPosted: null,
    // Stats
    totalMessages: 0,
    startDate: new Date().toISOString(),
    lastRestart: new Date().toISOString(),
  };
}

class BrainStore {
  constructor() {
    this._data = this._load();
    this._dirty = false;
    // Auto-save every 90 seconds
    setInterval(() => { if (this._dirty) this._save(); }, 90000);
    console.log(`[Brain] ✅ Loaded — ${this._data.devConversations.length} DM history, ${this._data.groupHistory.length} group msgs`);
  }

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw  = fs.readFileSync(DATA_FILE, "utf8");
        const saved = JSON.parse(raw);
        // Deep merge with defaults so new fields always exist
        const def = defaultBrain();
        return { ...def, ...saved };
      }
    } catch (e) {
      console.error("[Brain] Load error:", e.message);
    }
    return defaultBrain();
  }

  _save() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(this._data, null, 2));
      this._dirty = false;
    } catch (e) {
      console.error("[Brain] Save error:", e.message);
    }
  }

  // Force immediate save (use after critical changes)
  save() { this._save(); }

  // ── Developer DM History ──────────────────────────────────────────────────
  addDevMessage(role, content) {
    this._data.devConversations.push({ role, content, time: Date.now() });
    if (this._data.devConversations.length > 120) {
      this._data.devConversations = this._data.devConversations.slice(-120);
    }
    this._dirty = true;
    this._save(); // save immediately — conversations are critical
  }

  getDevHistory(limit = 20) {
    return this._data.devConversations
      .slice(-limit)
      .map(c => ({ role: c.role, content: c.content }));
  }

  getFullDevHistory() { return this._data.devConversations; }

  // ── Dev mood / prefs ─────────────────────────────────────────────────────
  setDevMood(mood) { this._data.devMood = mood; this._dirty = true; }
  getDevMood()     { return this._data.devMood; }
  setPref(k, v)    { this._data.devPrefs[k] = v; this._dirty = true; }
  getPref(k)       { return this._data.devPrefs[k]; }

  // ── Group History ─────────────────────────────────────────────────────────
  addGroupMessage(phone, name, text) {
    this._data.groupHistory.push({ phone, name: name || phone, text, time: Date.now() });
    if (this._data.groupHistory.length > 500) {
      this._data.groupHistory = this._data.groupHistory.slice(-500);
    }
    this._data.totalMessages++;
    this._dirty = true;
  }

  getGroupHistory(limit = 30) {
    return this._data.groupHistory.slice(-limit);
  }

  getGroupHistoryForDigest() {
    // Return today's messages only
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return this._data.groupHistory.filter(m => m.time >= todayStart.getTime());
  }

  // ── Modes ─────────────────────────────────────────────────────────────────
  get ghostMode()  { return this._data.ghostMode; }
  get hypeMode()   { return this._data.hypeMode; }
  get lockdown()   { return this._data.lockdown; }
  toggleGhost()    { this._data.ghostMode  = !this._data.ghostMode;  this._save(); return this._data.ghostMode; }
  toggleHype()     { this._data.hypeMode   = !this._data.hypeMode;   this._save(); return this._data.hypeMode; }
  toggleLockdown() { this._data.lockdown   = !this._data.lockdown;   this._save(); return this._data.lockdown; }

  setBusy(msg)     { this._data.busyMode = true;  this._data.busyMessage = msg; this._save(); }
  clearBusy()      { this._data.busyMode = false; this._data.busyMessage = "";  this._save(); }
  isBusy()         { return this._data.busyMode; }
  getBusyMsg()     { return this._data.busyMessage; }

  // ── Reminders ──────────────────────────────────────────────────────────────
  addReminder(message, date, devJid) {
    const id = "R" + Date.now();
    this._data.reminders.push({ id, message, date, devJid, done: false, created: new Date().toISOString() });
    this._save();
    return id;
  }

  getDueReminders() {
    const now = new Date();
    const due = this._data.reminders.filter(r => !r.done && new Date(r.date) <= now);
    due.forEach(r => r.done = true);
    if (due.length) this._save();
    return due;
  }

  listReminders() {
    return this._data.reminders.filter(r => !r.done);
  }

  // ── Polls ──────────────────────────────────────────────────────────────────
  createPoll(question, options, groupJid, durationHours = 24) {
    const id     = "P" + Date.now();
    const endsAt = new Date(Date.now() + durationHours * 3600000).toISOString();
    this._data.polls[id] = { id, question, options, votes: {}, groupJid, endsAt, active: true, created: new Date().toISOString() };
    this._save();
    return this._data.polls[id];
  }

  getActivePoll(groupJid) {
    return Object.values(this._data.polls).find(p => p.active && p.groupJid === groupJid) || null;
  }

  castVote(pollId, phone, optionIndex) {
    const poll = this._data.polls[pollId];
    if (!poll || !poll.active) return { error: "No active poll" };
    if (optionIndex < 0 || optionIndex >= poll.options.length) return { error: "Invalid option" };
    const changed = poll.votes[phone] !== undefined;
    poll.votes[phone] = optionIndex;
    this._save();
    return { success: true, changed };
  }

  closePoll(pollId) {
    if (this._data.polls[pollId]) {
      this._data.polls[pollId].active = false;
      this._save();
    }
    return this.getPollResults(pollId);
  }

  getPollResults(pollId) {
    const poll = this._data.polls[pollId];
    if (!poll) return null;
    const counts = poll.options.map(() => 0);
    Object.values(poll.votes).forEach(v => counts[v]++);
    const total  = Object.keys(poll.votes).length;
    const winner = counts.indexOf(Math.max(...counts));
    return { poll, counts, total, winner };
  }

  getExpiredPolls() {
    const now = new Date();
    return Object.values(this._data.polls).filter(p => p.active && new Date(p.endsAt) <= now);
  }

  // ── Warnings ───────────────────────────────────────────────────────────────
  addWarning(phone, reason, issuedBy) {
    if (!this._data.warnings[phone]) this._data.warnings[phone] = { count: 0, log: [] };
    this._data.warnings[phone].count++;
    this._data.warnings[phone].log.push({ reason, issuedBy, time: new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" }) });
    this._save();
    return { count: this._data.warnings[phone].count, shouldKick: this._data.warnings[phone].count >= 3 };
  }

  getWarnings(phone) { return this._data.warnings[phone] || { count: 0, log: [] }; }
  clearWarnings(phone) { this._data.warnings[phone] = { count: 0, log: [] }; this._save(); }

  // ── Agent Missions ─────────────────────────────────────────────────────────
  saveMission(phone, mission) {
    this._data.missions[phone] = mission;
    this._save();
  }

  getMission(phone) { return this._data.missions[phone] || null; }

  updateMissionLog(phone, role, content) {
    if (this._data.missions[phone]) {
      this._data.missions[phone].log = this._data.missions[phone].log || [];
      this._data.missions[phone].log.push({ role, content, time: new Date().toISOString() });
      this._save();
    }
  }

  stopMission(phone) {
    if (this._data.missions[phone]) {
      this._data.missions[phone].status = "stopped";
      this._save();
      return true;
    }
    return false;
  }

  getActiveMissions() {
    return Object.values(this._data.missions).filter(m => m.status === "active");
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  getStats() {
    return {
      totalMessages:    this._data.totalMessages,
      devConversations: this._data.devConversations.length,
      groupHistory:     this._data.groupHistory.length,
      reminders:        this._data.reminders.filter(r => !r.done).length,
      activePolls:      Object.values(this._data.polls).filter(p => p.active).length,
      activeMissions:   this.getActiveMissions().length,
      startDate:        this._data.startDate,
      lastRestart:      this._data.lastRestart,
    };
  }

  recordRestart() {
    this._data.lastRestart = new Date().toISOString();
    this._save();
  }
}

const brain = new BrainStore();
module.exports = { brain };
