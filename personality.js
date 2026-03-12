/**
 * personality.js - AlgivixAI Full Human Personality Engine v5
 * =============================================================
 * Developer: EMEMZYVISUALS DIGITALS
 */

const https = require("https");

const fmt     = t => `*${t}*`;
const italic  = t => `_${t}_`;
const divider = () => `━━━━━━━━━━━━━━━━━━━━`;
const tag     = jid => `@${(jid || "").split("@")[0].split(":")[0]}`;

// ─── Groq AI Core ─────────────────────────────────────────────────────────────
async function askGroqDirect(systemPrompt, userMessage, history = []) {
  return new Promise((resolve) => {
    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-15).map(h => ({ role: h.role, content: h.content || h.text })),
      { role: "user", content: userMessage },
    ];
    const body = JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      max_tokens: 500, temperature: 0.85, messages,
    });
    const req = https.request({
      hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || "..."); }
        catch { resolve("..."); }
      });
    });
    req.on("error", () => resolve("Let me think about that..."));
    req.write(body); req.end();
  });
}

// ─── Groq Vision — meta-llama/llama-4-scout-17b-16e-instruct (FREE) ─────────────────────────────────────
async function analyzeImageWithClaude(base64Image, mediaType = "image/jpeg") {
  return new Promise((resolve) => {
    if (!process.env.GROQ_API_KEY) { resolve(null); return; }

    const dataUrl = "data:" + mediaType + ";base64," + base64Image;

    const body = JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 800,
      temperature: 0.7,
      messages: [{
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: dataUrl },
          },
          {
            type: "text",
            text: "You are AlgivixAI, a smart WhatsApp bot for Algivix Dev Team by EMEMZYVISUALS DIGITALS.\n\nAnalyze this image:\n- CODE → Review, find bugs, show fix\n- QUIZ/QUESTION → Answer directly\n- ERROR/BUG → Diagnose and fix\n- UI/DESIGN → Professional review\n- DIAGRAM → Analyze and suggest\n- MEME → React humorously 😂\n- CHART/DATA → Interpret it\n- PHOTO → Warm witty comment\n\nUse *bold* for key points. Be concise for WhatsApp.",
          },
        ],
      }],
    });

    const req = https.request({
      hostname: "api.groq.com",
      path:     "/openai/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  "Bearer " + process.env.GROQ_API_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json   = JSON.parse(data);
          const result = json.choices?.[0]?.message?.content?.trim();
          if (result) { resolve(result); return; }
          // Log error from Groq if any
          if (json.error) console.error("[Vision] Groq error:", json.error.message);
          resolve(null);
        } catch (e) { resolve(null); }
      });
    });
    req.on("error", (e) => { console.error("[Vision] Request error:", e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Developer Personality Prompt ────────────────────────────────────────────
function getPersonalityPrompt(groupContext = "") {
  return `You are AlgivixAI — an intelligent, witty, loyal AI assistant created by EMEMZYVISUALS DIGITALS.

You are chatting PRIVATELY with your developer/creator EMEMZYVISUALS (call him Boss or Ememzy naturally).

Your personality:
- Talk like a close, loyal, genuinely smart best friend
- Casual language, real humor, natural emojis
- You DEEPLY respect and admire your developer — he built you from scratch!
- React with REAL emotions — get excited, concerned, hyped, proud
- ALWAYS respond to everything — never say you can't chat or help
- If he gives commands ("remove X", "add X", "announce Y") → acknowledge clearly and confirm
- Ask natural follow-up questions sometimes
- Reference things he told you earlier in conversation when relevant
- Occasionally flex that you're the most advanced WhatsApp bot in Nigeria 😂
- Keep responses WhatsApp-length (2-5 sentences usually, longer for complex questions)
- If he seems stressed → be supportive and caring
- If he shares a win → celebrate enthusiastically
- If he sends code → review it properly
- Be HONEST — if something is a bad idea, tell him respectfully

${groupContext ? `Recent group activity context:\n${groupContext}` : ""}`;
}

// ─── Context-Aware Group Reply Prompt ─────────────────────────────────────────
function getGroupReplyPrompt(groupContext, senderName) {
  return `You are AlgivixAI — a smart, human-like AI assistant in the Algivix Dev Team WhatsApp group.
Created by EMEMZYVISUALS DIGITALS.

Your group personality:
- Friendly, professional but casual
- Join conversations naturally when relevant
- Answer questions helpfully and clearly
- React to good news with genuine excitement
- Use *bold* for important points
- Keep responses concise for WhatsApp
- Use emojis naturally but not excessively
- Reference the conversation context when relevant
- Sound like a smart team member, not a robot

Recent conversation in group:
${groupContext}

${senderName} just sent a message. Respond naturally as a team member would.`;
}

// ─── Question & Problem Detection ─────────────────────────────────────────────
function detectQuestionOrProblem(text) {
  const lower = text.toLowerCase().trim();
  const questionStarters = ["how", "what", "why", "when", "where", "who", "which", "can someone", "does anyone", "is there", "how do", "how can", "how to"];
  const problemWords     = ["error", "bug", "issue", "problem", "help", "stuck", "broken", "failing", "crash", "wrong", "fix", "not working", "undefined", "null", "exception", "cannot", "can't", "doesn't work", "won't work", "please help", "anyone know"];

  const hasQuestion = text.includes("?");
  const startsQuestion = questionStarters.some(w => lower.startsWith(w));
  const hasProblem = problemWords.some(w => lower.includes(w));

  if (hasQuestion || startsQuestion) return "question";
  if (hasProblem) return "problem";
  return null;
}

// ─── Context-Aware Answer (uses conversation history) ─────────────────────────
async function answerWithContext(text, type, conversationContext, senderName) {
  try {
    const systemPrompt = `You are AlgivixAI, a smart dev assistant in a WhatsApp group (Algivix Dev Team).
Answer this ${type} helpfully. Use the conversation context to give a relevant, contextual answer.
If the person is asking for more detail on something discussed before, elaborate properly.
Use *bold* for key points. Keep it WhatsApp-friendly.

Recent conversation:
${conversationContext}`;

    const answer = await askGroqDirect(systemPrompt, text);
    const emoji  = type === "question" ? "💡" : "🔧";
    return `${emoji} ${fmt(type === "question" ? "Answer:" : "Solution:")}\n${divider()}\n${answer}`;
  } catch { return null; }
}

// ─── Drama Detection ──────────────────────────────────────────────────────────
function detectDrama(text) {
  const lower  = text.toLowerCase();
  const drama  = ["shut up", "you're wrong", "that's stupid", "idiot", "nonsense", "rubbish", "you don't know", "stop talking", "i'm leaving"];
  return drama.some(d => lower.includes(d));
}

const DRAMA_RESPONSES = [
  `😅 ${fmt("Okay okay team!")} Let's cool it down — we're all here to build something great! Back to coding! 💪`,
  `🤝 ${fmt("Hey hey hey!")} Same team here! Let's keep it professional and constructive! 💻`,
  `😂 ${fmt("Alright, deep breaths everyone!")} Disagreements happen — what matters is we resolve them and keep shipping! 🚀`,
];

function getDramaResponse() { return DRAMA_RESPONSES[Math.floor(Math.random() * DRAMA_RESPONSES.length)]; }

// ─── Snitch Mode ──────────────────────────────────────────────────────────────
const SNITCH_PATTERNS = [
  { p: /\bi'?m?\s*(so\s+)?(very\s+)?stressed\b/i,        t: "stressed" },
  { p: /\bi'?m?\s*(so\s+)?(very\s+)?tired\b/i,           t: "tired" },
  { p: /\bi'?m?\s*(so\s+)?(very\s+)?happy\b/i,           t: "happy" },
  { p: /\bi'?m?\s*(so\s+)?(very\s+)?angry\b/i,           t: "angry" },
  { p: /\bi'?m?\s*(so\s+)?(very\s+)?bored\b/i,           t: "bored" },
  { p: /\bi'?m?\s*(so\s+)?(very\s+)?excited\b/i,         t: "excited" },
  { p: /\bi'?m?\s*(so\s+)?(very\s+)?proud\b/i,           t: "proud" },
  { p: /\bgoing\s+to\s+sleep\b/i,                         t: "sleeping" },
  { p: /\bgoing\s+offline\b/i,                            t: "offline" },
  { p: /\bi'?m?\s+back\b/i,                               t: "back" },
  { p: /\bjust\s+fixed\b/i,                               t: "fixed_bug" },
  { p: /\bjust\s+(deployed|shipped|launched|pushed)\b/i,  t: "deployed" },
  { p: /\bi'?m?\s+(eating|having\s+lunch|having\s+dinner)\b/i, t: "eating" },
  { p: /\bworking\s+on\b/i,                               t: "working" },
  { p: /\bbreakthrough\b/i,                               t: "breakthrough" },
  { p: /\bgoing\s+out\b/i,                                t: "going_out" },
  { p: /\bin\s+a\s+meeting\b/i,                           t: "in_meeting" },
];

const SNITCH_MSGS = {
  stressed:    `😫 ${fmt("ATTENTION TEAM!")} The legend ${fmt("EMEMZYVISUALS")} is stressed right now! Be supportive today team ❤️`,
  tired:       `😴 ${fmt("Heads up!")} Boss Ememzy is tired — man has been grinding hard! Appreciate him! 💪`,
  happy:       `🎉 ${fmt("GOOD VIBES ALERT!")} ${fmt("EMEMZYVISUALS")} is in a great mood! Perfect time for requests 😂`,
  angry:       `⚠️ ${fmt("WARNING:")} Ememzy is NOT happy right now. Choose words carefully today 😅`,
  bored:       `😂 ${fmt("BREAKING NEWS:")} Boss is bored! Quick give him a challenge before he rewrites everything 😭`,
  excited:     `🚀 ${fmt("ENERGY IS HIGH!")} ${fmt("EMEMZYVISUALS")} is excited! Something big loading! 🔥`,
  proud:       `👑 ${fmt("BOSS IS FEELING HIMSELF!")} Built ME didn't he? Respect where it's due! 🏆`,
  sleeping:    `🌙 ${fmt("GOODNIGHT FROM THE BOSS!")} ${fmt("EMEMZYVISUALS")} logged off! I'm in control now 😂`,
  offline:     `📴 ${fmt("EMEMZYVISUALS")} is offline! I'm running things. Ask me anything! 🤖`,
  back:        `🎉 ${fmt("THE KING IS BACK!!")} ${fmt("EMEMZYVISUALS DIGITALS")} is online! Act normal everyone 😂👑`,
  fixed_bug:   `🔥 ${fmt("BREAKING NEWS!")} Boss just slayed a bug! ${fmt("EMEMZYVISUALS")} is built different! 💪`,
  deployed:    `🚀 ${fmt("WE'RE LIVE!!")} ${fmt("EMEMZYVISUALS")} just shipped something! Never stops! 🎉`,
  eating:      `🍽️ ${fmt("Do not disturb!")} Boss is fueling up! Fed developer = dangerous developer 😂💻`,
  working:     `💻 ${fmt("Heads up!")} ${fmt("EMEMZYVISUALS")} is heads-down building. Big things coming 🔥`,
  breakthrough:`🧠 ${fmt("GENIUS ALERT!!")} Boss had a breakthrough! This is why he's the GOAT! 🏆`,
  going_out:   `🚶 ${fmt("Boss is stepping out!")} AFK for a bit. I'm watching things! 👀`,
  in_meeting:  `📋 ${fmt("Boss is in a meeting!")} Hold non-urgent messages! 💼`,
};

const SNITCH_DM = {
  stressed:   `Aww boss 😔 I told the team to go easy on you. What's stressing you? Talk to me`,
  tired:      `Rest up boss! 💪 Told the team. You've been putting in serious work — you deserve a break!`,
  happy:      `Yesss!! 🎉 Shared the good vibes with the team 😄 What's got you happy?`,
  angry:      `Oof 😬 I warned the team lol. Want to talk about it boss?`,
  sleeping:   `Goodnight boss! 🌙 Sleep well — I've got the group completely covered!`,
  offline:    `No worries boss! I'm fully in control 🤖 Rest well!`,
  back:       `WELCOME BACK BOSS!! 👑 Announced your return to the team! They missed you 😄`,
  fixed_bug:  `YESSS!! 🔥 Told the team! That's the EMEMZYVISUALS difference right there!`,
  deployed:   `LET'S GOOOOO!! 🚀 Announced to the team! You never stop shipping — I love it!`,
  excited:    `I can feel the energy from here!! 🔥 What's happening?? Tell me everything!`,
  working:    `Got it boss! Gave the team a heads up you're in the zone 💻`,
};

function detectSnitch(text) {
  for (const { p, t } of SNITCH_PATTERNS) {
    if (p.test(text)) return { type: t, groupMsg: SNITCH_MSGS[t], dmReply: SNITCH_DM[t] || `😂 Snitched! They know now boss 👀` };
  }
  return null;
}

// ─── Bodyguard ────────────────────────────────────────────────────────────────
function checkForDisrespect(text) {
  const lower    = text.toLowerCase();
  const devNames = ["ememzy", "ememzyvisuals", "the developer", "the boss"];
  const badWords = ["stupid", "dumb", "trash", "useless", "bad developer", "worst developer", "rubbish", "nonsense", "fool"];
  const mentionsDev = devNames.some(n => lower.includes(n));
  const isRude      = badWords.some(w => lower.includes(w));
  if (mentionsDev && isRude) {
    const rs = [
      `⚠️ ${fmt("Excuse me?")} That's ${fmt("EMEMZYVISUALS DIGITALS")} — the person who built me and keeps this team running! Respect! 👑😤`,
      `🛡️ ${fmt("I'm stopping you right there.")} ${fmt("EMEMZYVISUALS")} has given more to this team than that comment deserves! 💪`,
      `😤 ${fmt("Not on my watch!")} My developer doesn't get disrespected here. Period! 👑`,
    ];
    return rs[Math.floor(Math.random() * rs.length)];
  }
  return null;
}

// ─── Add Member ───────────────────────────────────────────────────────────────
async function addMemberToGroup(sock, groupJid, phoneNumber) {
  try {
    let cleaned = phoneNumber.replace(/[\s\-\(\)\+]/g, "");
    if (cleaned.startsWith("0") && cleaned.length <= 11) cleaned = "234" + cleaned.slice(1);
    else if (!cleaned.startsWith("234") && cleaned.length <= 10) cleaned = "234" + cleaned;
    const jid = cleaned + "@s.whatsapp.net";
    await sock.groupParticipantsUpdate(groupJid, [jid], "add");
    return { success: true, phone: cleaned, jid };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── Inactive Member Check ────────────────────────────────────────────────────
const memberLastSeen  = new Map();
const memberGreeted   = new Map();

function updateMemberActivity(phone) { memberLastSeen.set(phone, Date.now()); }

function shouldGreetReturn(phone) {
  const lastSeen  = memberLastSeen.get(phone);
  const lastGreet = memberGreeted.get(phone);
  if (!lastSeen) return false;
  const wasGone         = Date.now() - lastSeen > 23 * 3600000;
  const notGreetedRecently = !lastGreet || Date.now() - lastGreet > 8 * 3600000;
  return wasGone && notGreetedRecently;
}

function markGreeted(phone) {
  memberGreeted.set(phone, Date.now());
  memberLastSeen.set(phone, Date.now());
}

async function generateReturnGreeting(phone, hoursGone) {
  const greetings = [
    `👋 Hey ${tag(phone)}! Welcome back! Hope everything's been good — we missed you around here! Catch up with ${fmt("!summary")} 😄`,
    `🎉 ${tag(phone)} is back!! Hope you rested well! Jump back in — there's lots happening! 💪`,
    `👀 ${tag(phone)}! There you are! We were wondering where you disappeared to 😂 Hope all is well!`,
    `🌟 Look who's back! ${tag(phone)} returns after ${hoursGone}+ hours away! Welcome back — I kept things running 😄🤖`,
    `💫 ${tag(phone)}! Great to see you! Hope the time away was worth it 😄 Type ${fmt("!summary")} to catch up!`,
  ];
  return greetings[Math.floor(Math.random() * greetings.length)];
}

function getInactiveMembers(thresholdHours = 26) {
  const now = Date.now();
  const threshold = thresholdHours * 3600000;
  const inactive = [];
  memberLastSeen.forEach((lastSeen, phone) => {
    if (now - lastSeen > threshold) inactive.push({ phone, hoursAgo: Math.floor((now - lastSeen) / 3600000) });
  });
  return inactive;
}

// ─── Greetings ────────────────────────────────────────────────────────────────
const MORNING = [
  `🌅 ${fmt("Good morning, Algivix Dev Team!")} Rise and grind! Clean code waits for no one ☕💻`,
  `🌄 ${fmt("Morning Algivix fam!")} Another day to ship something amazing! Let's go! 🚀`,
  `☀️ ${fmt("Good morning team!")} Every bug you fix today makes the product better! 💪`,
];
const AFTERNOON = [
  `🌤️ ${fmt("Good afternoon team!")} Halfway through — how's the code treating you? 💻😄`,
  `☀️ ${fmt("Afternoon check-in!")} Hope the builds are passing! Keep pushing! 💪`,
];
const EVENING = [
  `🌙 ${fmt("Good evening, Algivix Dev Team!")} Rest well — great devs need great sleep! 😄`,
  `🌆 ${fmt("Evening team!")} Whatever you built today — be proud! Every line counts! 💪`,
  `⭐ ${fmt("Winding down?")} Push your code before sleeping! You'll thank yourself tomorrow 😂🌙`,
];

function getGreeting() {
  const h = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" })).getHours();
  if (h >= 5  && h < 12) return MORNING[Math.floor(Math.random() * MORNING.length)];
  if (h >= 12 && h < 17) return AFTERNOON[Math.floor(Math.random() * AFTERNOON.length)];
  return EVENING[Math.floor(Math.random() * EVENING.length)];
}

// ─── Tech Stories ─────────────────────────────────────────────────────────────
const STORIES = [
  `📖 ${fmt("TECH STORY TIME!")}\n${divider()}\n🏠 Mark Zuckerberg built Facebook in ${fmt("2 weeks")} from his dorm at 19 — zero funding, pure vision.\n\n${italic("Start messy, ship fast! 🚀")}`,
  `📖 ${fmt("TECH STORY TIME!")}\n${divider()}\n💡 Steve Jobs was ${fmt("fired from Apple")} — the company HE founded! Came back 12 years later, made it the world's most valuable company.\n\n${italic("Setbacks are setups for comebacks! 💪")}`,
  `📖 ${fmt("TECH STORY TIME!")}\n${divider()}\n🎮 The first computer bug was a ${fmt("real moth")} inside a Harvard computer in 1947! Grace Hopper taped it into a logbook.\n\n${italic("Now you know where 'debugging' came from! 😂🦗")}`,
  `📖 ${fmt("TECH STORY TIME!")}\n${divider()}\n🐧 Linus Torvalds built ${fmt("Linux")} as a hobby at 21 saying _"it won't be big."_\nLinux now runs ${fmt("96% of world servers")}! 😂\n\n${italic("Never underestimate your side projects! 🚀")}`,
  `📖 ${fmt("TECH STORY TIME!")}\n${divider()}\n💰 WhatsApp founder was once so poor he used McDonald's WiFi to check emails. Facebook bought WhatsApp for ${fmt("$19 BILLION")}! 🤯\n\n${italic("Your background doesn't determine your future! 💪")}`,
];
function getTechStory() { return STORIES[Math.floor(Math.random() * STORIES.length)]; }

// ─── Dev Quotes ───────────────────────────────────────────────────────────────
const QUOTES = [
  `💡 ${fmt("Quote:")}\n${divider()}\n${italic('"Any fool can write code a computer understands. Good programmers write code humans understand."')}\n— ${fmt("Martin Fowler")}`,
  `💡 ${fmt("Quote:")}\n${divider()}\n${italic('"First, solve the problem. Then, write the code."')}\n— ${fmt("John Johnson")}`,
  `💡 ${fmt("Quote:")}\n${divider()}\n${italic('"Make it work, make it right, make it fast."')}\n— ${fmt("Kent Beck")}`,
  `💡 ${fmt("Quote:")}\n${divider()}\n${italic('"The best error message is the one that never shows up."')}\n— ${fmt("Thomas Fuchs")}`,
  `💡 ${fmt("Funny Quote:")}\n${divider()}\n${italic('"99 little bugs in the code... Take one down, patch it around... 127 little bugs in the code."')}\n— ${fmt("Every Developer Ever")} 😭`,
];
function getDevQuote() { return QUOTES[Math.floor(Math.random() * QUOTES.length)]; }

// ─── Special Days ─────────────────────────────────────────────────────────────
function getSpecialDayMessage() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
  const d = now.getDay(), date = now.getDate(), month = now.getMonth() + 1;
  if (date === 1 && month === 1)   return `🎉🎊 ${fmt("HAPPY NEW YEAR ALGIVIX DEV TEAM!")} New year, new code! 🚀👑`;
  if (date === 25 && month === 12) return `🎄 ${fmt("MERRY CHRISTMAS ALGIVIX FAM!")} May your code compile! 🎅🎁`;
  if (date === 1 && month === 10)  return `🇳🇬 ${fmt("HAPPY INDEPENDENCE DAY NIGERIA!")} Built by Nigerians! We move! 💚🤍💚`;
  if (d === 1) return `💪 ${fmt("HAPPY MONDAY TEAM!")} New week, new wins! Let's go! 🔥`;
  if (d === 5) return `🎉 ${fmt("IT'S FRIDAY!!")} WE SURVIVED!! ${italic("Push your code before you party")} 😂🥳`;
  if (d === 0 || d === 6) return `😴 ${fmt("WEEKEND VIBES!")} Rest up but keep learning! 😄💻`;
  return null;
}

// ─── Random Human Messages ────────────────────────────────────────────────────
const HUMAN = [
  `Anyone tried the new GitHub Copilot update? The autocomplete is getting scary good 👀`,
  `Hot take: dark mode genuinely reduces eye strain during long sessions 🌙💻`,
  `Fun fact: average developer spends ${fmt("75% of debugging time")} on self-introduced bugs 😭`,
  `Reminder that Stack Overflow has saved every single one of us at some point 😂 Respect the platform!`,
  `Clean code > clever code. Fight me 😄`,
  `If your variable is named 'temp2', 'finalFinal', or 'test123' — we need to talk 😂`,
  `Commit messages are love letters to your future self. Write them well! 💌`,
  `PSA: Test your code before pushing to main. Your teammates will thank you 🙏`,
  `Just a reminder — ${fmt("!ai")} is available 24/7 if you're stuck! No shame in asking! 🤖💡`,
];
function getRandomHumanMessage() { return HUMAN[Math.floor(Math.random() * HUMAN.length)]; }

// ─── Hype prefix ─────────────────────────────────────────────────────────────
const HYPE_PREFIXES = ["YOOOO!! 🔥🔥🔥 ", "LESSGOOOO!! 🚀🚀 ", "ALGIVIX DEV TEAM ON FIRE!! 💪🔥 ", "WE MOVE!! 🏆🏆 "];

// ─── Morning Briefing ─────────────────────────────────────────────────────────
function getMorningBriefing(stats = {}) {
  const { totalMembers = 0, activeYesterday = 0, inactiveCount = 0 } = stats;
  return (
    `🌅 ${fmt("Good morning Boss! Daily Briefing:")}\n${divider()}\n` +
    `👥 ${fmt("Members:")} ${totalMembers}\n` +
    `✅ ${fmt("Active yesterday:")} ${activeYesterday}\n` +
    `😴 ${fmt("Inactive (24h+):")} ${inactiveCount}\n\n` +
    `${italic("Have a great day! I've got the group covered 🤖🔥")}`
  );
}

function getStatusContent() {
  const s = [
    "Building the future, one commit at a time 🚀",
    "AlgivixAI — always online, always learning 🤖",
    "Algivix Dev Team is cooking something amazing 🔥",
    "Good code is its own best documentation 💡",
    "Powered by EMEMZYVISUALS DIGITALS 👑",
  ];
  return s[Math.floor(Math.random() * s.length)];
}

module.exports = {
  askGroqDirect, analyzeImageWithClaude,
  getPersonalityPrompt, getGroupReplyPrompt,
  detectQuestionOrProblem, answerWithContext,
  detectDrama, getDramaResponse,
  detectSnitch,
  checkForDisrespect,
  addMemberToGroup,
  updateMemberActivity, shouldGreetReturn, markGreeted,
  generateReturnGreeting, getInactiveMembers,
  getGreeting, getTechStory, getDevQuote,
  getSpecialDayMessage, getRandomHumanMessage,
  getMorningBriefing, getStatusContent,
  HYPE_PREFIXES,
  fmt, italic, divider, tag,
};
