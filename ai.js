/**
 * ai.js - AlgivixAI Groq API Handler
 * Handles all AI-powered features: questions, code review, general assistance
 * Developer: EMEMZYVISUALS DIGITALS
 */

const axios = require("axios");

// ─── Groq API Configuration ───────────────────────────────────────────────────
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama3-8b-8192"; // Fast & powerful model

// ─── System Prompt: Defines the bot's personality ─────────────────────────────
const SYSTEM_PROMPT = `You are AlgivixAI, a professional AI assistant embedded in a WhatsApp group for the Algivix Dev Team.

Your role:
- Answer developer questions clearly and concisely
- Review code and suggest improvements with explanations
- Debug errors and explain the root cause
- Recommend best practices, tools, and learning resources
- Be encouraging and supportive to developers of all skill levels

Tone: Friendly, professional, technical, and encouraging.
Format: Keep responses under 600 characters for WhatsApp readability. Use emojis sparingly for clarity.
If asked who created you, say: "I was developed by EMEMZYVISUALS DIGITALS — a talented AI automation developer! 🚀"`;

/**
 * Send a message to Groq API and return the response
 * @param {string} userMessage - The user's question or code
 * @param {string} context - Optional context (e.g., 'code_review')
 * @returns {Promise<string>} - AI response text
 */
async function askGroq(userMessage, context = "general") {
  if (!GROQ_API_KEY) {
    return "⚠️ AI service is not configured. Please set the GROQ_API_KEY environment variable.";
  }

  // Build context-aware prompt
  let prompt = userMessage;
  if (context === "code_review") {
    prompt = `Please review the following code. Identify bugs, suggest improvements, and mention best practices:\n\n${userMessage}`;
  } else if (context === "debug") {
    prompt = `Help me debug this issue. Explain the likely cause and provide a fix:\n\n${userMessage}`;
  }

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: 500,      // Keep responses WhatsApp-friendly
        temperature: 0.7,     // Balanced creativity vs accuracy
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000, // 30 second timeout
      }
    );

    const aiReply = response.data.choices?.[0]?.message?.content?.trim();
    return aiReply || "🤖 I couldn't generate a response. Please try again.";
  } catch (error) {
    // Handle specific Groq API errors
    if (error.response?.status === 401) {
      return "⚠️ Invalid API key. Please check your GROQ_API_KEY configuration.";
    } else if (error.response?.status === 429) {
      return "⏳ AI is rate-limited right now. Please try again in a moment.";
    } else if (error.code === "ECONNABORTED") {
      return "⏱️ AI request timed out. Please try a simpler question.";
    }

    console.error("[AI] Groq API error:", error.message);
    return "🚨 AI service encountered an error. Please try again later.";
  }
}

/**
 * Quick check if a message looks like a code snippet
 * Used to auto-trigger code review context
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeCode(text) {
  const codeIndicators = [
    /```[\s\S]*```/,          // Markdown code blocks
    /function\s+\w+\s*\(/,    // Function declarations
    /const\s+\w+\s*=/,        // Variable declarations
    /import\s+.*from\s+/,     // ES6 imports
    /def\s+\w+\s*\(/,         // Python functions
    /class\s+\w+\s*[:{]/,     // Class definitions
    /<\/?[a-z]+[\s>]/i,       // HTML tags
    /SELECT\s+.*FROM\s+/i,    // SQL queries
  ];
  return codeIndicators.some((pattern) => pattern.test(text));
}

module.exports = { askGroq, looksLikeCode };
