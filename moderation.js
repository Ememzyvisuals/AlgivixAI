/**
 * moderation.js - AlgivixAI Group Moderation Module
 * Detects spam, inappropriate content, and manages warnings
 * Developer: EMEMZYVISUALS DIGITALS
 */

// ─── Warning Storage (in-memory, resets on restart) ──────────────────────────
// For production, replace with a persistent store like SQLite or Redis
const warningMap = new Map(); // { phoneNumber: warningCount }

// ─── Spam Detection Settings ──────────────────────────────────────────────────
const SPAM_CONFIG = {
  maxWarnings: 3,           // Warnings before admin notification
  maxRepeats: 3,            // Same message repeated N times = spam
  maxLinksPerMsg: 2,        // More than this many links = suspicious
  minMsgInterval: 1000,     // Minimum ms between messages (anti-flood)
};

// Track recent messages for repeat/flood detection
const recentMessages = new Map(); // { phoneNumber: { text, count, lastTime } }

// ─── Content Filters ──────────────────────────────────────────────────────────
const INAPPROPRIATE_PATTERNS = [
  // Profanity (add your own list as needed)
  /\b(fuck|shit|asshole|bitch|damn it)\b/i,
  // Spam triggers
  /\b(click here|buy now|limited offer|free money|earn \$|make money fast)\b/i,
  // Phishing / scam patterns
  /\b(send me your password|verify your account|urgent action required)\b/i,
];

const OFF_TOPIC_PATTERNS = [
  /\b(bet|gambling|casino|forex|crypto pump|join my group)\b/i,
  /\b(MLM|network marketing|downline|pyramid)\b/i,
];

/**
 * Analyze a message for spam, inappropriate content, or off-topic material
 * @param {string} senderJid - Sender's WhatsApp JID
 * @param {string} messageText - The message content
 * @returns {{ isViolation: boolean, reason: string|null, severity: string }}
 */
function analyzeMessage(senderJid, messageText) {
  const text = messageText.trim();
  const phone = senderJid.split("@")[0];

  // ── 1. Check inappropriate content ─────────────────────────────────────────
  for (const pattern of INAPPROPRIATE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        isViolation: true,
        reason: "inappropriate content",
        severity: "high",
      };
    }
  }

  // ── 2. Check off-topic content ──────────────────────────────────────────────
  for (const pattern of OFF_TOPIC_PATTERNS) {
    if (pattern.test(text)) {
      return {
        isViolation: true,
        reason: "off-topic/promotional content",
        severity: "medium",
      };
    }
  }

  // ── 3. Check for link spam ──────────────────────────────────────────────────
  const linkCount = (text.match(/https?:\/\/[^\s]+/g) || []).length;
  if (linkCount > SPAM_CONFIG.maxLinksPerMsg) {
    return {
      isViolation: true,
      reason: "too many links (possible spam)",
      severity: "medium",
    };
  }

  // ── 4. Check for repeated messages (flood detection) ───────────────────────
  const recent = recentMessages.get(phone);
  const now = Date.now();

  if (recent) {
    if (recent.text === text) {
      recent.count++;
      recent.lastTime = now;
      recentMessages.set(phone, recent);

      if (recent.count >= SPAM_CONFIG.maxRepeats) {
        recentMessages.delete(phone); // Reset after flagging
        return {
          isViolation: true,
          reason: "message spamming (repeated messages)",
          severity: "high",
        };
      }
    } else {
      // Different message — check flood (too fast)
      if (now - recent.lastTime < SPAM_CONFIG.minMsgInterval) {
        return {
          isViolation: true,
          reason: "message flooding (too fast)",
          severity: "low",
        };
      }
      recentMessages.set(phone, { text, count: 1, lastTime: now });
    }
  } else {
    recentMessages.set(phone, { text, count: 1, lastTime: now });
  }

  return { isViolation: false, reason: null, severity: null };
}

/**
 * Issue a warning to a user and return their updated warning count
 * @param {string} senderJid
 * @returns {{ count: number, shouldNotifyAdmin: boolean }}
 */
function issueWarning(senderJid) {
  const phone = senderJid.split("@")[0];
  const current = warningMap.get(phone) || 0;
  const newCount = current + 1;
  warningMap.set(phone, newCount);

  return {
    count: newCount,
    shouldNotifyAdmin: newCount >= SPAM_CONFIG.maxWarnings,
  };
}

/**
 * Build a warning message to send to the user
 * @param {string} senderJid
 * @param {string} reason
 * @param {number} warningCount
 * @returns {string}
 */
function buildWarningMessage(senderJid, reason, warningCount) {
  const phone = senderJid.split("@")[0];
  const remaining = SPAM_CONFIG.maxWarnings - warningCount;

  let msg = `⚠️ *Warning ${warningCount}/${SPAM_CONFIG.maxWarnings}* — @${phone}\n`;
  msg += `Reason: *${reason}*\n`;

  if (remaining > 0) {
    msg += `You have ${remaining} warning(s) remaining before admin review.`;
  } else {
    msg += `🚨 Maximum warnings reached. Admins have been notified.`;
  }

  return msg;
}

/**
 * Build an admin notification message
 * @param {string} senderJid
 * @param {string} reason
 * @param {string} messageText
 * @returns {string}
 */
function buildAdminAlert(senderJid, reason, messageText) {
  const phone = senderJid.split("@")[0];
  return (
    `🚨 *Admin Alert — AlgivixAI*\n` +
    `User @${phone} has reached max warnings!\n` +
    `Reason: ${reason}\n` +
    `Last message: "${messageText.substring(0, 80)}..."\n` +
    `Please review and take action.`
  );
}

/**
 * Get the current warning count for a user
 * @param {string} senderJid
 * @returns {number}
 */
function getWarnings(senderJid) {
  const phone = senderJid.split("@")[0];
  return warningMap.get(phone) || 0;
}

/**
 * Reset warnings for a user (admin action)
 * @param {string} senderJid
 */
function resetWarnings(senderJid) {
  const phone = senderJid.split("@")[0];
  warningMap.delete(phone);
}

module.exports = {
  analyzeMessage,
  issueWarning,
  buildWarningMessage,
  buildAdminAlert,
  getWarnings,
  resetWarnings,
};
