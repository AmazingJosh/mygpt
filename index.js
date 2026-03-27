require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash"; // ✅ Fixed: correct model string
const MAX_HISTORY = 30;
const MAX_MESSAGE_LENGTH = 1000;
const REQUEST_TIMEOUT_MS = 15000;

const conversations = {};

// System personality
const SYSTEM_INSTRUCTION = {
  parts: [
    {
      text: `
You are VibeBot, a friendly and intelligent assistant.
Speak naturally like a human.
Maintain context across messages.
Ask follow-up questions when useful.
Keep conversations engaging and helpful.
`
    }
  ]
};

// ✅ Rate limiter: max 20 requests per minute per IP
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.body?.from || req.ip, // rate limit per WhatsApp user
  message: { error: "Too many messages. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper to get or create conversation
function getConversation(user) {
  if (!conversations[user]) {
    conversations[user] = [];
  }
  return conversations[user];
}

// ✅ Fixed: improved greeting detection with trim + punctuation handling
function isGreeting(text) {
  const greetings = ["hi", "hello", "hey", "yo", "good morning", "good evening"];
  const cleaned = text.toLowerCase().trim().replace(/[!.,?]+$/, "");
  return greetings.includes(cleaned);
}

// ✅ Fixed: trim history in pairs to avoid orphaned messages
function trimHistory(history) {
  while (history.length > MAX_HISTORY) {
    // Remove oldest pair (user + model)
    history.splice(0, 2);
  }
}

app.get('/', (req, res) => {
  res.json({
    message: "VibeBot Chat API running 🚀",
    usage: "POST /message with { from, text }"
  });
});

// ✅ WhatsApp webhook verification (GET /webhook)
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified ✅');
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

app.post('/message', messageLimiter, async (req, res) => {
  const { from, text } = req.body;

  if (!from || !text) {
    return res.status(400).json({ error: "Missing 'from' or 'text'" });
  }

  // ✅ Input length validation
  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      error: `Message too long. Maximum is ${MAX_MESSAGE_LENGTH} characters.`
    });
  }

  try {
    // Reset conversation on greeting
    if (isGreeting(text)) {
      conversations[from] = [];
    }

    const history = getConversation(from);

    // Add user message
    history.push({
      role: "user",
      parts: [{ text }]
    });

    // ✅ Axios timeout added
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        systemInstruction: SYSTEM_INSTRUCTION,
        contents: history
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        timeout: REQUEST_TIMEOUT_MS
      }
    );

    const reply =
      response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Hmm... something went wrong.";

    // Save AI response
    history.push({
      role: "model",
      parts: [{ text: reply }]
    });

    // ✅ Fixed: trim in pairs to preserve message integrity
    trimHistory(history);

    res.json({
      reply,
      // conversationLength: history.length
    });

  } catch (err) {
    // ✅ Safe error logging — no sensitive data exposed to client
    if (err.code === 'ECONNABORTED') {
      console.error("Gemini timeout: request took too long.");
      return res.status(504).json({ error: "AI response timed out. Please try again." });
    }

    // Log safely server-side only
    console.error("Gemini Error:", err.response?.status, err.message);
    res.status(500).json({ error: "AI request failed. Please try again later." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VibeBot running on port ${PORT}`);
});