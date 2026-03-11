/**
 * commands.js - AlgivixAI Command Handler
 * Developer: EMEMZYVISUALS DIGITALS
 * 
 * HARDENED: Every function wrapped in try/catch
 * so one crash never takes down the whole bot.
 */

const fs   = require("fs");
const path = require("path");
const {
  startTrivia, getTriviaLeaderboard, generateMVPAnnouncement,
  generatePerformanceReport, generateWeeklySummary, startMoodCheck,
  getMoodSummary, generateRoast, startMeeting, endMeeting, addHype,
} = require("./features");

const { askGroq, looksLikeCode } = require("./ai");

// ─── Safe JSON Loader ─────────────────────────────────────────────────────────
function loadJSON(filename) {
  try {
    const filePath = path.join(__dirname, filename);
    const raw      = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[Commands] ❌ Failed to load ${filename}:`, err.message);
    return null;
  }
}

// ─── Developer Credit ─────────────────────────────────────────────────────────
const CREDIT_TRIGGERS = [
  "who developed you", "who created you", "who made you",
  "who built you", "your developer", "your creator",
  "who programmed you", "who is your maker",
];

function isAskingAboutDeveloper(text) {
  try {
    const lower = text.toLowerCase();
    return CREDIT_TRIGGERS.some(t => lower.includes(t));
  } catch { return false; }
}

function handleDeveloperCredit() {
  const praises = [
    `👨‍💻 *About AlgivixAI*\n━━━━━━━━━━━━━━━━━━━━\nBuilt by an absolute legend:\n\n🏆 *EMEMZYVISUALS DIGITALS*\n_One of the most talented AI automation developers out there!_\n\nBuilt with ❤️ passion and pure skill for the Algivix Dev Team.\n⚡ Powered by Groq AI (70B parameters) + Baileys WhatsApp SDK.\n\n🔥 Watch out for this developer — going places! 🚀`,
    `🤖 *Who Made Me?*\n━━━━━━━━━━━━━━━━━━━━\n🌟 *EMEMZYVISUALS DIGITALS* — my creator!\n\n_They didn't just build a bot — they built an autonomous AI assistant that runs 24/7!_\n\nNext level development! 💪🔥`,
    `👑 *My Developer*\n━━━━━━━━━━━━━━━━━━━━\nBig respect to *EMEMZYVISUALS DIGITALS*!\n\n✅ Built me from scratch\n✅ Integrated 70 Billion parameter AI\n✅ Deployed me on the cloud\n✅ Made me fully autonomous\n\n_Pure genius at work!_ 🧠🚀`,
  ];
  return praises[Math.floor(Math.random() * praises.length)];
}

// ─── !help ────────────────────────────────────────────────────────────────────
function handleHelp() {
  try {
    return (
      `🤖 *AlgivixAI — Command Guide*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*!ai <question>* — Ask AI anything dev-related\n` +
      `*!review <code>* — Get AI code review\n` +
      `*!task* — View current sprint tasks\n` +
      `*!rules* — View group rules\n` +
      `*!announce <msg>* — Post announcement (admin)\n` +
      `*!help* — Show this guide\n\n` +
      `💡 Also try: "Who developed you?"\n` +
      `📢 Admins: DM me *!broadcast <msg>* to post from anywhere!`
    );
  } catch (err) {
    console.error("[handleHelp]", err.message);
    return "❓ Help is temporarily unavailable.";
  }
}

// ─── !rules ───────────────────────────────────────────────────────────────────
function handleRules() {
  try {
    const data = loadJSON("rules.json");
    if (!data || !data.rules) return "❌ Rules not available. Please contact an admin.";

    let msg = `📋 *Algivix Dev Team — Group Rules*\n━━━━━━━━━━━━━━━━━━━━\n`;
    data.rules.forEach(rule => { msg += `${rule}\n`; });
    msg += `\n✅ Follow these rules to keep our community great!`;
    return msg;
  } catch (err) {
    console.error("[handleRules]", err.message);
    return "❌ Could not load rules right now.";
  }
}

// ─── !task ────────────────────────────────────────────────────────────────────
function handleTask() {
  try {
    const data = loadJSON("tasks.json");
    if (!data || !data.tasks) return "❌ Tasks not available. Please contact an admin.";

    const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢" };
    const statusEmoji   = { pending: "⏳", "in-progress": "🔄", done: "✅" };

    let msg = `📌 *Sprint Tasks — Algivix Dev Team*\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg    += `🎯 *Goal:* ${data.weeklyGoal}\n\n`;

    data.tasks.forEach((task, i) => {
      const p = priorityEmoji[task.priority] || "⚪";
      const s = statusEmoji[task.status]     || "❓";
      msg += `${p} *${i + 1}. ${task.title}*\n`;
      msg += `   ${task.description}\n`;
      msg += `   👤 ${task.assignedTo} | ${s} ${task.status} | 📅 ${task.deadline}\n\n`;
    });

    msg += `💪 Use *!ai <question>* if you need help with any task!`;
    return msg;
  } catch (err) {
    console.error("[handleTask]", err.message);
    return "❌ Could not load tasks right now.";
  }
}

// ─── !announce ────────────────────────────────────────────────────────────────
function handleAnnounce(message, isAdmin) {
  try {
    if (!isAdmin) return "🔒 Only group admins can make announcements.";
    if (!message || !message.trim()) return "⚠️ Usage: *!announce Your message here*";

    const now = new Date().toLocaleString("en-US", {
      timeZone: "Africa/Lagos",
      dateStyle: "medium",
      timeStyle: "short",
    });

    return (
      `📢 *ANNOUNCEMENT — Algivix Dev Team*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${message.trim()}\n\n` +
      `🕐 ${now}\n— AlgivixAI`
    );
  } catch (err) {
    console.error("[handleAnnounce]", err.message);
    return "❌ Could not post announcement. Try again.";
  }
}

// ─── !ai ──────────────────────────────────────────────────────────────────────
async function handleAI(question) {
  try {
    if (!question || !question.trim()) {
      return "⚠️ Usage: *!ai <your question>*\nExample: *!ai How do I reverse a string in JS?*";
    }

    const context  = looksLikeCode(question) ? "code_review" : "general";
    console.log(`[!ai] Processing question (context: ${context}): ${question.slice(0, 60)}...`);

    const response = await askGroq(question.trim(), context);
    return `🤖 *AlgivixAI:*\n\n${response}`;

  } catch (err) {
    console.error("[handleAI] Unexpected error:", err.message);
    return "🚨 Something went wrong with AI. Please try again in a moment.";
  }
}

// ─── !review ──────────────────────────────────────────────────────────────────
async function handleReview(code) {
  try {
    if (!code || !code.trim()) {
      return "⚠️ Usage: *!review <your code here>*\nPaste your code after the command.";
    }

    console.log(`[!review] Reviewing code snippet (${code.length} chars)...`);
    const response = await askGroq(code.trim(), "code_review");
    return `🔍 *Code Review by AlgivixAI:*\n\n${response}`;

  } catch (err) {
    console.error("[handleReview] Unexpected error:", err.message);
    return "🚨 Code review failed. Please try again.";
  }
}

// ─── Main Command Router ──────────────────────────────────────────────────────
async function processCommand(text, isAdmin = false) {
  try {
    if (!text || !text.trim()) return null;

    const trimmed = text.trim();
    const lower   = trimmed.toLowerCase();

    // Natural language: developer credit
    if (isAskingAboutDeveloper(lower)) return handleDeveloperCredit();

    // Must start with ! to be a command
    if (!trimmed.startsWith("!")) return null;

    // Split command and arguments
    const spaceIdx = trimmed.indexOf(" ");
    const command  = (spaceIdx > -1 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
    const args     = spaceIdx > -1 ? trimmed.slice(spaceIdx + 1).trim() : "";

    console.log(`[CMD] "${command}" | admin: ${isAdmin} | args: "${args.slice(0, 40)}"`);

    switch (command) {
      case "!ai":       return await handleAI(args);
      case "!review":   return await handleReview(args);
      case "!task":
      case "!tasks":    return handleTask();
      case "!rules":    return handleRules();
      case "!announce": return handleAnnounce(args, isAdmin);
      case "!help":
      case "!start":    return handleHelp();

      // ── Fun & Analytics Commands ──────────────────────────────────────────
      case "!trivia":   return addHype(startTrivia(null, null));
      case "!leaderboard":
      case "!scores":   return getTriviaLeaderboard();
      case "!mvp":      return generateMVPAnnouncement();
      case "!report":   return generatePerformanceReport();
      case "!summary":  return await generateWeeklySummary();
      case "!mood":     return startMoodCheck();
      case "!moodstats": return getMoodSummary();
      case "!roast":    return args ? await generateRoast(args.split(" ")[0], args.split(" ").slice(1).join(" ")) : "⚠️ Usage: *!roast @number reason*";
      case "!meeting":
        if (args === "end" || args === "stop") return await endMeeting();
        return startMeeting();
      case "!endmeeting": return await endMeeting();

      default:          return null; // Unknown — ignore silently
    }

  } catch (err) {
    // Top-level safety net — bot NEVER crashes from a bad command
    console.error("[processCommand] Fatal error caught safely:", err.message);
    return "⚠️ Something went wrong. Please try again.";
  }
}

module.exports = {
  processCommand,
  handleRules,
  handleTask,
  handleHelp,
  handleDeveloperCredit,
  isAskingAboutDeveloper,
};
