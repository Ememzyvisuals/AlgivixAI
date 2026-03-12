/**
 * nlp.js - AlgivixAI Natural Language Processor
 * ===============================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * Detects and executes natural language commands from developer DMs
 * e.g: "send this to the group", "remove Huzaifa", "tag everyone about the API"
 */

const https = require("https");

const fmt     = t => `*${t}*`;
const italic  = t => `_${t}_`;
const divider = () => `━━━━━━━━━━━━━━━━━━━━`;

// ─── Groq for NLP ─────────────────────────────────────────────────────────────
async function extractIntent(text, conversationHistory = []) {
  return new Promise((resolve) => {
    const recentHistory = conversationHistory
      .slice(-10)
      .map(c => `${c.role}: ${c.content || c.text}`)
      .join("\n");

    const body = JSON.stringify({
      model:       process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      max_tokens:  300,
      temperature: 0.1,
      messages: [{
        role: "system",
        content: `You are an intent classifier for a WhatsApp bot assistant. 
Given a message from the developer, classify the intent and extract parameters.

Return ONLY valid JSON like:
{
  "intent": "send_to_group" | "remove_member" | "add_member" | "tag_everyone" | "tag_member" | "announce" | "broadcast" | "post_status" | "list_members" | "mute_member" | "unmute_member" | "share_context" | "start_trivia" | "start_meeting" | "end_meeting" | "roast" | "none",
  "message": "the message/content to send if applicable",
  "target": "phone number or name if mentioned",
  "reference_topic": "topic from conversation to reference if 'about X' is mentioned",
  "confidence": 0.0-1.0
}

Recent conversation context:
${recentHistory}`
      }, {
        role: "user",
        content: text,
      }],
    });

    const req = https.request({
      hostname: "api.groq.com",
      path:     "/openai/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const raw  = JSON.parse(data).choices?.[0]?.message?.content || "{}";
          const clean = raw.replace(/```json|```/g, "").trim();
          resolve(JSON.parse(clean));
        } catch { resolve({ intent: "none", confidence: 0 }); }
      });
    });
    req.on("error", () => resolve({ intent: "none", confidence: 0 }));
    req.write(body);
    req.end();
  });
}

// ─── Generate context-based group message ─────────────────────────────────────
async function generateContextMessage(topic, conversationHistory) {
  return new Promise((resolve) => {
    const historyText = conversationHistory
      .slice(-20)
      .map(c => `${c.role}: ${c.content || c.text}`)
      .join("\n");

    const body = JSON.stringify({
      model:       process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      max_tokens:  300,
      temperature: 0.7,
      messages: [{
        role: "system",
        content: `You are AlgivixAI posting a message to the Algivix Dev Team WhatsApp group on behalf of EMEMZYVISUALS DIGITALS.

Based on the conversation history below, create a group message about the topic mentioned.
Make it clear, professional but casual, and suitable for a dev team WhatsApp group.
Use *bold* for key points. Keep it under 100 words.

Conversation history:
${historyText}`
      }, {
        role: "user",
        content: `Create a group message about: ${topic}`,
      }],
    });

    const req = https.request({
      hostname: "api.groq.com",
      path:     "/openai/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ─── NLP Patterns (fast regex — no API call needed) ──────────────────────────
const FAST_PATTERNS = [
  // Send to group
  { regex: /^send\s+(.+?)\s+to\s+the\s+group$/i,           intent: "send_to_group",  extract: m => ({ message: m[1] }) },
  { regex: /^tell\s+the\s+group\s+(.+)$/i,                  intent: "send_to_group",  extract: m => ({ message: m[1] }) },
  { regex: /^post\s+(?:this\s+)?(?:to\s+the\s+group\s*:?\s*)(.+)$/i, intent: "send_to_group", extract: m => ({ message: m[1] }) },
  { regex: /^announce\s*:?\s*(.+)$/i,                       intent: "announce",       extract: m => ({ message: m[1] }) },

  // Tag + send about a topic
  { regex: /^tag\s+(?:every(?:one|body)|all(?:\s+members)?)\s+(?:and\s+)?(?:tell|send|say|about)\s+(.+)$/i, intent: "tag_everyone", extract: m => ({ message: m[1] }) },
  { regex: /^tag\s+(?:every(?:one|body)|all(?:\s+members)?)$/i, intent: "tag_everyone", extract: () => ({}) },
  { regex: /^tag\s+@?(\d{7,15})\s+(?:and\s+)?(?:tell|send|say)\s+(.+)$/i, intent: "tag_member", extract: m => ({ target: m[1], message: m[2] }) },

  // Remove member
  { regex: /^(?:remove|kick)\s+@?(\d{7,15})(?:\s+from\s+(?:the\s+)?group)?$/i, intent: "remove_member", extract: m => ({ target: m[1] }) },
  { regex: /^(?:remove|kick)\s+(\w+)(?:\s+from\s+(?:the\s+)?group)?$/i,        intent: "remove_member", extract: m => ({ target: m[1] }) },

  // Add member
  { regex: /^add\s+\+?(\d{7,15})(?:\s+to\s+(?:the\s+)?group)?$/i,             intent: "add_member",    extract: m => ({ target: m[1] }) },

  // List members
  { regex: /^(?:list|show)\s+(?:all\s+)?members?$/i,                           intent: "list_members",  extract: () => ({}) },
  { regex: /^how\s+many\s+members/i,                                           intent: "list_members",  extract: () => ({}) },

  // Status
  { regex: /^post\s+status\s*:?\s*(.+)$/i,                                     intent: "post_status",   extract: m => ({ message: m[1] }) },

  // Trivia
  { regex: /^(?:start\s+)?trivia$/i,                                           intent: "start_trivia",  extract: () => ({}) },

  // Meeting
  { regex: /^start\s+(?:a\s+)?meeting$/i,                                      intent: "start_meeting", extract: () => ({}) },
  { regex: /^end\s+(?:the\s+)?meeting$/i,                                      intent: "end_meeting",   extract: () => ({}) },

  // Roast
  { regex: /^roast\s+@?(\d{7,15})(?:\s+(.+))?$/i,                             intent: "roast",         extract: m => ({ target: m[1], message: m[2] || "" }) },
  { regex: /^roast\s+(\w+)(?:\s+(.+))?$/i,                                    intent: "roast",         extract: m => ({ target: m[1], message: m[2] || "" }) },

  // Share previous conversation context to group
  { regex: /^(?:share|send|post|tell\s+(?:the\s+)?group)\s+(?:about|something\s+about|what\s+we\s+(?:discussed|talked|said)\s+about)\s+(.+)$/i, intent: "share_context", extract: m => ({ reference_topic: m[1] }) },
  { regex: /^(?:what\s+we\s+discussed|our\s+discussion|previous\s+chat)\s+about\s+(.+)\s+(?:to|in)\s+(?:the\s+)?group$/i, intent: "share_context", extract: m => ({ reference_topic: m[1] }) },
];

// These are purely conversational phrases — NEVER treat as commands
const CHAT_ONLY_PATTERNS = [
  /^(hi|hey|hello|sup|xup|yo|what'?s? ?up|how are you|how far|how you dey)/i,
  /^(yeah|yes|no|nope|ok|okay|sure|cool|nice|great|wow|lol|😂|🔥|💪)/i,
  /^(i think|i feel|i want|i need|i was|i am|i'm|just|maybe|probably)/i,
  /^(something to do with|thinking about|working on|planning to)/i,
  /^(that's|this is|it's|its|what do you|can you tell|do you think)/i,
];

async function detectIntent(text, conversationHistory = []) {
  const lower = text.toLowerCase().trim();

  // Short messages (under 6 words) are almost always chat — skip AI
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < 6) return { intent: "none", confidence: 0 };

  // Purely conversational — never treat as commands
  for (const p of CHAT_ONLY_PATTERNS) {
    if (p.test(lower)) return { intent: "none", confidence: 0 };
  }

  // Try fast regex patterns first (exact matches only)
  for (const { regex, intent, extract } of FAST_PATTERNS) {
    const m = text.match(regex);
    if (m) {
      const params = extract(m);
      return { intent, confidence: 1.0, ...params };
    }
  }

  // For longer, unambiguous messages — use AI with high confidence bar
  if (text.length > 25) {
    const aiResult = await extractIntent(text, conversationHistory);
    if (aiResult.confidence >= 0.92) return aiResult;  // Very high threshold
  }

  return { intent: "none", confidence: 0 };
}

// ─── !Glist — Full Dev Guide ──────────────────────────────────────────────────
function getGList() {
  return (
    `👑 ${fmt("AlgivixAI — Developer DM Guide")}\n${divider()}\n` +
    `${italic("You are EMEMZYVISUALS DIGITALS — my creator. Here's everything I respond to in DM:")}\n\n` +

    `📤 ${fmt("SEND TO GROUP")}\n` +
    `• _send <message> to the group_\n` +
    `• _tell the group <message>_\n` +
    `• _post to the group: <message>_\n` +
    `• _announce: <message>_\n` +
    `Example: _send the standup starts at 10AM to the group_\n\n` +

    `🏷️ ${fmt("TAG MEMBERS")}\n` +
    `• _tag everyone_\n` +
    `• _tag everyone and tell them <message>_\n` +
    `• _tag @number and say <message>_\n` +
    `Example: _tag everyone and tell them meeting is cancelled_\n\n` +

    `🧠 ${fmt("SHARE CONTEXT FROM OUR CHAT")}\n` +
    `• _share what we discussed about <topic> to the group_\n` +
    `• _send something about <topic> to the group_\n` +
    `• _tell the group about our API discussion_\n` +
    `Example: _share what we discussed about the database issue to the group_\n\n` +

    `➕ ${fmt("ADD MEMBER")}\n` +
    `• _add +2349012345678_\n` +
    `• _add 08012345678_\n\n` +

    `➖ ${fmt("REMOVE MEMBER")}\n` +
    `• _remove @2349012345678_\n` +
    `• _kick 2349012345678 from the group_\n\n` +

    `👥 ${fmt("MEMBER INFO")}\n` +
    `• _list members_ / _show members_\n` +
    `• _how many members_\n\n` +

    `📱 ${fmt("STATUS")}\n` +
    `• _post status: <message>_\n` +
    `Example: _post status: Building something crazy 🔥_\n\n` +

    `📢 ${fmt("BROADCAST (via DM)")}\n` +
    `• _!broadcast <message>_\n\n` +

    `🎮 ${fmt("FUN")}\n` +
    `• _start trivia_ — Post trivia in group\n` +
    `• _roast @number <reason>_ — Roast someone 😂\n` +
    `• _start meeting_ / _end meeting_\n\n` +

    `🔐 ${fmt("SECRET GROUP COMMANDS")}\n` +
    `${italic("(Say in the group without !):")}\n` +
    `• _ghost mode_ — Go silent 👻\n` +
    `• _hype mode_ — Get hyped 🔥\n` +
    `• _lockdown_ — Admin only mode\n` +
    `• _nuke warnings_ — Clear all warnings\n` +
    `• _bot stats_ — Full analytics\n` +
    `• _reset mvp_ / _reset trivia_\n\n` +

    `💬 ${fmt("SNITCH MODE 😂")}\n` +
    `${italic("Say any of these in DM — I post to group:")}\n` +
    `• _I'm stressed/tired/happy/angry/bored_\n` +
    `• _Going to sleep / Going offline_\n` +
    `• _I'm back_\n` +
    `• _Just deployed / Just fixed_\n` +
    `• _Working on..._\n\n` +

    `🖼️ ${fmt("SHARE IMAGES")}\n` +
    `• Send me any image in DM\n` +
    `• Then say: _share to group_\n\n` +

    `💡 ${fmt("PLUS")}\n` +
    `• Just chat normally — I respond to everything!\n` +
    `• Ask me anything — I remember our conversation\n` +
    `• Give me any instruction — I execute it\n\n` +

    `${divider()}\n` +
    `${italic("Built by")} ${fmt("EMEMZYVISUALS DIGITALS")} 👑🔥\n` +
    `${italic("AlgivixAI v5 — Most advanced WhatsApp bot in Nigeria! 🇳🇬")}`
  );
}

module.exports = { detectIntent, generateContextMessage, getGList };
