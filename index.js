/**
 * index.js - AlgivixAI WhatsApp Bot — Main Entry Point
 * =====================================================
 * Developer: EMEMZYVISUALS DIGITALS
 * Auth: Pairing Code (no QR needed)
 */

require("dotenv").config(); // Load .env variables FIRST

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const pino      = require("pino");
const cron      = require("node-cron");
const path      = require("path");
const readline  = require("readline");

const { processCommand, handleTask, handleRules } = require("./commands");
const {
  analyzeMessage,
  issueWarning,
  buildWarningMessage,
  buildAdminAlert,
} = require("./moderation");

// ─── Config ───────────────────────────────────────────────────────────────────
const SESSION_DIR     = path.join(__dirname, "session");
const PHONE_NUMBER    = (process.env.BOT_PHONE_NUMBER || "").replace(/\D/g, "");
const TARGET_GROUP    = process.env.TARGET_GROUP_JID  || null;
const ADMIN_NUMBERS   = (process.env.ADMIN_NUMBERS    || "").split(",").filter(Boolean);

// Silent Baileys logger — remove 'silent' → 'debug' if you need to troubleshoot
const logger = pino({ level: "silent" });

let sock;
let pairingCodeRequested = false; // Guard: only request once per session

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function sendMessage(jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    console.error(`[Send] Failed → ${jid}:`, err.message);
  }
}

async function isGroupAdmin(groupJid, senderJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    return meta.participants.some(
      (p) => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
    );
  } catch { return false; }
}

async function getGroupAdmins(groupJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    return meta.participants
      .filter((p) => p.admin === "admin" || p.admin === "superadmin")
      .map((p) => p.id);
  } catch { return []; }
}

function askPhoneNumber() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      "\n📱 Enter bot WhatsApp number (country code + number, no spaces or +)\n   e.g. 2347012345678\n> ",
      (ans) => { rl.close(); resolve(ans.trim().replace(/\D/g, "")); }
    );
  });
}

// ─── Message Handler ──────────────────────────────────────────────────────────
async function onMessage(msg) {
  try {
    if (msg.key.fromMe) return;

    const jid       = msg.key.remoteJid;
    const senderJid = msg.key.participant || jid;
    const isGroup   = isJidGroup(jid);
    const mc        = msg.message || {};

    const text =
      mc.conversation ||
      mc.extendedTextMessage?.text ||
      mc.imageMessage?.caption ||
      "";

    if (!text.trim()) return;

    console.log(`[${isGroup ? "GRP" : "DM"}] ${senderJid.split("@")[0]}: ${text.slice(0, 80)}`);

    if (isGroup) {
      const adminInGroup = await isGroupAdmin(jid, senderJid);

      if (!adminInGroup) {
        const { isViolation, reason, severity } = analyzeMessage(senderJid, text);
        if (isViolation) {
          const { count, shouldNotifyAdmin } = issueWarning(senderJid);
          await sendMessage(jid, buildWarningMessage(senderJid, reason, count));
          if (shouldNotifyAdmin) {
            const alert  = buildAdminAlert(senderJid, reason, text);
            const admins = await getGroupAdmins(jid);
            for (const a of admins) await sendMessage(a, alert);
          }
          if (severity === "high") return;
        }
      }

      const reply = await processCommand(text, adminInGroup);
      if (reply) await sendMessage(jid, reply);

    } else {
      const reply = await processCommand(text, false);
      if (reply) await sendMessage(jid, reply);
      else if (text.startsWith("!")) await sendMessage(jid, "❓ Unknown command. Try *!help*");
    }
  } catch (err) {
    console.error("[onMessage] Error:", err.message);
  }
}

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────
function setupCronJobs() {
  if (!TARGET_GROUP) {
    console.warn("[Cron] TARGET_GROUP_JID not set — scheduled messages disabled.");
    return;
  }

  // Daily task reminder — 8 AM WAT (UTC+1), weekdays
  cron.schedule("0 7 * * 1-5", async () => {
    await sendMessage(TARGET_GROUP,
      `🌅 *Good Morning, Algivix Dev Team!*\n━━━━━━━━━━━━━━━━━━━━\n` +
      handleTask() + `\n\n💡 Use *!ai <question>* for help!`
    );
  });

  // Weekly rules reminder — Monday 9 AM WAT
  cron.schedule("0 8 * * 1", async () => {
    await sendMessage(TARGET_GROUP,
      `👋 *Weekly Reminder — Algivix Dev Team*\nLet's stay professional!\n\n` + handleRules()
    );
  });

  // Friday check-in — 4 PM WAT
  cron.schedule("0 15 * * 5", async () => {
    await sendMessage(TARGET_GROUP,
      `🎉 *Friday Sprint Check-in!*\n\n✅ What did you complete?\n🔄 What's in progress?\n🚧 Any blockers?\n\nGreat work this week! 💪`
    );
  });

  console.log("[Cron] ✅ Scheduled jobs active");
}

// ─── Main Connection Function ──────────────────────────────────────────────────
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  console.log(`[Bot] Baileys version: ${version.join(".")}`);

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,   // We handle pairing code manually
    generateHighQualityLinkPreview: false,
    browser: ["AlgivixAI", "Safari", "3.0"],  // Safari browser tag required for pairing code
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Request pairing code once socket is open ──────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, isNewLogin } = update;

    // Request pairing code only when socket is connected but NOT yet registered
    if (
      connection === "open" &&
      !state.creds.registered &&
      !pairingCodeRequested
    ) {
      pairingCodeRequested = true;

      let phone = PHONE_NUMBER;
      if (!phone) {
        phone = await askPhoneNumber();
      }

      if (!phone || phone.length < 7) {
        console.error("[Bot] ❌ No valid phone number. Set BOT_PHONE_NUMBER in .env");
        process.exit(1);
      }

      try {
        // Wait a moment for the socket to stabilise before requesting
        await new Promise((r) => setTimeout(r, 3000));
        const code      = await sock.requestPairingCode(phone);
        const formatted = code?.match(/.{1,4}/g)?.join("-") || code;

        console.log("\n╔══════════════════════════════════════════╗");
        console.log("║      📲  WHATSAPP PAIRING CODE           ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log(`║          👉   ${formatted}   👈           ║`);
        console.log("╚══════════════════════════════════════════╝");
        console.log("\nSteps to link:");
        console.log("  1. Open WhatsApp on your phone");
        console.log("  2. Settings → Linked Devices → Link a Device");
        console.log("  3. Tap  ➜  'Link with phone number instead'");
        console.log(`  4. Enter code: ${formatted}`);
        console.log("\n⏳ Waiting for you to enter the code on your phone...\n");
      } catch (err) {
        console.error("[Bot] ❌ Pairing code request failed:", err.message);
        console.error("  → Make sure BOT_PHONE_NUMBER is correct (e.g. 2347012345678)");
        console.error("  → Delete the ./session folder and try again");
        process.exit(1);
      }
      return; // Don't proceed until phone confirms
    }

    if (connection === "open") {
      console.log("\n✅ AlgivixAI is ONLINE!");
      console.log(`📱 Connected as: ${sock.user?.id?.split(":")[0]}`);
      console.log("🤖 Listening for messages...\n");
      setupCronJobs();
    }

    if (connection === "close") {
      const code           = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.log(`[Bot] Disconnected (code ${code}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        pairingCodeRequested = false; // Reset so new session can re-pair if needed
        console.log("[Bot] Reconnecting in 5s...");
        setTimeout(connect, 5000);
      } else {
        console.log("[Bot] Logged out. Delete ./session and restart.");
        process.exit(0);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) await onMessage(msg);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════╗");
console.log("║        AlgivixAI WhatsApp Bot        ║");
console.log("║    Developed by EMEMZYVISUALS        ║");
console.log("║          DIGITALS  🚀                ║");
console.log("╚══════════════════════════════════════╝\n");

connect().catch((err) => {
  console.error("[Bot] Fatal error:", err);
  process.exit(1);
});

process.on("SIGINT",  () => { console.log("\n[Bot] Shutting down..."); process.exit(0); });
process.on("uncaughtException",  (e) => console.error("[Uncaught]", e.message));
process.on("unhandledRejection", (r) => console.error("[Unhandled]", r));
