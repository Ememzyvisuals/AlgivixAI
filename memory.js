/**
 * memory.js - AlgivixAI Persistent Memory System
 * ================================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * Saves everything to memory.json so bot remembers
 * across restarts, redeploys, and crashes.
 *
 * Remembers:
 * - Every conversation (group + DM)
 * - Member activity & moods
 * - Trivia scores
 * - MVP history
 * - Developer DM history
 * - Inactive tracking
 * - Group context (last 200 messages)
 */

const fs   = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "bot_memory.json");

// ─── Default State ────────────────────────────────────────────────────────────
function defaultState() {
  return {
    // Group conversation history — last 200 messages
    groupHistory: [],

    // Per-member data
    members: {},
    // { phone: { name, lastSeen, messageCount, moods: [], warnings: 0 } }

    // Developer DM full history
    devConversations: [],

    // Trivia
    triviaScores: {},
    triviaStreaks: {},

    // MVP weekly
    mvpVotes: {},
    mvpHistory: [], // [{ week, winner, score }]

    // Mood tracking
    moodHistory: [],

    // Bot state
    ghostMode:  false,
    hypeMode:   false,
    lockdown:   false,
    ignoreList: [],

    // Stats
    totalMessagesProcessed: 0,
    startDate: new Date().toISOString(),
  };
}

// ─── Load / Save ──────────────────────────────────────────────────────────────
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw   = fs.readFileSync(MEMORY_FILE, "utf8");
      const saved = JSON.parse(raw);
      // Merge with defaults to handle new fields
      return { ...defaultState(), ...saved };
    }
  } catch (e) {
    console.error("[Memory] Load error:", e.message);
  }
  return defaultState();
}

function saveMemory(state) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[Memory] Save error:", e.message);
  }
}

// ─── Memory Manager ───────────────────────────────────────────────────────────
class MemoryManager {
  constructor() {
    this.state = loadMemory();
    console.log(`[Memory] ✅ Loaded — ${this.state.groupHistory.length} messages, ${Object.keys(this.state.members).length} members`);

    // Auto-save every 2 minutes
    setInterval(() => this.save(), 2 * 60 * 1000);
  }

  save() { saveMemory(this.state); }

  // ── Group Message ────────────────────────────────────────────────────────────
  recordGroupMessage(phone, name, text) {
    const entry = { phone, name: name || phone, text, time: Date.now() };
    this.state.groupHistory.push(entry);
    if (this.state.groupHistory.length > 200) this.state.groupHistory.shift();

    // Update member data
    if (!this.state.members[phone]) {
      this.state.members[phone] = { name: name || phone, lastSeen: Date.now(), messageCount: 0, moods: [], warnings: 0 };
    }
    this.state.members[phone].lastSeen     = Date.now();
    this.state.members[phone].messageCount = (this.state.members[phone].messageCount || 0) + 1;
    if (name) this.state.members[phone].name = name;

    // MVP tracking
    this.state.mvpVotes[phone] = (this.state.mvpVotes[phone] || 0) + 1;
    this.state.totalMessagesProcessed++;
  }

  // ── Dev DM ───────────────────────────────────────────────────────────────────
  recordDevMessage(role, text) {
    this.state.devConversations.push({ role, text, time: Date.now() });
    if (this.state.devConversations.length > 100) this.state.devConversations.shift();
  }

  // Get recent DM history formatted for AI
  getDevHistory(limit = 15) {
    return this.state.devConversations
      .slice(-limit)
      .map(c => ({ role: c.role, content: c.text }));
  }

  // ── Group Context for AI ──────────────────────────────────────────────────────
  getGroupContext(limit = 20) {
    return this.state.groupHistory
      .slice(-limit)
      .map(m => `${m.name || m.phone}: ${m.text}`)
      .join("\n");
  }

  // Get last N messages from a specific phone
  getMemberHistory(phone, limit = 10) {
    return this.state.groupHistory
      .filter(m => m.phone === phone)
      .slice(-limit);
  }

  // ── Conversation Context (for "explain again" type messages) ─────────────────
  getConversationContext(phone, limit = 6) {
    // Get recent group messages involving this phone or bot replies near them
    const recent = this.state.groupHistory.slice(-30);
    const relevant = [];
    for (let i = 0; i < recent.length; i++) {
      if (recent[i].phone === phone) relevant.push(recent[i]);
      if (recent[i].phone === "BOT" && i > 0 && recent[i-1].phone === phone) relevant.push(recent[i]);
    }
    return relevant.slice(-limit).map(m => `${m.name || m.phone}: ${m.text}`).join("\n");
  }

  // Record bot reply in group
  recordBotReply(text) {
    this.state.groupHistory.push({ phone: "BOT", name: "AlgivixAI", text, time: Date.now() });
    if (this.state.groupHistory.length > 200) this.state.groupHistory.shift();
  }

  // ── Trivia ───────────────────────────────────────────────────────────────────
  addTriviaPoint(phone) {
    this.state.triviaScores[phone] = (this.state.triviaScores[phone] || 0) + 1;
    this.state.triviaStreaks[phone] = (this.state.triviaStreaks[phone] || 0) + 1;
    return { score: this.state.triviaScores[phone], streak: this.state.triviaStreaks[phone] };
  }

  resetStreak(phone) { this.state.triviaStreaks[phone] = 0; }

  getTriviaLeaderboard() { return { ...this.state.triviaScores }; }

  // ── Member Activity ───────────────────────────────────────────────────────────
  getInactiveMembers(hoursThreshold = 26) {
    const now = Date.now();
    const threshold = hoursThreshold * 3600000;
    return Object.entries(this.state.members)
      .filter(([phone, data]) => {
        if (phone === "BOT") return false;
        return data.lastSeen && (now - data.lastSeen > threshold);
      })
      .map(([phone, data]) => ({
        phone,
        name: data.name,
        hoursAgo: Math.floor((now - data.lastSeen) / 3600000),
      }));
  }

  updateLastSeen(phone) {
    if (!this.state.members[phone]) this.state.members[phone] = { lastSeen: Date.now(), messageCount: 0 };
    this.state.members[phone].lastSeen = Date.now();
  }

  getMemberLastSeen(phone) {
    return this.state.members[phone]?.lastSeen || null;
  }

  // ── MVP ───────────────────────────────────────────────────────────────────────
  getMVP() {
    const votes = this.state.mvpVotes;
    if (Object.keys(votes).length === 0) return null;
    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    return { phone: sorted[0][0], count: sorted[0][1], name: this.state.members[sorted[0][0]]?.name };
  }

  resetMVPVotes() { this.state.mvpVotes = {}; }

  // ── Mode flags ────────────────────────────────────────────────────────────────
  get ghostMode()  { return this.state.ghostMode; }
  get hypeMode()   { return this.state.hypeMode; }
  get lockdown()   { return this.state.lockdown; }
  get ignoreList() { return this.state.ignoreList || []; }

  toggleGhost()    { this.state.ghostMode  = !this.state.ghostMode;  this.save(); return this.state.ghostMode; }
  toggleHype()     { this.state.hypeMode   = !this.state.hypeMode;   this.save(); return this.state.hypeMode; }
  toggleLockdown() { this.state.lockdown   = !this.state.lockdown;   this.save(); return this.state.lockdown; }

  addIgnore(phone)    { if (!this.state.ignoreList.includes(phone)) { this.state.ignoreList.push(phone); this.save(); } }
  removeIgnore(phone) { this.state.ignoreList = this.state.ignoreList.filter(p => p !== phone); this.save(); }
  isIgnored(phone)    { return (this.state.ignoreList || []).includes(phone); }

  nukeWarnings() {
    Object.keys(this.state.members).forEach(p => { if (this.state.members[p]) this.state.members[p].warnings = 0; });
    this.save();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────
  getStats() {
    return {
      totalMessages:  this.state.totalMessagesProcessed,
      totalMembers:   Object.keys(this.state.members).length,
      triviaPlayers:  Object.keys(this.state.triviaScores).length,
      moodEntries:    this.state.moodHistory.length,
      ghostMode:      this.state.ghostMode,
      hypeMode:       this.state.hypeMode,
      lockdown:       this.state.lockdown,
      ignoreCount:    (this.state.ignoreList || []).length,
      startDate:      this.state.startDate,
    };
  }
}

const memoryManager = new MemoryManager();

module.exports = { memoryManager };
