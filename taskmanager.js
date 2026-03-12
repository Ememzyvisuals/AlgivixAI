/**
 * taskmanager.js — AlgivixAI Smart Task Manager
 * ===============================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * Features:
 * - Bot asks dev via DM to set/update/remove tasks
 * - Reminds group members before deadline (3 days, 1 day, day-of)
 * - After deadline → bot reviews submissions in group
 * - Members can submit work with !submit <task_id> <link/description>
 * - Dev can manage everything via DM naturally
 */

const fs   = require("fs");
const path = require("path");
const https = require("https");

const TASKS_FILE = path.join(__dirname, "tasks.json");

const fmt    = t => `*${t}*`;
const italic = t => `_${t}_`;
const div    = () => `━━━━━━━━━━━━━━━━━━━━`;

// ─── Load / Save ──────────────────────────────────────────────────────────────
function loadTasks() {
  try {
    const raw = fs.readFileSync(TASKS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { tasks: [], weeklyGoal: "", lastUpdated: new Date().toISOString().split("T")[0] };
  }
}

function saveTasks(data) {
  data.lastUpdated = new Date().toISOString().split("T")[0];
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

// ─── Priority emoji ───────────────────────────────────────────────────────────
function priorityEmoji(p) {
  return { high: "🔴", medium: "🟡", low: "🟢" }[p] || "⚪";
}

function statusEmoji(s) {
  return { pending: "⏳", "in-progress": "🔄", completed: "✅", overdue: "🚨" }[s] || "❓";
}

// ─── Days until deadline ──────────────────────────────────────────────────────
function daysUntil(dateStr) {
  const deadline = new Date(dateStr);
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  deadline.setHours(0, 0, 0, 0);
  return Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
}

// ─── Format single task ───────────────────────────────────────────────────────
function formatTask(task, index) {
  const days  = daysUntil(task.deadline);
  const emoji = priorityEmoji(task.priority);
  const sEmoji = statusEmoji(task.status);
  const dayStr = days > 0 ? `${days} day${days !== 1 ? "s" : ""} left` : days === 0 ? "Due TODAY!" : `${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""} overdue`;

  let taskStr = `${emoji} ${fmt((index + 1) + ". " + task.title)}\n`;
  taskStr += `   ${task.description}\n`;
  taskStr += `   👤 ${task.assignedTo} | ${sEmoji} ${task.status} | 📅 ${task.deadline} | ⏰ ${italic(dayStr)}`;

  if (task.submissions && task.submissions.length > 0) {
    taskStr += `\n   📬 ${task.submissions.length} submission(s) received`;
  }
  return taskStr;
}

// ─── Full task list message ───────────────────────────────────────────────────
function buildTaskMessage() {
  const data = loadTasks();
  if (!data.tasks.length) {
    return `📋 ${fmt("No tasks yet!")} \nAsk EMEMZYVISUALS to set tasks via DM!`;
  }

  const today = new Date().toISOString().split("T")[0];
  let msg = `📌 ${fmt("Sprint Tasks — Algivix Dev Team")}\n${div()}\n`;

  if (data.weeklyGoal) {
    msg += `🎯 ${fmt("Goal:")} ${data.weeklyGoal}\n${div()}\n\n`;
  }

  data.tasks.forEach((task, i) => {
    msg += formatTask(task, i) + "\n\n";
  });

  msg += `${div()}\n`;
  msg += `💪 Use ${fmt("!submit <task number> <your work/link>")} to submit!\n`;
  msg += `💡 Use ${fmt("!ai <question>")} for help with any task!`;
  return msg;
}

// ─── Check deadlines — called by cron ────────────────────────────────────────
function getDeadlineReminders() {
  const data      = loadTasks();
  const reminders = [];

  data.tasks.forEach((task, i) => {
    if (task.status === "completed") return;

    const days = daysUntil(task.deadline);

    if (days === 3) {
      reminders.push({
        type:    "warning",
        taskIdx: i,
        task,
        message: `⚠️ ${fmt("Deadline Warning!")} ${div()}\n\n` +
          `${priorityEmoji(task.priority)} ${fmt(task.title)} is due in ${fmt("3 days")} (${task.deadline})!\n\n` +
          `${italic(task.description)}\n\n` +
          `👤 Assigned to: ${fmt(task.assignedTo)}\n` +
          `💪 Use ${fmt("!submit " + (i+1) + " <your work>")} when done!`,
      });
    } else if (days === 1) {
      reminders.push({
        type:    "urgent",
        taskIdx: i,
        task,
        message: `🚨 ${fmt("TOMORROW IS THE DEADLINE!")} ${div()}\n\n` +
          `${priorityEmoji(task.priority)} ${fmt(task.title)} is due ${fmt("TOMORROW")} (${task.deadline})!\n\n` +
          `${italic(task.description)}\n\n` +
          `👤 Assigned to: ${fmt(task.assignedTo)}\n` +
          `If you haven't started — ${fmt("START NOW!")} 💪\n` +
          `Submit with: ${fmt("!submit " + (i+1) + " <your work>")}`,
      });
    } else if (days === 0) {
      reminders.push({
        type:    "due_today",
        taskIdx: i,
        task,
        message: `🔔 ${fmt("DUE TODAY!")} ${div()}\n\n` +
          `${priorityEmoji(task.priority)} ${fmt(task.title)} is due ${fmt("TODAY!")} ⏰\n\n` +
          `${italic(task.description)}\n\n` +
          `👤 ${fmt(task.assignedTo)} — please submit ASAP!\n` +
          `📬 Submit with: ${fmt("!submit " + (i+1) + " <your work/link>")}`,
      });
    } else if (days < 0 && task.status !== "overdue") {
      // Mark as overdue
      task.status = "overdue";
      reminders.push({
        type:    "overdue",
        taskIdx: i,
        task,
        message: `🚨 ${fmt("OVERDUE!")} ${div()}\n\n` +
          `${priorityEmoji(task.priority)} ${fmt(task.title)} was due on ${fmt(task.deadline)} — ${fmt(Math.abs(days) + " day(s) ago")}!\n\n` +
          `📬 Submissions received: ${task.submissions?.length || 0}\n` +
          `👤 Assigned to: ${fmt(task.assignedTo)}\n\n` +
          `Still submit with: ${fmt("!submit " + (i+1) + " <work>")} (late submission)`,
      });
    }
  });

  saveTasks(data);
  return reminders;
}

// ─── Review submissions after deadline ───────────────────────────────────────
async function reviewSubmissions(taskIdx) {
  const data = loadTasks();
  const task = data.tasks[taskIdx];
  if (!task) return null;

  const subs = task.submissions || [];
  if (!subs.length) {
    return `😔 ${fmt("Submission Review: " + task.title)}\n${div()}\n\n` +
      `No submissions received for this task!\n` +
      `Assigned to: ${fmt(task.assignedTo)}\n\n` +
      `${italic("This needs to be addressed. Team — what happened? 🤔")}`;
  }

  // Ask Groq to review
  const submissionText = subs.map((s, i) => `${i+1}. ${s.member}: "${s.work}" (submitted ${s.time})`).join("\n");

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      max_tokens: 500,
      messages: [{
        role: "system",
        content: "You are AlgivixAI reviewing task submissions for the Algivix Dev Team. Be encouraging but honest. Use *bold* for emphasis. Keep it under 150 words."
      }, {
        role: "user",
        content: `Task: "${task.title}"\nDescription: ${task.description}\n\nSubmissions:\n${submissionText}\n\nWrite a brief review of these submissions for the WhatsApp group. Praise good work, note what's missing, encourage the team.`
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
        try {
          const review = JSON.parse(d).choices?.[0]?.message?.content?.trim();
          const msg = `📋 ${fmt("Submission Review: " + task.title)}\n${div()}\n\n` +
            `📬 ${fmt(subs.length + " submission(s) received")}\n\n` +
            (review || "Great work team! Keep it up! 💪") + "\n\n" +
            `${div()}\n${italic("Review by AlgivixAI — Built by EMEMZYVISUALS DIGITALS")}`;
          resolve(msg);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ─── Handle !submit command ───────────────────────────────────────────────────
function handleSubmit(text, senderPhone, senderName) {
  // !submit 1 https://github.com/...
  const match = text.match(/^!submit\s+(\d+)\s+(.+)/i);
  if (!match) {
    return `❓ ${fmt("Usage:")} !submit <task number> <your work or link>\n${italic("Example: !submit 1 https://github.com/myrepo")}`;
  }

  const taskNum = parseInt(match[1]) - 1;
  const work    = match[2].trim();
  const data    = loadTasks();

  if (taskNum < 0 || taskNum >= data.tasks.length) {
    return `❌ Task #${taskNum + 1} not found. Use ${fmt("!task")} to see task numbers.`;
  }

  const task = data.tasks[taskNum];
  if (!task.submissions) task.submissions = [];

  // Check if already submitted
  const existing = task.submissions.findIndex(s => s.member === senderPhone);
  const now       = new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos", dateStyle: "short", timeStyle: "short" });

  if (existing > -1) {
    task.submissions[existing] = { member: senderPhone, name: senderName, work, time: now };
    saveTasks(data);
    return `♻️ @${senderPhone} ${fmt("Updated your submission")} for ${fmt(task.title)}!\n📬 Work: ${italic(work.slice(0, 80))}\n✅ Got it! We'll review after the deadline.`;
  }

  task.submissions.push({ member: senderPhone, name: senderName, work, time: now });
  saveTasks(data);

  const days = daysUntil(task.deadline);
  const lateTag = days < 0 ? " _(late submission)_" : "";

  return `✅ @${senderPhone} ${fmt("Submission received")} for ${fmt(task.title)}!${lateTag}\n📬 Work: ${italic(work.slice(0, 80))}\n⏰ Submitted: ${now}\n\n🔥 ${italic("Great job submitting! Will be reviewed after deadline.")}`;
}

// ─── DM Task Management — parse developer commands ───────────────────────────
function handleTaskDMCommand(text) {
  const lower = text.toLowerCase().trim();

  // ADD TASK
  // "add task: Fix login bug | assigned to Cyrus | deadline 2026-03-20 | high"
  const addMatch = text.match(/add task:?\s*(.+?)(?:\s*\|\s*assigned to\s*(.+?))?(?:\s*\|\s*deadline\s*(\d{4}-\d{2}-\d{2}))?(?:\s*\|\s*(high|medium|low))?$/i);
  if (addMatch || lower.startsWith("add task")) {
    return { action: "add_prompt" };
  }

  // REMOVE TASK
  const removeMatch = text.match(/remove task\s*#?(\d+)/i) || text.match(/delete task\s*#?(\d+)/i);
  if (removeMatch) return { action: "remove", taskNum: parseInt(removeMatch[1]) };

  // UPDATE TASK STATUS
  const updateMatch = text.match(/(?:mark|update|set)\s+task\s*#?(\d+)\s+(?:as\s+)?(completed?|done|in-progress|pending)/i);
  if (updateMatch) return { action: "update_status", taskNum: parseInt(updateMatch[1]), status: updateMatch[2].toLowerCase().replace("done", "completed").replace("complete", "completed") };

  // UPDATE GOAL
  const goalMatch = text.match(/(?:set|update|change)\s+(?:weekly\s+)?goal:?\s*(.+)/i);
  if (goalMatch) return { action: "update_goal", goal: goalMatch[1].trim() };

  // LIST TASKS
  if (lower.includes("list tasks") || lower.includes("show tasks") || lower === "tasks") {
    return { action: "list" };
  }

  return null;
}

// ─── Execute task DM action ───────────────────────────────────────────────────
function executeDMAction(action, params = {}) {
  const data = loadTasks();

  switch (action) {
    case "list": {
      return buildTaskMessage();
    }

    case "remove": {
      const idx = (params.taskNum || 1) - 1;
      if (idx < 0 || idx >= data.tasks.length) return `❌ Task #${params.taskNum} not found!`;
      const removed = data.tasks.splice(idx, 1)[0];
      saveTasks(data);
      return `🗑️ ${fmt("Task removed!")} "${removed.title}" has been deleted from the sprint.`;
    }

    case "update_status": {
      const idx = (params.taskNum || 1) - 1;
      if (idx < 0 || idx >= data.tasks.length) return `❌ Task #${params.taskNum} not found!`;
      const oldStatus = data.tasks[idx].status;
      data.tasks[idx].status = params.status;
      saveTasks(data);
      return `✅ ${fmt("Task updated!")} "${data.tasks[idx].title}" → ${statusEmoji(params.status)} ${fmt(params.status)}`;
    }

    case "update_goal": {
      data.weeklyGoal = params.goal;
      saveTasks(data);
      return `🎯 ${fmt("Weekly goal updated!")} "${params.goal}"`;
    }

    case "add": {
      const newTask = {
        id:          data.tasks.length + 1,
        title:       params.title,
        description: params.description || "",
        assignedTo:  params.assignedTo || "all",
        priority:    params.priority || "medium",
        deadline:    params.deadline || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        status:      "pending",
        submissions: [],
      };
      data.tasks.push(newTask);
      saveTasks(data);
      return `✅ ${fmt("Task added!")} "${newTask.title}" → assigned to ${fmt(newTask.assignedTo)}, deadline ${fmt(newTask.deadline)}, priority ${fmt(newTask.priority)}.`;
    }

    default: return null;
  }
}

// ─── Prompt dev to set up tasks (called on first run / morning briefing) ──────
function getTaskSetupPrompt() {
  const data = loadTasks();
  if (data.tasks.length === 0) {
    return `📋 ${fmt("Hey boss! No tasks are set yet.")}\n${div()}\n\n` +
      `Let me know what the team is working on!\n\n` +
      `To add tasks, say:\n` +
      `${italic("add task: <title> | assigned to <name> | deadline <YYYY-MM-DD> | <high/medium/low>")}\n\n` +
      `To set a weekly goal:\n` +
      `${italic("set goal: Ship the MVP by end of sprint")}\n\n` +
      `I'll remind the team automatically before deadlines! 🔥`;
  }

  const overdue  = data.tasks.filter(t => daysUntil(t.deadline) < 0 && t.status !== "completed").length;
  const dueToday = data.tasks.filter(t => daysUntil(t.deadline) === 0).length;
  const pending  = data.tasks.filter(t => t.status === "pending").length;
  const done     = data.tasks.filter(t => t.status === "completed").length;

  let summary = `📊 ${fmt("Task Summary for today:")}\n${div()}\n`;
  summary += `✅ Completed: ${done}   ⏳ Pending: ${pending}\n`;
  if (dueToday) summary += `🔔 Due today: ${fmt(dueToday + " task(s)!")}\n`;
  if (overdue)  summary += `🚨 Overdue: ${fmt(overdue + " task(s)!")}\n`;
  summary += `\n_Say "list tasks" to see everything or "add task: ..." to add new ones_`;
  return summary;
}

module.exports = {
  loadTasks,
  saveTasks,
  buildTaskMessage,
  getDeadlineReminders,
  reviewSubmissions,
  handleSubmit,
  handleTaskDMCommand,
  executeDMAction,
  getTaskSetupPrompt,
  daysUntil,
  formatTask,
};
