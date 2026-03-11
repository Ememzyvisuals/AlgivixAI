/**
 * filereader.js - AlgivixAI File Reading System
 * ===============================================
 * Developer: EMEMZYVISUALS DIGITALS
 *
 * Handles: PDF, DOCX, TXT, CSV, XLSX, Images, Code files
 */

const https = require("https");
const https2 = require("https");

const fmt     = t => `*${t}*`;
const divider = () => `━━━━━━━━━━━━━━━━━━━━`;

// ─── Detect file type ─────────────────────────────────────────────────────────
function getFileType(filename = "", mimetype = "") {
  const ext  = (filename.split(".").pop() || "").toLowerCase();
  const mime = mimetype.toLowerCase();

  if (["pdf"].includes(ext) || mime.includes("pdf"))                          return "pdf";
  if (["doc", "docx"].includes(ext) || mime.includes("word"))                 return "word";
  if (["xls", "xlsx"].includes(ext) || mime.includes("excel") || mime.includes("spreadsheet")) return "excel";
  if (["csv"].includes(ext) || mime.includes("csv"))                          return "csv";
  if (["txt", "md", "log"].includes(ext) || mime.includes("text/plain"))      return "text";
  if (["js", "ts", "py", "java", "php", "cpp", "c", "cs", "go", "rb", "swift", "kt", "rs"].includes(ext)) return "code";
  if (["json"].includes(ext) || mime.includes("json"))                        return "json";
  if (["html", "htm", "css"].includes(ext))                                   return "web";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext) || mime.includes("image")) return "image";
  if (["mp4", "mov", "avi"].includes(ext) || mime.includes("video"))          return "video";
  if (["mp3", "wav", "ogg"].includes(ext) || mime.includes("audio"))          return "audio";
  if (["zip", "rar", "7z", "tar"].includes(ext))                              return "archive";
  return "unknown";
}

// ─── Analyze file with Groq ───────────────────────────────────────────────────
async function analyzeFileContent(content, fileType, filename) {
  return new Promise((resolve) => {
    let prompt = "";

    switch (fileType) {
      case "code":
        prompt = `You are AlgivixAI, a senior developer assistant in a WhatsApp group. 
Review this ${filename} code file:
1. What does it do? (2 sentences)
2. Any bugs or issues found?
3. Suggestions for improvement
4. Overall quality rating (1-10)
Keep it WhatsApp-friendly with *bold* headings.

\`\`\`
${content.slice(0, 3000)}
\`\`\``;
        break;

      case "json":
        prompt = `You are AlgivixAI. Analyze this JSON file called "${filename}":
1. What is this data for?
2. Structure summary
3. Any issues or missing fields?
Keep it brief and WhatsApp-friendly.

${content.slice(0, 2000)}`;
        break;

      case "csv":
        prompt = `You are AlgivixAI. Analyze this CSV data from "${filename}":
1. What kind of data is this?
2. How many columns/rows (estimate)?
3. Key insights or patterns
4. Any data quality issues?
Keep it WhatsApp-friendly with *bold* headings.

${content.slice(0, 2000)}`;
        break;

      case "text":
      case "word":
      case "pdf":
        prompt = `You are AlgivixAI, a smart assistant in a WhatsApp dev group.
Analyze this document "${filename}":
1. What is this document about? (brief summary)
2. Key points (max 5)
3. Any action items or important notes?
Keep it concise and WhatsApp-friendly.

${content.slice(0, 3000)}`;
        break;

      default:
        prompt = `You are AlgivixAI. Briefly describe what this file "${filename}" appears to contain. Keep it to 2-3 sentences.

${content.slice(0, 1000)}`;
    }

    const body = JSON.stringify({
      model:       process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      max_tokens:  600,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.groq.com",
      path:     "/openai/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
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

// ─── Build file response message ─────────────────────────────────────────────
function buildFileResponse(filename, fileType, analysis, sender) {
  const icons = {
    pdf:     "📄", word: "📝", excel: "📊", csv: "📊",
    text:    "📃", code: "👨‍💻", json: "🔧", web: "🌐",
    image:   "🖼️", video: "🎥", audio: "🎵", archive: "📦",
    unknown: "📎",
  };

  const icon = icons[fileType] || "📎";

  if (!analysis) {
    return (
      `${icon} ${fmt("File Received!")}\n${divider()}\n` +
      `📁 ${fmt("File:")} ${filename}\n` +
      `📂 ${fmt("Type:")} ${fileType.toUpperCase()}\n\n` +
      `_I couldn't fully read this file but it's been noted! 📌_`
    );
  }

  return (
    `${icon} ${fmt("File Analysis — " + filename)}\n${divider()}\n` +
    `${analysis}\n\n` +
    `${fmt("_AlgivixAI File Reader 🤖_")}`
  );
}

// ─── Try to extract text from buffer ─────────────────────────────────────────
function extractTextFromBuffer(buffer, fileType) {
  try {
    if (fileType === "text" || fileType === "code" || fileType === "json" ||
        fileType === "csv"  || fileType === "web") {
      return buffer.toString("utf8");
    }
    // For binary files (PDF, DOCX) — extract readable text portions
    const raw = buffer.toString("utf8", 0, 10000);
    // Strip non-printable characters
    return raw.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}

module.exports = {
  getFileType,
  extractTextFromBuffer,
  analyzeFileContent,
  buildFileResponse,
};
