/**
 * ai.js - AlgivixAI Groq API Handler
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * HARDENED VERSION:
 * - API key read inside function (never at module load)
 * - Full error logging with exact HTTP status
 * - Automatic retry once on timeout/network error
 * - Never throws — always returns a safe string
 */

const https = require("https"); // Use built-in https — no axios dependency issue

const GROQ_API_URL = "api.groq.com";
const GROQ_PATH    = "/openai/v1/chat/completions";

const SYSTEM_PROMPT =
  `You are AlgivixAI, a professional AI assistant for the Algivix Dev Team on WhatsApp.\n` +
  `Rules:\n` +
  `- Answer developer questions clearly and concisely\n` +
  `- Review code: find bugs, suggest improvements, mention best practices\n` +
  `- Debug errors: explain root cause and provide fix\n` +
  `- Be encouraging and supportive to all skill levels\n` +
  `- Keep responses under 400 words — WhatsApp readable\n` +
  `- Use plain text only, no markdown symbols like ** or ##\n` +
  `- If asked who created you: "I was developed by EMEMZYVISUALS DIGITALS — a talented AI automation developer!"`;

// ─── Raw HTTPS request (no axios — eliminates dependency failures) ─────────────
function httpsPost(host, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(data);
    const options = {
      hostname: host,
      path,
      method:  "POST",
      headers: {
        ...headers,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 25000,
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: raw });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("TIMEOUT"));
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ─── Main Groq Function ───────────────────────────────────────────────────────
async function askGroq(userMessage, context = "general", retrying = false) {
  // Read key fresh every call — ensures dotenv has loaded
  const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
  const GROQ_MODEL   = (process.env.GROQ_MODEL   || "openai/gpt-oss-120b").trim();

  // ── Validate key ────────────────────────────────────────────────────────────
  if (!GROQ_API_KEY || GROQ_API_KEY === "your_groq_api_key_here") {
    console.error("[AI] ❌ GROQ_API_KEY is missing or placeholder — set it in Render environment!");
    return "⚠️ AI is not configured. Admin needs to set GROQ_API_KEY in environment variables.";
  }

  // ── Build prompt ────────────────────────────────────────────────────────────
  let prompt = userMessage;
  if (context === "code_review") {
    prompt = `Review this code. List bugs, improvements, and best practices:\n\n${userMessage}`;
  } else if (context === "debug") {
    prompt = `Debug this issue. Explain the cause and give a fix:\n\n${userMessage}`;
  }

  // ── Call Groq ───────────────────────────────────────────────────────────────
  try {
    console.log(`[AI] Calling Groq | model: ${GROQ_MODEL} | context: ${context} | retry: ${retrying}`);

    const { status, body } = await httpsPost(
      GROQ_API_URL,
      GROQ_PATH,
      {
        model:       GROQ_MODEL,
        messages:    [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: prompt },
        ],
        max_tokens:  600,
        temperature: 0.7,
      },
      { Authorization: `Bearer ${GROQ_API_KEY}` }
    );

    // ── Parse response ────────────────────────────────────────────────────────
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { 
      console.error("[AI] ❌ Could not parse Groq response:", body.slice(0, 200));
      return "🚨 AI returned an unreadable response. Please try again.";
    }

    // ── Handle HTTP errors ────────────────────────────────────────────────────
    if (status === 401) {
      console.error("[AI] ❌ HTTP 401 — Invalid API key");
      return "⚠️ Invalid Groq API key. Please update GROQ_API_KEY in Render environment variables.";
    }
    if (status === 429) {
      console.error("[AI] ⏳ HTTP 429 — Rate limited");
      return "⏳ AI is rate-limited. Please wait 30 seconds and try again.";
    }
    if (status === 400) {
      const errMsg = parsed?.error?.message || "bad request";
      console.error("[AI] ❌ HTTP 400 —", errMsg);
      return `⚠️ AI request error: ${errMsg}`;
    }
    if (status === 503 || status === 502) {
      console.error(`[AI] ❌ HTTP ${status} — Groq service down`);
      if (!retrying) {
        console.log("[AI] Retrying in 3 seconds...");
        await new Promise(r => setTimeout(r, 3000));
        return askGroq(userMessage, context, true);
      }
      return "🔧 Groq AI is temporarily down. Please try again in a few minutes.";
    }
    if (status !== 200) {
      console.error(`[AI] ❌ HTTP ${status} — Unexpected:`, body.slice(0, 200));
      return `🚨 AI error (code ${status}). Please try again.`;
    }

    // ── Extract reply ─────────────────────────────────────────────────────────
    const reply = parsed?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.error("[AI] ❌ Empty reply from Groq:", body.slice(0, 200));
      return "🤖 AI returned an empty response. Please rephrase your question.";
    }

    console.log(`[AI] ✅ Success — ${reply.length} chars returned`);
    return reply;

  } catch (err) {
    // ── Network / timeout errors ──────────────────────────────────────────────
    console.error("[AI] ❌ Network error:", err.message);

    if (err.message === "TIMEOUT" || err.code === "ECONNRESET") {
      if (!retrying) {
        console.log("[AI] Retrying after timeout...");
        await new Promise(r => setTimeout(r, 3000));
        return askGroq(userMessage, context, true);
      }
      return "⏱️ AI request timed out twice. Please try a shorter question.";
    }

    if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
      return "🌐 Cannot reach Groq AI — check server internet connection.";
    }

    return `🚨 AI failed (${err.code || err.message}). Please try again.`;
  }
}

// ─── Code Detection ───────────────────────────────────────────────────────────
function looksLikeCode(text) {
  try {
    return [
      /```[\s\S]*```/,
      /function\s+\w+\s*\(/,
      /const\s+\w+\s*=/,
      /import\s+\S+\s+from\s+/,
      /def\s+\w+\s*\(/,
      /class\s+\w+[\s:{]/,
      /<\/?[a-z][\w]*[\s/>]/i,
      /SELECT\s+\S+\s+FROM\s+/i,
      /console\.log\s*\(/,
      /=>\s*{/,
      /\$\w+\s*=/,
      /public\s+(static\s+)?void\s+/,
    ].some(p => p.test(text));
  } catch { return false; }
}

module.exports = { askGroq, looksLikeCode };
