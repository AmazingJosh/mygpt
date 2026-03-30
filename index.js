require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const GEMINI_MODEL = "gemini-2.5-flash";
const DEEPSEEK_MODEL = "deepseek-chat";
const MAX_HISTORY = 30;
const MAX_MESSAGE_LENGTH = 1000;
const REQUEST_TIMEOUT_MS = 15000;

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

// Store conversation history per user
const conversations = {};

// Store each user's selected AI — defaults to null until they pick one
const userAiSelection = {};

// System personality
const SYSTEM_PROMPT = `
You are VibesAi, a friendly and intelligent assistant.
Speak naturally like a human.
Maintain context across messages.
Ask follow-up questions when useful.
Keep conversations engaging and helpful.
`;

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

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function getConversation(user) {
  if (!conversations[user]) conversations[user] = [];
  return conversations[user];
}

function isGreeting(text) {
  const greetings = ["hi", "hello", "hey", "yo", "good morning", "good evening", "/start"];
  const cleaned = text.toLowerCase().trim().replace(/[!.,?]+$/, "");
  return greetings.includes(cleaned);
}

function trimHistory(history) {
  while (history.length > MAX_HISTORY) {
    history.splice(0, 2);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(err) {
  if (err.code === 'ECONNABORTED') return true;
  if (err.code === 'ECONNRESET') return true;
  if (err.code === 'ENOTFOUND') return true;
  if (err.code === 'ETIMEDOUT') return true;
  if (err.response?.status >= 500) return true;
  if (err.response?.status === 429) return true;
  return false;
}

// Welcome message with AI selection menu
function getWelcomeMessage() {
  return `👋 Welcome to *VibesAi*! Your AI-powered assistant.

Please choose your AI:

1️⃣ *Gemini* — Google's latest AI
2️⃣ *DeepSeek* — Powerful open-source AI

Reply with *1* or *2* to get started!`;
}

// ─────────────────────────────────────────
// AI CALLERS
// ─────────────────────────────────────────

// Call Gemini API
async function callGemini(history) {
  const geminiHistory = history.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: geminiHistory
    },
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
}

// Call DeepSeek API (OpenAI-compatible format)
async function callDeepSeek(history) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(msg => ({
      role: msg.role === "model" ? "assistant" : "user",
      content: msg.content
    }))
  ];

  const response = await axios.post(
    "https://api.deepseek.com/chat/completions",
    {
      model: DEEPSEEK_MODEL,
      messages
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      timeout: REQUEST_TIMEOUT_MS
    }
  );

  return response.data.choices?.[0]?.message?.content ||
    "Hmm... something went wrong.";
}

// Call the selected AI with retry logic
async function callAiWithRetry(userId, history) {
  const selectedAi = userAiSelection[userId];
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (selectedAi === 'gemini') return await callGemini(history);
      if (selectedAi === 'deepseek') return await callDeepSeek(history);
    } catch (err) {
      lastError = err;

      if (!isRetryable(err)) {
        console.error(`❌ Non-retryable error on attempt ${attempt}:`, err.response?.status, err.message);
        throw err;
      }

      if (attempt === MAX_RETRIES) {
        console.error(`❌ All ${MAX_RETRIES} attempts failed:`, err.message);
        throw err;
      }

      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`⚠️ Attempt ${attempt} failed. Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

// Get AI reply for a user
async function getAiReply(userId, text) {
  if (isGreeting(text)) conversations[userId] = [];

  const history = getConversation(userId);

  // Unified history format works for both AIs
  history.push({ role: "user", content: text });

  try {
    const reply = await callAiWithRetry(userId, history);
    history.push({ role: "model", content: reply });
    trimHistory(history);
    return reply;
  } catch (err) {
    history.pop();
    throw err;
  }
}

// ─────────────────────────────────────────
// TELEGRAM HELPERS
// ─────────────────────────────────────────

async function sendTelegramMessage(chatId, text, markdown = true) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text,
    parse_mode: markdown ? 'Markdown' : undefined
  });
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ message: "VibesAi is running 🚀" });
});

// Telegram webhook
app.post('/telegram', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  const message = body?.message;

  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text.trim();
  const username = message.from.first_name || "there";

  console.log(`📩 Message from ${username} (${userId}): ${text}`);

  // Handle /start command or greeting — show welcome menu
  if (isGreeting(text)) {
    userAiSelection[userId] = null;
    conversations[userId] = [];
    await sendTelegramMessage(chatId, getWelcomeMessage());
    return;
  }

  // Handle /switch command — reset AI selection
  if (text.toLowerCase() === '/switch') {
    userAiSelection[userId] = null;
    conversations[userId] = [];
    await sendTelegramMessage(chatId, getWelcomeMessage());
    return;
  }

  // Handle AI selection (1 or 2)
  if (!userAiSelection[userId]) {
    if (text === '1') {
      userAiSelection[userId] = 'gemini';
      await sendTelegramMessage(chatId, `✅ *Gemini* selected!\n\nHey ${username}! I'm VibesAi powered by Google Gemini. How can I help you today? 😊`);
    } else if (text === '2') {
      userAiSelection[userId] = 'deepseek';
      await sendTelegramMessage(chatId, `✅ *DeepSeek* selected!\n\nHey ${username}! I'm VibesAi powered by DeepSeek. How can I help you today? 😊`);
    } else {
      // User typed something other than 1 or 2
      await sendTelegramMessage(chatId, `Please reply with *1* for Gemini or *2* for DeepSeek to get started! 👇`);
    }
    return;
  }

  // Message is too long
  if (text.length > MAX_MESSAGE_LENGTH) {
    await sendTelegramMessage(chatId, `Please keep messages under ${MAX_MESSAGE_LENGTH} characters.`);
    return;
  }

  // Normal conversation — send to selected AI
  try {
    const reply = await getAiReply(userId, text);
    await sendTelegramMessage(chatId, reply, false);
    console.log(`✅ Reply sent to ${username} via ${userAiSelection[userId]}`);
  } catch (err) {
    console.error("❌ All retries exhausted:", err.message);
    await sendTelegramMessage(chatId, "Sorry, I'm having trouble responding right now. Please try again in a moment!");
  }
});

// Manual test route
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

  if (!userAiSelection[from]) {
    return res.status(400).json({ error: "No AI selected. Send 1 for Gemini or 2 for DeepSeek." });
  }

  try {
    const reply = await getAiReply(from, text);
    res.json({ reply, ai: userAiSelection[from] });
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: "AI response timed out. Please try again." });
    }
    console.error("Error:", err.response?.status, err.message);
    res.status(500).json({ error: "AI request failed. Please try again later." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VibesAi running on port ${PORT}`);
});