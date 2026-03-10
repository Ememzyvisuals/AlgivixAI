/**
 * ai.js - AlgivixAI Groq API Handler
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * FIX: API key is now read inside the function (not at module load time)
 * so dotenv always has time to populate process.env first.
 */

const axios = require("axios");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `You are AlgivixAI, a professional AI assistant for the Algivix Dev Team on WhatsApp.

Your role:
- Answer developer questions clearly and concisely
- Review code and suggest improvements with explanations
- Debug errors and explain the root cause
- Recommend best practices, tools, and learning resources
- Be encouraging and supportive to all skill levels

Tone: Friendly, professional, technical, encouraging.
Format: Keep responses under 500 words. Use plain text — no markdown (WhatsApp does not render it).
If asked who created you: "I was developed by EMEMZYVISUALS DIGITALS — a talented AI automation developer! 🚀"`;

/**
 * Ask Groq AI a question and return the response text.
 * @param {string} userMessage
 * @param {string} context - "general" | "code_review" | "debug"
 * @returns {Promise<string>}
 */
async function askGroq(userMessage, context = "general") {

  // ── Read key here (not at module load) so dotenv is guaranteed to have run ──
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const GROQ_MODEL   = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

  // ── Diagnose missing key immediately ──────────────────────────────────────
  if (!GROQ_API_KEY || GROQ_API_KEY.trim() === "" || GROQ_API_KEY === "your_groq_api_key_here") {
    console.error("[AI] ❌ GROQ_API_KEY is missing or not set in environment variables!");
    return "⚠️ AI is not configured yet. Please set GROQ_API_KEY in your environment variables.";
  }

  // ── Build context-aware prompt ────────────────────────────────────────────
  let prompt = userMessage;
  if (context === "code_review") {
    prompt = `Review this code. Point out bugs, improvements, and best practices:\n\n${userMessage}`;
  } else if (context === "debug") {
    prompt = `Help debug this. Explain the cause and provide a fix:\n\n${userMessage}`;
  }

  try {
    console.log(`[AI] Calling Groq (model: ${GROQ_MODEL}, context: ${context})...`);

    const response = await axios.post(
      GROQ_API_URL,
      {
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: prompt },
        ],
        max_tokens:  800,
        temperature: 0.7,
      },
      {
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type":  "application/json",
        },
        timeout: 30000,
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content?.trim();
    console.log("[AI] ✅ Groq responded successfully");
    return reply || "🤖 No response generated. Please try again.";

  } catch (error) {
    // ── Detailed error logging so you can see exactly what went wrong ────────
    const status  = error.response?.status;
    const errBody = error.response?.data?.error?.message || error.message;

    console.error(`[AI] ❌ Groq API error — HTTP ${status || "N/A"}: ${errBody}`);

    if (status === 401) return "⚠️ Invalid Groq API key. Please check GROQ_API_KEY in your environment variables.";
    if (status === 429) return "⏳ AI rate limit reached. Please wait a moment and try again.";
    if (status === 400) return `⚠️ Bad request to AI: ${errBody}`;
    if (status === 503) return "🔧 Groq AI is temporarily unavailable. Try again shortly.";
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") return "⏱️ AI request timed out. Please try again.";
    if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return "🌐 No internet connection. Please check the server network.";

    return `🚨 AI error (${status || error.code || "unknown"}). Check server logs for details.`;
  }
}

/**
 * Detect if a message looks like a code snippet.
 * Used to auto-switch to code_review context.
 */
function looksLikeCode(text) {
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
  ].some(p => p.test(text));
}

module.exports = { askGroq, looksLikeCode };
