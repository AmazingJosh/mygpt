require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const MODEL = "gemini-2.5-flash";
const MAX_HISTORY = 30;
const MAX_MESSAGE_LENGTH = 1000;
const REQUEST_TIMEOUT_MS = 15000;

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

const conversations = {};

// System personality
const SYSTEM_INSTRUCTION = {
  parts: [
    {
      text: `
You are VibesAi, a friendly and intelligent assistant.
Speak naturally like a human.
Maintain context across messages.
Ask follow-up questions when useful.
Keep conversations engaging and helpful.
`
    }
  ]
};

// Rate limiter
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.body?.from || req.ip,
  message: { error: "Too many messages. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

// Helper to get or create conversation
function getConversation(user) {
  if (!conversations[user]) {
    conversations[user] = [];
  }
  return conversations[user];
}

// Greeting detection
function isGreeting(text) {
  const greetings = ["hi", "hello", "hey", "yo", "good morning", "good evening"];
  const cleaned = text.toLowerCase().trim().replace(/[!.,?]+$/, "");
  return greetings.includes(cleaned);
}

// Trim history in pairs
function trimHistory(history) {
  while (history.length > MAX_HISTORY) {
    history.splice(0, 2);
  }
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Determines if an error is worth retrying
function isRetryable(err) {
  if (err.code === 'ECONNABORTED') return true;
  if (err.code === 'ECONNRESET') return true;
  if (err.code === 'ENOTFOUND') return true;
  if (err.code === 'ETIMEDOUT') return true;
  if (err.response?.status >= 500) return true;
  if (err.response?.status === 429) return true;
  return false;
}

// Call Gemini with retry logic
async function callGeminiWithRetry(history) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        { systemInstruction: SYSTEM_INSTRUCTION, contents: history },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
          },
          timeout: REQUEST_TIMEOUT_MS
        }
      );

      return response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Hmm... something went wrong.";

    } catch (err) {
      lastError = err;

      if (!isRetryable(err)) {
        console.error(`❌ Non-retryable error on attempt ${attempt}:`, err.response?.status, err.message);
        throw err;
      }

      if (attempt === MAX_RETRIES) {
        console.error(`❌ All ${MAX_RETRIES} attempts failed. Last error:`, err.message);
        throw err;
      }

      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`⚠️ Attempt ${attempt} failed. Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

// Get Gemini reply for a user
async function getGeminiReply(from, text) {
  if (isGreeting(text)) conversations[from] = [];

  const history = getConversation(from);
  history.push({ role: "user", parts: [{ text }] });

  try {
    const reply = await callGeminiWithRetry(history);
    history.push({ role: "model", parts: [{ text: reply }] });
    trimHistory(history);
    return reply;
  } catch (err) {
    history.pop(); // remove orphaned user message
    throw err;
  }
}

// Send a Telegram message
async function sendTelegramMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text
  });
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ message: "VibesAi is running 🚀" });
});

// Telegram webhook — receives all incoming Telegram messages
app.post(`/telegram`, async (req, res) => {
  // Acknowledge Telegram immediately
  res.sendStatus(200);

  const body = req.body;
  const message = body?.message;

  // Ignore anything that isn't a text message
  if (!message || !message.text) return;

  const chatId = message.chat.id;         // unique ID for this chat/user
  const from = String(message.from.id);   // user's Telegram ID (used as conversation key)
  const text = message.text;              // the message text
  const username = message.from.first_name || "there";

  console.log(`📩 Message from ${username} (${from}): ${text}`);

  // Ignore messages that are too long
  if (text.length > MAX_MESSAGE_LENGTH) {
    await sendTelegramMessage(chatId, `Please keep messages under ${MAX_MESSAGE_LENGTH} characters.`);
    return;
  }

  try {
    const reply = await getGeminiReply(from, text);
    await sendTelegramMessage(chatId, reply);
    console.log(`✅ Reply sent to ${username}`);
  } catch (err) {
    console.error("❌ All retries exhausted:", err.message);
    await sendTelegramMessage(chatId, "Sorry, I'm having trouble responding right now. Please try again in a moment!");
  }
});

// Manual test route — test without Telegram
app.post('/message', messageLimiter, async (req, res) => {
  const { from, text } = req.body;

  if (!from || !text) {
    return res.status(400).json({ error: "Missing 'from' or 'text'" });
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      error: `Message too long. Maximum is ${MAX_MESSAGE_LENGTH} characters.`
    });
  }

  try {
    const reply = await getGeminiReply(from, text);
    res.json({ reply });
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: "AI response timed out. Please try again." });
    }
    console.error("Gemini Error:", err.response?.status, err.message);
    res.status(500).json({ error: "AI request failed. Please try again later." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VibesAi running on port ${PORT}`);
});