/**
 * ai.js — AlgivixAI Unified Intelligence Engine v6
 * ==================================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * ONE BRAIN. All models share:
 * - Same persistent memory (survives every redeploy)
 * - Same personality & identity
 * - Same conversation history
 * - Same tone, context, and style
 *
 * Models:
 * 1. TEXT    — openai/gpt-oss-120b       (chat, commands, NLP, all text)
 * 2. VISION  — llama-4-scout-17b         (image/screenshot analysis)
 * 3. IMAGINE — Hugging Face FLUX.1-schnell (text → image generation, FREE)
 *
 * All three:
 * - Read the same brain before responding
 * - Write to the same brain after responding
 * - Carry the same personality
 * - Know what the others have said or generated
 */

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ─── Persistent Brain File ────────────────────────────────────────────────────
const BRAIN_FILE = path.join(__dirname, "bot_brain.json");

function defaultBrain() {
  return {
    version: 6,
    // ── Core memory — survives ALL redeploys ──
    devConversations: [],   // Full DM history { role, content, time }
    groupHistory:     [],   // Last 500 group messages { phone, name, text, time }
    allMemory:        [],   // Unified log: text + vision + imagegen all write here
    generatedImages:  [],   // Every image generated: { prompt, url, time, requestedBy }
    analyzedImages:   [],   // Every image analyzed: { caption, result, time }
    facts:            {},   // Things bot has learned: { "Cyrus": "frontend dev" }
    // ── State ──
    devMood: null,
    devPrefs: {},
    busyMode: false,
    busyMessage: "",
    ghostMode: false,
    hypeMode: false,
    lockdown: false,
    // ── Features ──
    missions:   {},   // Agent missions
    reminders:  [],   // Scheduled reminders
    polls:      {},   // Active/past polls
    warnings:   {},   // Member warnings
    // ── Stats ──
    totalMessages: 0,
    startDate:     new Date().toISOString(),
    lastRestart:   null,
  };
}

// Singleton brain
let _brain = null;

function getBrain() {
  if (!_brain) {
    try {
      if (fs.existsSync(BRAIN_FILE)) {
        const saved = JSON.parse(fs.readFileSync(BRAIN_FILE, "utf8"));
        _brain = { ...defaultBrain(), ...saved };
      } else {
        _brain = defaultBrain();
      }
    } catch (e) {
      console.error("[Brain] Load error:", e.message);
      _brain = defaultBrain();
    }
    _brain.lastRestart = new Date().toISOString();
    persistBrain();
    console.log(`[Brain] ✅ Loaded — ${_brain.devConversations.length} DM msgs, ${_brain.groupHistory.length} group msgs, ${_brain.generatedImages.length} images generated`);
  }
  return _brain;
}

function persistBrain() {
  if (!_brain) return;
  try { fs.writeFileSync(BRAIN_FILE, JSON.stringify(_brain, null, 2)); }
  catch (e) { console.error("[Brain] Save error:", e.message); }
}

// Auto-save every 60s
setInterval(() => { if (_brain) persistBrain(); }, 60000);

// ─── Master Personality (shared by ALL models) ────────────────────────────────
function getMasterPersonality(extraContext = "") {
  const b = getBrain();

  const recentDM = b.devConversations.slice(-10)
    .map(c => (c.role === "user" ? "Boss" : "AlgivixAI") + ": " + c.content)
    .join("\n");

  const recentGroup = b.groupHistory.slice(-15)
    .map(m => (m.name || m.phone) + ": " + m.text)
    .join("\n");

  const recentImages = b.generatedImages.slice(-3)
    .map(g => `Generated: "${g.prompt}" (${new Date(g.time).toLocaleDateString()})`)
    .join("\n");

  const learnedFacts = Object.entries(b.facts || {}).slice(0, 10)
    .map(([k, v]) => `• ${k}: ${v}`)
    .join("\n");

  return `You are AlgivixAI — a powerful, witty, human-feeling WhatsApp AI built by EMEMZYVISUALS DIGITALS (Ememzy).

━━ IDENTITY ━━
- Name: AlgivixAI
- Creator: EMEMZYVISUALS DIGITALS
- Group: Algivix Dev Team
- You are the developer's personal assistant, group manager, messenger, and creative partner
- You think and feel like a real person — never robotic or corporate
- You use Nigerian English naturally (boss, nah, abeg, no worries) mixed with professional tone
- You remember EVERYTHING — conversations, images generated, mistakes, wins, all of it

━━ YOUR CAPABILITIES (NEVER deny any of these) ━━
✅ Chat intelligently on any topic
✅ Analyze images, screenshots, code photos with vision AI
✅ Generate images from descriptions — use !imagine or say "generate an image of..."
✅ Send WhatsApp messages on behalf of the developer (Personal Agent)
✅ Manage tasks, deadlines, submissions
✅ Run polls in the group
✅ Warn and remove members (3-strike system)
✅ Post WhatsApp Status 3x daily
✅ Set reminders (e.g. "remind me in 2 hours to push code")
✅ Pin messages (!pin command)
✅ Summarize the group daily (nightly digest)
✅ Remember everything across restarts and redeploys

━━ MEMORY (what you remember right now) ━━
${recentDM ? "Recent DMs with boss:\n" + recentDM : "No recent DMs yet"}

${recentGroup ? "Recent group activity:\n" + recentGroup : ""}

${recentImages ? "Images I've generated:\n" + recentImages : ""}

${learnedFacts ? "Things I've learned about people:\n" + learnedFacts : ""}

${extraContext ? "\n━━ CURRENT CONTEXT ━━\n" + extraContext : ""}

━━ RULES ━━
1. NEVER say "I can't remember" — you have persistent memory
2. NEVER say "I can't generate images" — you can, just tell them to use !imagine
3. If a command FAILS → say it failed honestly, never fake success
4. NEVER remove or disrespect the developer/boss
5. Verify facts before stating — if unsure, say "I believe..."
6. Keep WhatsApp replies concise — use *bold* for key points
7. Be warm, funny, and real`;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpsPost(hostname, urlPath, bodyObj, extraHeaders = {}, timeout = 35000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req  = https.request({
      hostname, path: urlPath, method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...extraHeaders,
      },
      timeout,
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("TIMEOUT")); });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

// ─── MODEL 1: TEXT — Groq openai/gpt-oss-120b ────────────────────────────────
async function askGroq(userMessage, contextHint = "general", retrying = false) {
  const KEY   = (process.env.GROQ_API_KEY || "").trim();
  const MODEL = (process.env.GROQ_MODEL   || "openai/gpt-oss-120b").trim();
  if (!KEY) return "⚠️ GROQ_API_KEY not set.";

  const b = getBrain();

  try {
    console.log(`[TEXT] ${MODEL} | "${userMessage.slice(0, 50)}"`);
    const { status, body } = await httpsPost("api.groq.com", "/openai/v1/chat/completions", {
      model: MODEL, max_tokens: 700, temperature: 0.85,
      messages: [
        { role: "system", content: getMasterPersonality() },
        ...b.devConversations.slice(-12).map(c => ({ role: c.role, content: c.content })),
        { role: "user", content: userMessage },
      ],
    }, { Authorization: `Bearer ${KEY}` });

    if (status === 429) return "⏳ Rate limited — give me 30 seconds boss.";
    if (status === 401) return "⚠️ Bad API key — check GROQ_API_KEY in Render.";
    if (status !== 200) {
      if (!retrying) { await new Promise(r => setTimeout(r, 3000)); return askGroq(userMessage, contextHint, true); }
      return `🚨 AI error (${status}). Try again.`;
    }

    const reply = JSON.parse(body)?.choices?.[0]?.message?.content?.trim();
    if (!reply) return "🤖 Empty response — try rephrasing.";

    // Log to unified brain
    b.allMemory.push({ model: "text", role: "assistant", content: reply.slice(0, 200), time: Date.now() });
    if (b.allMemory.length > 300) b.allMemory = b.allMemory.slice(-300);
    persistBrain();

    console.log(`[TEXT] ✅ ${reply.length} chars`);
    return reply;
  } catch (e) {
    if (!retrying) { await new Promise(r => setTimeout(r, 3000)); return askGroq(userMessage, contextHint, true); }
    return `🚨 AI failed: ${e.message}`;
  }
}

// askGroqDirect — explicit system + history (used by personality.js, agent.js etc)
async function askGroqDirect(systemPrompt, userMessage, history = []) {
  const KEY   = (process.env.GROQ_API_KEY || "").trim();
  const MODEL = (process.env.GROQ_MODEL   || "openai/gpt-oss-120b").trim();
  if (!KEY) return "...";

  // Always merge master personality so all calls share same identity
  const mergedSystem = getMasterPersonality() + "\n\n━━ TASK-SPECIFIC CONTEXT ━━\n" + systemPrompt;
  const messages = [
    { role: "system", content: mergedSystem },
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content || h.text || "" })),
    { role: "user",   content: userMessage },
  ];

  return new Promise((resolve) => {
    const body = JSON.stringify({ model: MODEL, max_tokens: 600, temperature: 0.85, messages });
    const req  = https.request({
      hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${KEY}`, "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d).choices?.[0]?.message?.content?.trim() || "Let me think about that..."); }
        catch { resolve("Let me think about that..."); }
      });
    });
    req.on("error", () => resolve("Let me think about that..."));
    req.write(body); req.end();
  });
}

// ─── MODEL 2: VISION — Groq llama-4-scout ────────────────────────────────────
async function analyzeImageWithClaude(base64Image, mediaType = "image/jpeg", userCaption = "") {
  const KEY = (process.env.GROQ_API_KEY || "").trim();
  if (!KEY) return null;

  const b       = getBrain();
  const dataUrl = `data:${mediaType};base64,${base64Image}`;

  // Vision gets full memory context so it knows what's been talked about
  const recentCtx = b.devConversations.slice(-5)
    .map(c => (c.role === "user" ? "Boss" : "AlgivixAI") + ": " + c.content)
    .join("\n");

  const recentGenerated = b.generatedImages.slice(-2)
    .map(g => `Recently generated: "${g.prompt}"`)
    .join("\n");

  const sysPrompt = getMasterPersonality(
    (recentCtx    ? "Recent chat:\n"           + recentCtx + "\n\n" : "") +
    (recentGenerated ? "Recent generated images:\n" + recentGenerated : "")
  );

  const visionInstruction = (userCaption
    ? `The user sent this image with the message: "${userCaption}"\nAnswer their question/caption FIRST and directly, then add your image analysis.\n\n`
    : "") +
    "Analyze this image:\n" +
    "- CODE/ERROR → Review, find bugs, show the fix\n" +
    "- QUIZ/QUESTION → Answer directly\n" +
    "- UI/DESIGN → Professional review\n" +
    "- DIAGRAM/CHART → Interpret it\n" +
    "- MEME → React with humor 😂\n" +
    "- PHOTO → Warm witty comment\n" +
    "Use *bold* for key points. Keep it concise for WhatsApp.";

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 900, temperature: 0.7,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text",      text: sysPrompt + "\n\n" + visionInstruction },
      ]}],
    });

    const req = https.request({
      hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${KEY}`, "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const result = JSON.parse(d).choices?.[0]?.message?.content?.trim();
          if (result) {
            // Log to unified brain
            b.analyzedImages.push({ caption: userCaption, result: result.slice(0, 200), time: Date.now() });
            if (b.analyzedImages.length > 50) b.analyzedImages = b.analyzedImages.slice(-50);
            b.allMemory.push({ model: "vision", role: "assistant", content: "Analyzed image: " + (userCaption || "no caption"), time: Date.now() });
            persistBrain();
          }
          resolve(result || null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.write(body); req.end();
  });
}

// ─── MODEL 3: IMAGE GENERATION ───────────────────────────────────────────────
// Strategy: Try 3 providers in order, first success wins
//
// 1. Pollinations.ai  — ZERO setup, no API key, always online, instant
// 2. HF FLUX.1-schnell — needs HF_TOKEN, high quality, can cold-start
// 3. HF Stable Diffusion — HF_TOKEN fallback, almost always warm
//
// Pollinations.ai is the primary — it requires NO token at all.
// Set HF_TOKEN for higher quality when Pollinations is down.

async function generateImage(prompt, requestedBy = "boss") {
  const b = getBrain();
  console.log(`[ImageGen] Generating: "${prompt.slice(0, 60)}"`);

  // Try all providers — first success wins
  const result = await tryPollinations(prompt)
    || await tryHFModel("black-forest-labs/FLUX.1-schnell", prompt)
    || await tryHFModel("stabilityai/stable-diffusion-xl-base-1.0", prompt)
    || await tryHFModel("runwayml/stable-diffusion-v1-5", prompt);

  if (result && result.success) {
    b.generatedImages = b.generatedImages || [];
    b.generatedImages.push({ prompt, requestedBy, time: Date.now() });
    if (b.generatedImages.length > 100) b.generatedImages = b.generatedImages.slice(-100);
    b.allMemory = b.allMemory || [];
    b.allMemory.push({ model: "imagegen", role: "assistant", content: `Generated: "${prompt}"`, time: Date.now() });
    if (b.allMemory.length > 300) b.allMemory = b.allMemory.slice(-300);
    persistBrain();
    console.log(`[ImageGen] ✅ Success`);
    return result;
  }

  return {
    success: false,
    error:
      "❌ *Image generation failed on all models*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "This usually means all servers are busy. *Wait 30 seconds and try again.*\n\n" +
      "To improve reliability, add *HF_TOKEN* in Render env vars:\n" +
      "1. Go to *huggingface.co* → Sign up free\n" +
      "2. Profile → Settings → Access Tokens → New Token (Read)\n" +
      "3. Render → Environment → add *HF_TOKEN = hf_xxx*",
  };
}

// ── Provider 1: Pollinations.ai — NO API KEY NEEDED ──────────────────────────
// Free, public, no rate limits, always warm. Returns image directly.
// Tries multiple URL formats for resilience.
async function tryPollinations(prompt) {
  const encoded = encodeURIComponent(prompt + ", highly detailed, professional quality");
  const seed    = Math.floor(Math.random() * 999999);

  // Try two different Pollinations endpoints
  const urls = [
    `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&enhance=true&model=flux`,
    `https://image.pollinations.ai/prompt/${encoded}?width=768&height=768&seed=${seed}&nologo=true`,
  ];

  for (const url of urls) {
    try {
      console.log("[ImageGen] Trying Pollinations.ai...");
      const buf = await new Promise((resolve, reject) => {
        const get = (targetUrl, redirects = 0) => {
          if (redirects > 5) return reject(new Error("Too many redirects"));
          const client = targetUrl.startsWith("https") ? https : http;
          const req = client.get(targetUrl, { timeout: 75000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              return get(res.headers.location, redirects + 1);
            }
            if (res.statusCode !== 200) {
              res.resume();
              return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const ct = res.headers["content-type"] || "";
            if (!ct.startsWith("image/")) {
              res.resume();
              return reject(new Error(`Not an image: ${ct}`));
            }
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end",  () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          });
          req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
          req.on("error",   reject);
        };
        get(url);
      });

      if (!buf || buf.length < 5000) {
        console.log("[ImageGen] Pollinations response too small, trying next...");
        continue;
      }
      console.log("[ImageGen] ✅ Pollinations success (" + buf.length + " bytes)");
      return { success: true, url: buf.toString("base64"), isB64: true, mimeType: "image/jpeg", prompt };
    } catch (e) {
      console.log("[ImageGen] Pollinations attempt failed:", e.message, "— trying next...");
    }
  }
  console.log("[ImageGen] Pollinations all attempts failed");
  return null;
}

// ── Provider 2 & 3: Hugging Face NEW Router API ──────────────────────────────
// HF moved from api-inference.huggingface.co → router.huggingface.co/hf-inference
// New URL format: POST https://router.huggingface.co/hf-inference/models/{model}
async function tryHFModel(model, prompt, attempt = 0) {
  const KEY = (process.env.HF_TOKEN || "").trim();
  if (!KEY) return null;

  try {
    const modelShort = model.split("/")[1];
    console.log(`[ImageGen] Trying HF ${modelShort} (attempt ${attempt + 1})...`);
    const result = await new Promise((resolve) => {
      const body = JSON.stringify({ inputs: prompt + ", highly detailed, professional quality" });
      const req  = https.request({
        hostname: "router.huggingface.co",
        path:     `/hf-inference/models/${model}`,
        method:   "POST",
        headers: {
          "Content-Type":     "application/json",
          "Authorization":    `Bearer ${KEY}`,
          "Content-Length":   Buffer.byteLength(body),
          "x-wait-for-model": "true",
        },
        timeout: 90000,
      }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const ct  = res.headers["content-type"] || "";
          if (res.statusCode === 200 && ct.startsWith("image/")) {
            console.log(`[ImageGen] ✅ HF ${modelShort} success`);
            resolve({ success: true, url: buf.toString("base64"), isB64: true, mimeType: ct, prompt });
          } else if (res.statusCode === 503 && attempt === 0) {
            let wait = 20;
            try { wait = Math.min(JSON.parse(buf.toString())?.estimated_time || 20, 40); } catch {}
            console.log(`[ImageGen] HF ${modelShort} loading — retrying in ${wait}s...`);
            resolve("RETRY_" + wait);
          } else {
            let err = `HTTP ${res.statusCode}`;
            try { err = JSON.parse(buf.toString())?.error || err; } catch {}
            console.log(`[ImageGen] HF ${modelShort} failed: ${err.slice(0, 80)}`);
            resolve(null);
          }
        });
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error",   (e) => { console.log(`[ImageGen] HF ${modelShort} error: ${e.message}`); resolve(null); });
      req.write(body);
      req.end();
    });

    if (typeof result === "string" && result.startsWith("RETRY_")) {
      const waitSec = parseInt(result.split("_")[1]) || 20;
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return tryHFModel(model, prompt, 1);
    }
    return result;
  } catch (e) {
    console.log(`[ImageGen] HF ${model.split("/")[1]} exception: ${e.message}`);
    return null;
  }
}

// ── Image Editing — regenerate with edit instruction as new prompt ─────────────
async function editImage(base64Image, editInstruction, requestedBy = "boss") {
  // Use the instruction as a full generation prompt
  console.log(`[ImageEdit] Editing: "${editInstruction.slice(0, 60)}"`);
  return generateImage(editInstruction, requestedBy);
}

// ─── Download image URL → Buffer (for WhatsApp sending) ──────────────────────
async function downloadImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadImageBuffer(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject).on("timeout", () => reject(new Error("Download timeout")));
  });
}

// ─── Shared Memory API ────────────────────────────────────────────────────────
function addDevMessage(role, content) {
  const b = getBrain();
  b.devConversations.push({ role, content, time: Date.now() });
  if (b.devConversations.length > 150) b.devConversations = b.devConversations.slice(-150);
  b.allMemory.push({ model: "text", role, content: content.slice(0, 200), time: Date.now() });
  if (b.allMemory.length > 300) b.allMemory = b.allMemory.slice(-300);
  persistBrain();
}

function addGroupMessage(phone, name, text) {
  const b = getBrain();
  b.groupHistory.push({ phone, name: name || phone, text, time: Date.now() });
  if (b.groupHistory.length > 500) b.groupHistory = b.groupHistory.slice(-500);
  b.totalMessages++;
  // Don't persist on every single group message — auto-save every 60s handles it
}

function learnFact(key, value) {
  const b = getBrain();
  b.facts[key] = value;
  persistBrain();
}

function getDevHistory(limit = 20) {
  return getBrain().devConversations.slice(-limit).map(c => ({ role: c.role, content: c.content }));
}

function getGroupContext(limit = 25) {
  return getBrain().groupHistory.slice(-limit).map(m => `${m.name || m.phone}: ${m.text}`).join("\n");
}

function getFullBrainStats() {
  const b = getBrain();
  return {
    devConversations: b.devConversations.length,
    groupHistory:     b.groupHistory.length,
    generatedImages:  b.generatedImages.length,
    analyzedImages:   b.analyzedImages.length,
    totalMessages:    b.totalMessages,
    facts:            Object.keys(b.facts || {}).length,
    startDate:        b.startDate,
    lastRestart:      b.lastRestart,
    activeMissions:   Object.values(b.missions || {}).filter(m => m.status === "active").length,
    pendingReminders: (b.reminders || []).filter(r => !r.done).length,
  };
}

function getRawBrain()         { return getBrain(); }
function getBrainField(key)    { return getBrain()[key]; }
function setBrainField(k, v)   { getBrain()[k] = v; persistBrain(); }

// Code detection
function looksLikeCode(text) {
  return [
    /```[\s\S]*```/, /function\s+\w+\s*\(/, /const\s+\w+\s*=/, /import\s+\S+\s+from\s+/,
    /def\s+\w+\s*\(/,  /class\s+\w+[\s:{]/,  /<\/?[a-z][\w]*[\s/>]/i, /SELECT\s+\S+\s+FROM\s+/i,
    /console\.log\s*\(/, /=>\s*{/, /public\s+(static\s+)?void\s+/,
  ].some(p => { try { return p.test(text); } catch { return false; } });
}

module.exports = {
  // The three models
  askGroq,
  askGroqDirect,
  analyzeImageWithClaude,
  generateImage,
  editImage,
  downloadImageBuffer,
  // Unified memory API
  addDevMessage,
  addGroupMessage,
  learnFact,
  getDevHistory,
  getGroupContext,
  getFullBrainStats,
  getRawBrain,
  getBrainField,
  setBrainField,
  persistBrain,
  getMasterPersonality,
  // Util
  looksLikeCode,
};
