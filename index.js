/**
 * index.js - AlgivixAI WhatsApp Bot — Main Entry Point
 * =====================================================
 * Bot for the Algivix Dev Team
 * Developer: EMEMZYVISUALS DIGITALS
 * Powered by: Baileys (WhatsApp SDK) + Groq AI
 *
 * Auth: Pairing Code (no QR scan needed — works on cloud/headless servers)
 *
 * Features:
 *  - AI-powered developer assistance (!ai, !review)
 *  - Automatic task distribution (!task)
 *  - Group moderation (spam/content detection)
 *  - Announcements (!announce)
 *  - Rules management (!rules)
 *  - Developer credit (natural language)
 *  - Scheduled task reminders & rules pings
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidGroup,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const cron = require("node-cron");
const path = require("path");
const readline = require("readline"); // Used to prompt for phone number locally

const { processCommand, handleTask, handleRules } = require("./commands");
const {
  analyzeMessage,
  issueWarning,
  buildWarningMessage,
  buildAdminAlert,
} = require("./moderation");

// ─── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  sessionDir: path.join(__dirname, "session"),  // Auth session storage
  botName: "AlgivixAI",
  // Your WhatsApp number (with country code, no + or spaces) e.g. "2347012345678"
  // Set this in your .env as BOT_PHONE_NUMBER for cloud deployment
  phoneNumber: process.env.BOT_PHONE_NUMBER || null,
  // Set your group JID here after first run (e.g., "120363xxxxx@g.us")
  targetGroupJid: process.env.TARGET_GROUP_JID || null,
  // Optional: Admin phone numbers (without +, e.g., "2347012345678")
  adminNumbers: (process.env.ADMIN_NUMBERS || "").split(",").filter(Boolean),
};

// ─── Logger Setup ─────────────────────────────────────────────────────────────
const logger = pino(
  { level: process.env.LOG_LEVEL || "info" },
  pino.destination("./bot.log") // Log to file
);

// Silent logger for Baileys (it's very verbose by default)
const baileysLogger = pino({ level: "silent" });

let sock; // Global socket reference for cron jobs

// ─── Helper: Send a message to a JID ─────────────────────────────────────────
async function sendMessage(jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error(`[Bot] Failed to send message to ${jid}:`, err.message);
  }
}

// ─── Helper: Check if sender is a group admin ─────────────────────────────────
async function isGroupAdmin(groupJid, senderJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    return metadata.participants.some(
      (p) => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
    );
  } catch {
    return false;
  }
}

// ─── Helper: Get all admin JIDs in a group ───────────────────────────────────
async function getGroupAdmins(groupJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    return metadata.participants
      .filter((p) => p.admin === "admin" || p.admin === "superadmin")
      .map((p) => p.id);
  } catch {
    return [];
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
async function handleIncomingMessage(msg) {
  try {
    // Ignore messages from the bot itself
    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const senderJid = msg.key.participant || jid; // participant = sender in groups
    const isGroup = isJidGroup(jid);

    // Extract message text (handles text, extended text, and image captions)
    const messageContent = msg.message;
    const text =
      messageContent?.conversation ||
      messageContent?.extendedTextMessage?.text ||
      messageContent?.imageMessage?.caption ||
      "";

    if (!text || text.trim().length === 0) return;

    console.log(`[${isGroup ? "Group" : "DM"}] ${senderJid}: ${text.substring(0, 80)}`);

    // ── Group Moderation ──────────────────────────────────────────────────────
    if (isGroup) {
      const adminInGroup = await isGroupAdmin(jid, senderJid);

      // Don't moderate admins
      if (!adminInGroup) {
        const { isViolation, reason, severity } = analyzeMessage(senderJid, text);

        if (isViolation) {
          const { count, shouldNotifyAdmin } = issueWarning(senderJid);
          const warningMsg = buildWarningMessage(senderJid, reason, count);

          // Send warning to group
          await sendMessage(jid, warningMsg);

          // Notify admins if max warnings reached
          if (shouldNotifyAdmin) {
            const adminAlert = buildAdminAlert(senderJid, reason, text);
            const admins = await getGroupAdmins(jid);
            for (const adminJid of admins) {
              await sendMessage(adminJid, adminAlert);
            }
          }

          // For high severity, skip processing the command
          if (severity === "high") return;
        }
      }

      // ── Process Commands (group only) ───────────────────────────────────────
      const isAdmin = adminInGroup;
      const response = await processCommand(text, isAdmin);

      if (response) {
        await sendMessage(jid, response);
      }
    } else {
      // ── DM Support ────────────────────────────────────────────────────────
      // Bot also responds to direct messages for developer queries
      const response = await processCommand(text, false);
      if (response) {
        await sendMessage(jid, response);
      } else if (text.startsWith("!")) {
        await sendMessage(jid, "❓ Unknown command. Send *!help* to see all commands.");
      }
    }
  } catch (err) {
    console.error("[Bot] Message handler error:", err.message);
    logger.error(err, "Message handler error");
  }
}

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────
function setupScheduledJobs() {
  const groupJid = CONFIG.targetGroupJid;
  if (!groupJid) {
    console.warn("[Cron] No TARGET_GROUP_JID set — skipping scheduled messages.");
    return;
  }

  // ── Daily task reminder at 8:00 AM WAT (UTC+1) — Mon to Fri ───────────────
  cron.schedule("0 7 * * 1-5", async () => {
    console.log("[Cron] Sending daily task reminder...");
    const taskMsg =
      `🌅 *Good Morning, Algivix Dev Team!*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Here are today's tasks to keep us on track:\n\n` +
      handleTask() +
      `\n\n💡 Use *!ai <question>* if you need help with any task!`;
    await sendMessage(groupJid, taskMsg);
  });

  // ── Weekly rules reminder every Monday at 9:00 AM WAT ─────────────────────
  cron.schedule("0 8 * * 1", async () => {
    console.log("[Cron] Sending weekly rules reminder...");
    const rulesMsg =
      `👋 *Weekly Reminder — Algivix Dev Team*\n` +
      `Let's keep our community professional!\n\n` +
      handleRules();
    await sendMessage(groupJid, rulesMsg);
  });

  // ── Friday standup prompt at 4:00 PM WAT ──────────────────────────────────
  cron.schedule("0 15 * * 5", async () => {
    console.log("[Cron] Sending Friday check-in...");
    await sendMessage(
      groupJid,
      `🎉 *It's Friday, Team!*\n` +
        `Let's do a quick sprint check-in:\n\n` +
        `✅ What did you complete this week?\n` +
        `🔄 What's still in progress?\n` +
        `🚧 Any blockers?\n\n` +
        `Reply with your update. Great work this week! 💪`
    );
  });

  console.log("[Cron] Scheduled jobs activated ✅");
}

// ─── Helper: Prompt for phone number in terminal (local use only) ─────────────
function promptPhoneNumber() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      "📱 Enter your WhatsApp number (with country code, no + or spaces)\n   Example: 2347012345678\n> ",
      (answer) => {
        rl.close();
        resolve(answer.trim().replace(/\D/g, "")); // Strip non-digits
      }
    );
  });
}

// ─── WhatsApp Connection (Pairing Code Auth) ──────────────────────────────────
async function connectToWhatsApp() {
  // Load or create session files (persists across restarts)
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionDir);

  // Get the latest compatible Baileys version
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[Bot] Using Baileys v${version.join(".")}`);

  // Create the WhatsApp socket — pairing code requires mobile: false
  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false,   // No QR — we use pairing code
    mobile: false,
    browser: ["AlgivixAI", "Chrome", "1.0.0"],
  });

  // ── Save credentials whenever they update ─────────────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ── Request pairing code if not yet registered ────────────────────────────
  if (!state.creds.registered) {
    // Get phone number: from env (cloud) or prompt (local)
    let phone = CONFIG.phoneNumber;

    if (!phone) {
      console.log("\n⚠️  BOT_PHONE_NUMBER not set in .env — switching to interactive mode.\n");
      phone = await promptPhoneNumber();
    }

    if (!phone || phone.length < 10) {
      console.error("[Bot] ❌ Invalid phone number. Set BOT_PHONE_NUMBER in your .env file.");
      process.exit(1);
    }

    // Small delay required before requesting pairing code
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const code = await sock.requestPairingCode(phone);
      const formatted = code.match(/.{1,4}/g).join("-"); // Format: ABCD-EFGH

      console.log("\n╔══════════════════════════════════════╗");
      console.log("║       📲 WHATSAPP PAIRING CODE       ║");
      console.log("╠══════════════════════════════════════╣");
      console.log(`║         👉  ${formatted}  👈          ║`);
      console.log("╚══════════════════════════════════════╝");
      console.log("\n📋 How to link:");
      console.log("   1. Open WhatsApp on your phone");
      console.log("   2. Go to Settings → Linked Devices");
      console.log("   3. Tap 'Link a Device'");
      console.log("   4. Tap 'Link with phone number instead'");
      console.log(`   5. Enter the code above: ${formatted}`);
      console.log("\n⏳ Waiting for you to enter the code...\n");
    } catch (err) {
      console.error("[Bot] ❌ Failed to get pairing code:", err.message);
      console.error("     Make sure your phone number is correct and try again.");
      process.exit(1);
    }
  }

  // ── Connection state handler ──────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[Bot] Connection closed (code: ${statusCode}). Reconnect: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        console.log("[Bot] Reconnecting in 5 seconds...");
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log("[Bot] Logged out. Delete the ./session folder and restart to re-pair.");
        process.exit(0);
      }
    }

    if (connection === "open") {
      console.log("\n✅ AlgivixAI is now ONLINE and connected to WhatsApp!");
      console.log(`📱 Bot number: ${sock.user?.id}`);
      console.log("🤖 Listening for messages...\n");

      // Start scheduled jobs only after connection is established
      setupScheduledJobs();
    }
  });

  // ── Incoming message handler ──────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      await handleIncomingMessage(msg);
    }
  });
}

// ─── Startup ──────────────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════╗");
console.log("║        AlgivixAI WhatsApp Bot        ║");
console.log("║    Developed by EMEMZYVISUALS        ║");
console.log("║         DIGITALS  🚀                 ║");
console.log("╚══════════════════════════════════════╝\n");
console.log("[Bot] Starting up...");

connectToWhatsApp().catch((err) => {
  console.error("[Bot] Fatal startup error:", err);
  process.exit(1);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n[Bot] Shutting down gracefully...");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("[Bot] Uncaught exception:", err.message);
  logger.error(err, "Uncaught exception");
});

process.on("unhandledRejection", (reason) => {
  console.error("[Bot] Unhandled rejection:", reason);
  logger.error(reason, "Unhandled rejection");
});
