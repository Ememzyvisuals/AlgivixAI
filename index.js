/**
 * index.js - AlgivixAI WhatsApp Bot
 * Developer: EMEMZYVISUALS DIGITALS
 * Auth: Pairing Code
 */

require("dotenv").config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  PHONENUMBER_MCC,
} = require("@whiskeysockets/baileys");

const pino     = require("pino");
const cron     = require("node-cron");
const path     = require("path");
const http     = require("http"); // ← Keeps Render happy (open port)
const readline = require("readline");

const { processCommand, handleTask, handleRules } = require("./commands");
const {
  analyzeMessage,
  issueWarning,
  buildWarningMessage,
  buildAdminAlert,
} = require("./moderation");

// ─── Keep-alive HTTP server (required by Render Web Service) ──────────────────
// Render requires at least one open port. This tiny server satisfies that.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("AlgivixAI is running ✅");
}).listen(PORT, () => console.log(`[HTTP] Keep-alive server on port ${PORT}`));

// ─── Config ───────────────────────────────────────────────────────────────────
const SESSION_DIR   = path.join(__dirname, "session");
const PHONE_NUMBER  = (process.env.BOT_PHONE_NUMBER || "").replace(/\D/g, "");
const TARGET_GROUP  = process.env.TARGET_GROUP_JID  || null;
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS    || "").split(",").filter(Boolean);

const baileysLogger = pino({ level: "silent" });

let sock;
let pairingDone = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function sendMsg(jid, text) {
  try { await sock.sendMessage(jid, { text }); }
  catch (e) { console.error("[sendMsg]", e.message); }
}

async function isAdmin(groupJid, senderJid) {
  try {
    const m = await sock.groupMetadata(groupJid);
    return m.participants.some(
      p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
    );
  } catch { return false; }
}

async function getAdmins(groupJid) {
  try {
    const m = await sock.groupMetadata(groupJid);
    return m.participants
      .filter(p => p.admin === "admin" || p.admin === "superadmin")
      .map(p => p.id);
  } catch { return []; }
}

function askPhone() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\n📱 Enter WhatsApp number (country code + number, no + or spaces)\n   e.g. 2347012345678\n> ", ans => {
      rl.close();
      resolve(ans.trim().replace(/\D/g, ""));
    });
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
    const text      = mc.conversation || mc.extendedTextMessage?.text || mc.imageMessage?.caption || "";
    if (!text.trim()) return;

    console.log(`[${isGroup ? "GRP" : "DM"}] ${senderJid.split("@")[0]}: ${text.slice(0, 80)}`);

    if (isGroup) {
      const adminUser = await isAdmin(jid, senderJid);
      if (!adminUser) {
        const { isViolation, reason, severity } = analyzeMessage(senderJid, text);
        if (isViolation) {
          const { count, shouldNotifyAdmin } = issueWarning(senderJid);
          await sendMsg(jid, buildWarningMessage(senderJid, reason, count));
          if (shouldNotifyAdmin) {
            for (const a of await getAdmins(jid))
              await sendMsg(a, buildAdminAlert(senderJid, reason, text));
          }
          if (severity === "high") return;
        }
      }
      const reply = await processCommand(text, adminUser);
      if (reply) await sendMsg(jid, reply);
    } else {
      const reply = await processCommand(text, false);
      if (reply) await sendMsg(jid, reply);
      else if (text.startsWith("!")) await sendMsg(jid, "❓ Unknown command. Try *!help*");
    }
  } catch (e) { console.error("[onMessage]", e.message); }
}

// ─── Cron Jobs ────────────────────────────────────────────────────────────────
function setupCron() {
  if (!TARGET_GROUP) { console.warn("[Cron] No TARGET_GROUP_JID — skipping"); return; }
  cron.schedule("0 7 * * 1-5", async () =>
    sendMsg(TARGET_GROUP, `🌅 *Good Morning, Algivix Dev Team!*\n━━━━━━━━━━━━━━━━━━━━\n` + handleTask() + `\n\n💡 Use *!ai <question>* for help!`));
  cron.schedule("0 8 * * 1", async () =>
    sendMsg(TARGET_GROUP, `👋 *Weekly Reminder*\n` + handleRules()));
  cron.schedule("0 15 * * 5", async () =>
    sendMsg(TARGET_GROUP, `🎉 *Friday Check-in!*\n✅ Done?\n🔄 In progress?\n🚧 Blockers?\n\nGreat work this week! 💪`));
  console.log("[Cron] ✅ Jobs scheduled");
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();
  console.log(`[Bot] Baileys v${version.join(".")}`);

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    // ↑ Using Ubuntu/Chrome fingerprint — more stable for pairing code on cloud
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Pairing code: request as soon as socket connects, before registration ──
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Request pairing code the moment we get a connection
    // but only if we haven't registered yet and haven't already requested
    if (qr && !state.creds.registered && !pairingDone) {
      pairingDone = true; // prevent duplicate requests

      let phone = PHONE_NUMBER;
      if (!phone) phone = await askPhone();

      if (!phone || phone.length < 7) {
        console.error("❌ Invalid phone. Set BOT_PHONE_NUMBER in .env");
        process.exit(1);
      }

      console.log(`\n[Bot] Requesting pairing code for: +${phone}`);

      try {
        // Baileys emits QR first — we intercept and request code instead
        const code      = await sock.requestPairingCode(phone);
        const formatted = (code || "").match(/.{1,4}/g)?.join("-") || code;

        console.log("\n╔══════════════════════════════════════════╗");
        console.log("║      📲  WHATSAPP PAIRING CODE           ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log(`║              ${formatted}                 ║`);
        console.log("╚══════════════════════════════════════════╝");
        console.log("\n  1. Open WhatsApp on your phone");
        console.log("  2. Settings → Linked Devices → Link a Device");
        console.log("  3. Tap → 'Link with phone number instead'");
        console.log(`  4. Enter: ${formatted}`);
        console.log("\n⏳ Waiting for you to enter the code...\n");
      } catch (err) {
        console.error("❌ Pairing code failed:", err.message);
        console.error("   Fix: Check BOT_PHONE_NUMBER, delete ./session, restart");
        pairingDone = false; // allow retry
      }
    }

    if (connection === "open") {
      console.log("\n✅ AlgivixAI ONLINE!");
      console.log(`📱 Number: ${sock.user?.id?.split(":")[0]}`);
      console.log("🤖 Listening for messages...\n");
      setupCron();
    }

    if (connection === "close") {
      const code            = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[Bot] Closed (code ${code}) — reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        pairingDone = false;
        console.log("[Bot] Reconnecting in 5s...");
        setTimeout(connect, 5000);
      } else {
        console.log("[Bot] Logged out — delete ./session and restart");
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

connect().catch(err => { console.error("[Fatal]", err); process.exit(1); });

process.on("SIGINT",             () => { console.log("\nShutting down..."); process.exit(0); });
process.on("uncaughtException",  e  => console.error("[Uncaught]", e.message));
process.on("unhandledRejection", r  => console.error("[Unhandled]", r));
