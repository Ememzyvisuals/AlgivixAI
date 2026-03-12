/**
 * commands.js - AlgivixAI Command Handler
 * Developer: EMEMZYVISUALS DIGITALS
 * 
 * HARDENED: Every function wrapped in try/catch
 * so one crash never takes down the whole bot.
 */

const fs   = require("fs");
const path = require("path");
const { getAllTasks, getActiveTasks, formatTaskList } = require("./taskmanager");
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
function handleHelp(isAdmin = false) {
  try {
    const D = "━━━━━━━━━━━━━━━━━━━━";
    let msg = `🤖 *AlgivixAI — Complete Command Guide*
${D}
_Built by EMEMZYVISUALS DIGITALS_

`;

    // ── GENERAL — everyone ──────────────────────────────────────────────────
    msg += `💬 *AI & CHAT*
${D}
`;
    msg += `*!ai <question>* — Ask anything
`;
    msg += `  _!ai explain async/await in JS_

`;
    msg += `*!imagine <description>* — Generate an image 🎨
`;
    msg += `  _!imagine a futuristic Lagos skyline at night_

`;
    msg += `*!generate <description>* — Same as !imagine

`;

    // ── TASKS ───────────────────────────────────────────────────────────────
    msg += `📋 *TASKS & WORK*
${D}
`;
    msg += `*!task* — View all sprint tasks
`;
    msg += `*!submit <#> <link/work>* — Submit your task
`;
    msg += `  _!submit 1 https://github.com/myrepo_

`;

    // ── FUN ─────────────────────────────────────────────────────────────────
    msg += `🎮 *FUN & ENGAGEMENT*
${D}
`;
    msg += `*!trivia* — Dev coding quiz 🧠
`;
    msg += `*!leaderboard* — Trivia scores 🏆
`;
    msg += `*!roast @number reason* — AI roast 😂
`;
    msg += `*!mood* — Team mood check 💭
`;
    msg += `*!moodstats* — See mood history
`;
    msg += `*!mvp* — MVP of the week 🏆

`;

    // ── POLLS ───────────────────────────────────────────────────────────────
    msg += `📊 *POLLS*
${D}
`;
    msg += `*!poll "Question" "Opt1" "Opt2" "Opt3"* — Create poll
`;
    msg += `  _!poll "Best framework?" "React" "Vue" "Angular"_
`;
    msg += `Reply *1 / 2 / 3* to vote on active polls

`;

    // ── INFO ────────────────────────────────────────────────────────────────
    msg += `ℹ️ *INFO*
${D}
`;
    msg += `*!rules* — Group rules
`;
    msg += `*!help* — This guide

`;

    if (isAdmin) {
      // ── ADMIN ───────────────────────────────────────────────────────────
      msg += `🔐 *ADMIN COMMANDS*
${D}
`;
      msg += `*!announce <message>* — Post announcement
`;
      msg += `*!warn @member reason* — Issue warning (3 = auto-kick)
`;
      msg += `*!clearwarn @member* — Clear warnings
`;
      msg += `*!delete* — Reply to a message + type to delete it
`;
      msg += `*!pin* — Reply to a message + type to pin it
`;
      msg += `*!meeting* — Start meeting notes 🎙️
`;
      msg += `*!meeting end* — End + AI summary

`;

      msg += `💬 *ADMIN NATURAL LANGUAGE (no ! needed):*
`;
      msg += `• _"remove @number"_ — Kick member
`;
      msg += `• _"don't reply to @number"_ — Ignore member
`;
      msg += `• _"reply to @number again"_ — Unignore member
`;
      msg += `• _"@number I asked about X"_ — Chase non-replier
`;
      msg += `• _"post this: <msg>"_ — Post announcement

`;

      msg += `🔑 *DEVELOPER-ONLY COMMANDS (DM the bot)*
${D}
`;
      msg += `🎨 *IMAGE GENERATION:*
`;
      msg += `• _"generate an image of ..."_ — NL image gen
`;
      msg += `• _"draw me a logo for AlgivixAI"_ — Draw anything
`;
      msg += `• Send image then _"edit this, make it anime"_ — Edit/restyle
`;
      msg += `• Send image then _"change style to cyberpunk"_ — Change style
`;
      msg += `• Send image then _"add rain to this"_ — Modify image

`;

      msg += `📡 *PERSONAL AGENT (send messages on your behalf):*
`;
      msg += `• _"send a message to 09047114612 telling him about the deadline"_
`;
      msg += `• _"message 08012345678 and ask if he's done with the UI"_
`;
      msg += `• _"tell 09047114612 that meeting is 3PM tomorrow"_
`;
      msg += `• _"show missions"_ — See active agent missions
`;
      msg += `• _"stop mission 09047114612"_ — End a mission

`;

      msg += `⏰ *REMINDERS:*
`;
      msg += `• _"remind me in 2 hours to push code"_
`;
      msg += `• _"remind me on March 20 that Cyrus birthday"_
`;
      msg += `• _"remind me on Friday to deploy"_
`;
      msg += `• _"my reminders"_ — List all upcoming reminders

`;

      msg += `📅 *SCHEDULED MESSAGES:*
`;
      msg += `• _"send this to the group at 9AM tomorrow: Good morning!"_

`;

      msg += `📱 *STATUS:*
`;
      msg += `• _"post something on your status"_ — Post to WhatsApp Story
`;
      msg += `• _"post this on status: I'm shipping features 🚀"_ — Custom status

`;

      msg += `📤 *SEND TO GROUP:*
`;
      msg += `• _"send this to the group"_ — Forwards last bot message
`;
      msg += `• _"!broadcast <message>"_ — Post announcement

`;

      msg += `🔁 *BUSY MODE:*
`;
      msg += `• _"I'm in a meeting"_ — Auto-reply to all DMs
`;
      msg += `• _"I'm back"_ — Turn off busy mode

`;

      msg += `📊 *INFO & STATS:*
`;
      msg += `• _"bot stats"_ — Full brain statistics
`;
      msg += `• _"digest"_ — Today's group summary

`;

      msg += `🎛️ *GROUP CONTROL (in group, no ! prefix):*
`;
      msg += `• _"ghost mode"_ — Bot goes silent (toggle)
`;
      msg += `• _"hype mode"_ — Bot goes crazy 🔥 (toggle)
`;
      msg += `• _"lockdown"_ — Admins-only mode (toggle)
`;
      msg += `• _"nuke warnings"_ — Clear all warnings
`;
      msg += `• _"reset mvp"_ — Reset MVP scores
`;
      msg += `• _"reset trivia"_ — Reset leaderboard
`;
      msg += `• _"add task: <title> | assigned to <name> | deadline <date>"_
`;
      msg += `• _"remove task #2"_ — Remove a task
`;
      msg += `• _"mark task #1 as completed"_
`;
      msg += `• _"list tasks"_ / _"post tasks to group"_

`;
    } else {
      msg += `ℹ️ _Admins: type *!help* to see all admin + dev commands_ 🔐

`;
    }

    msg += `${D}
`;
    msg += `🤖 _AlgivixAI v6 — Persistent Brain · Always Online_
`;
    msg += `👑 _Built by *EMEMZYVISUALS DIGITALS*_ 🚀
`;
    msg += `_Brain remembers EVERYTHING even after redeploy 🧠_`;
    return msg;
  } catch (err) {
    console.error("[handleHelp]", err.message);
    return "❓ Help temporarily unavailable.";
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
    const tasks = getActiveTasks();
    return formatTaskList(tasks);
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
      case "!delete":   return "__DELETE_LAST__";  // Special signal
      case "!task":
      case "!tasks":    return buildTaskMessage();
      case "!submit":   return handleSubmit(text, meta?.senderPhone || "", meta?.senderName || "");
      case "!rules":    return handleRules();
      case "!announce": return handleAnnounce(args, isAdmin);
      case "!hello":
      case "!hi":
      case "!hey":      return handleGreet(isAdmin);
      case "!help":
      case "!start":    return handleHelp(isAdmin);

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
