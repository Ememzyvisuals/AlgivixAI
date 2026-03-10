/**
 * commands.js - AlgivixAI Command Handler
 * Processes all bot commands and generates responses
 * Developer: EMEMZYVISUALS DIGITALS
 */

const fs = require("fs");
const path = require("path");
const { askGroq, looksLikeCode } = require("./ai");

// ─── Load JSON Data Files ─────────────────────────────────────────────────────
function loadJSON(filename) {
  try {
    const filePath = path.join(__dirname, filename);
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`[Commands] Failed to load ${filename}:`, err.message);
    return null;
  }
}

// ─── Developer Credit Triggers ────────────────────────────────────────────────
const CREDIT_TRIGGERS = [
  "who developed you",
  "who created you",
  "who made you",
  "who built you",
  "your developer",
  "your creator",
  "who is your creator",
  "who programmed you",
];

/**
 * Check if a message is asking about the bot's developer
 * @param {string} text
 * @returns {boolean}
 */
function isAskingAboutDeveloper(text) {
  const lower = text.toLowerCase();
  return CREDIT_TRIGGERS.some((trigger) => lower.includes(trigger));
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

/**
 * !rules — Display group rules
 * @returns {string}
 */
function handleRules() {
  const data = loadJSON("rules.json");
  if (!data) return "❌ Could not load rules. Please contact an admin.";

  let msg = `📋 *Algivix Dev Team — Group Rules*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  data.rules.forEach((rule) => {
    msg += `${rule}\n`;
  });
  msg += `\n✅ Follow these rules to keep our community professional and productive!`;
  return msg;
}

/**
 * !task — Display current development tasks
 * @returns {string}
 */
function handleTask() {
  const data = loadJSON("tasks.json");
  if (!data) return "❌ Could not load tasks. Please contact an admin.";

  const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢" };
  const statusEmoji = { pending: "⏳", "in-progress": "🔄", done: "✅" };

  let msg = `📌 *Sprint Tasks — Algivix Dev Team*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🎯 *Weekly Goal:* ${data.weeklyGoal}\n\n`;

  data.tasks.forEach((task, index) => {
    const priority = priorityEmoji[task.priority] || "⚪";
    const status = statusEmoji[task.status] || "❓";
    msg += `${priority} *Task ${index + 1}: ${task.title}*\n`;
    msg += `   ${task.description}\n`;
    msg += `   👤 Assigned: ${task.assignedTo} | ${status} ${task.status} | 📅 Due: ${task.deadline}\n\n`;
  });

  msg += `💪 Let's crush these tasks! Use *!ai* for help with any task.`;
  return msg;
}

/**
 * !announce <message> — Post an announcement (admin only)
 * @param {string} message - The announcement content
 * @param {boolean} isAdmin - Whether the sender is an admin
 * @returns {string}
 */
function handleAnnounce(message, isAdmin) {
  if (!isAdmin) {
    return "🔒 Only group admins can make announcements.";
  }
  if (!message || message.trim().length === 0) {
    return '⚠️ Please provide a message. Usage: *!announce Your message here*';
  }

  const now = new Date().toLocaleString("en-US", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    `📢 *ANNOUNCEMENT — Algivix Dev Team*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${message.trim()}\n\n` +
    `🕐 Posted: ${now}\n` +
    `— AlgivixAI Bot`
  );
}

/**
 * !ai <question> — Ask the AI a development question
 * @param {string} question - The user's question
 * @returns {Promise<string>}
 */
async function handleAI(question) {
  if (!question || question.trim().length === 0) {
    return '⚠️ Please provide a question. Usage: *!ai How do I center a div in CSS?*';
  }

  // Auto-detect code for better AI context
  const context = looksLikeCode(question) ? "code_review" : "general";
  const thinking = "🤖 *AlgivixAI is thinking...*\n";

  try {
    const response = await askGroq(question.trim(), context);
    return `🤖 *AlgivixAI:*\n${response}`;
  } catch (err) {
    console.error("[Commands] AI handler error:", err.message);
    return "🚨 AI encountered an error. Please try again.";
  }
}

/**
 * !review <code> — Review a code snippet
 * @param {string} code - The code to review
 * @returns {Promise<string>}
 */
async function handleReview(code) {
  if (!code || code.trim().length === 0) {
    return (
      '⚠️ Please provide code to review.\n' +
      'Usage: *!review* followed by your code snippet.'
    );
  }

  try {
    const response = await askGroq(code.trim(), "code_review");
    return `🔍 *Code Review by AlgivixAI:*\n${response}`;
  } catch (err) {
    console.error("[Commands] Review handler error:", err.message);
    return "🚨 Code review failed. Please try again.";
  }
}

/**
 * Developer credit response
 * @returns {string}
 */
function handleDeveloperCredit() {
  return (
    `👨‍💻 *About AlgivixAI*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `I was developed by:\n\n` +
    `🚀 *EMEMZYVISUALS DIGITALS*\n` +
    `A talented and AI automation developer\n\n` +
    `Built with ❤️ for the Algivix Dev Team.\n` +
    `Powered by Groq AI + Baileys WhatsApp SDK.`
  );
}

/**
 * !help — Show available commands
 * @returns {string}
 */
function handleHelp() {
  return (
    `🤖 *AlgivixAI — Command Guide*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `*!ai <question>* — Ask AI a dev question\n` +
    `*!review <code>* — Get AI code review\n` +
    `*!task* — View current sprint tasks\n` +
    `*!rules* — View group rules\n` +
    `*!announce <msg>* — Post announcement (admin)\n` +
    `*!help* — Show this guide\n\n` +
    `💡 Tip: You can also just ask me anything like:\n` +
    `"Who developed you?" or paste code for review!`
  );
}

/**
 * Main command dispatcher — routes messages to the correct handler
 * @param {string} text - Raw message text
 * @param {boolean} isAdmin - Whether sender is a group admin
 * @returns {Promise<string|null>} - Response string or null (ignore message)
 */
async function processCommand(text, isAdmin = false) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // ── Developer credit check (natural language) ───────────────────────────────
  if (isAskingAboutDeveloper(lower)) {
    return handleDeveloperCredit();
  }

  // ── Command prefix check ────────────────────────────────────────────────────
  if (!trimmed.startsWith("!")) {
    return null; // Not a command — ignore
  }

  // Parse command and arguments
  const spaceIndex = trimmed.indexOf(" ");
  const command = (spaceIndex > -1 ? trimmed.substring(0, spaceIndex) : trimmed).toLowerCase();
  const args = spaceIndex > -1 ? trimmed.substring(spaceIndex + 1).trim() : "";

  // ── Route to handler ────────────────────────────────────────────────────────
  switch (command) {
    case "!ai":
      return await handleAI(args);

    case "!review":
      return await handleReview(args);

    case "!task":
    case "!tasks":
      return handleTask();

    case "!rules":
      return handleRules();

    case "!announce":
      return handleAnnounce(args, isAdmin);

    case "!help":
    case "!start":
      return handleHelp();

    default:
      return null; // Unknown command — ignore silently
  }
}

module.exports = {
  processCommand,
  handleRules,
  handleTask,
  handleHelp,
  isAskingAboutDeveloper,
  handleDeveloperCredit,
};
