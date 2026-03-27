require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const MODEL = "gemini-2.5-flash";
const MAX_HISTORY = 30;
const MAX_MESSAGE_LENGTH = 1000;
const REQUEST_TIMEOUT_MS = 15000;

// Retry configuration
const MAX_RETRIES = 3;          // total attempts
const RETRY_BASE_DELAY_MS = 2000; // start with 2 seconds, then 4, then 8

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

// Rate limiter: max 20 requests per minute per user
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.body?.from || req.ip,
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

// Greeting detection
function isGreeting(text) {
  const greetings = ["hi", "hello", "hey", "yo", "good morning", "good evening"];
  const cleaned = text.toLowerCase().trim().replace(/[!.,?]+$/, "");
  return greetings.includes(cleaned);
}

// Trim history in pairs to avoid orphaned messages
function trimHistory(history) {
  while (history.length > MAX_HISTORY) {
    history.splice(0, 2);
  }
}

// Sleep helper — pauses execution for a given number of milliseconds
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Determines if an error is worth retrying or a definite failure
function isRetryable(err) {
  // Network issues, timeouts — worth retrying
  if (err.code === 'ECONNABORTED') return true;  // timeout
  if (err.code === 'ECONNRESET') return true;     // connection reset
  if (err.code === 'ENOTFOUND') return true;      // DNS issue
  if (err.code === 'ETIMEDOUT') return true;      // timed out

  // Gemini server errors (5xx) — worth retrying (their problem, not ours)
  if (err.response?.status >= 500) return true;

  // Gemini rate limit (429) — worth retrying after a delay
  if (err.response?.status === 429) return true;

  // Everything else (400 bad request, 401 auth failed etc) — don't retry,
  // these won't fix themselves
  return false;
}

// Call Gemini API with retry logic
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

      // Success — return the reply
      return response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Hmm... something went wrong.";

    } catch (err) {
      lastError = err;

      // If it's not a retryable error, fail immediately — no point waiting
      if (!isRetryable(err)) {
        console.error(`❌ Non-retryable error on attempt ${attempt}:`, err.response?.status, err.message);
        throw err;
      }

      // If we've used all attempts, give up
      if (attempt === MAX_RETRIES) {
        console.error(`❌ All ${MAX_RETRIES} attempts failed. Last error:`, err.message);
        throw err;
      }

      // Calculate delay: attempt 1 → 2s, attempt 2 → 4s, attempt 3 → 8s
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`⚠️ Attempt ${attempt} failed. Retrying in ${delay / 1000}s... (${err.message})`);
      await sleep(delay);
    }
  }
    console.log("Using Gemini Key:", GEMINI_API_KEY?.slice(0, 10) + "...");


  throw lastError;
}

// Helper to get Gemini reply
async function getGeminiReply(from, text) {
  if (isGreeting(text)) conversations[from] = [];

  const history = getConversation(from);

  // Add user message to history
  history.push({ role: "user", parts: [{ text }] });

  try {
    const reply = await callGeminiWithRetry(history);

    // Only save to history if we got a real reply
    history.push({ role: "model", parts: [{ text: reply }] });
    trimHistory(history);

    return reply;
  } catch (err) {
    // Remove the user message we just added since it didn't get a reply
    // This keeps history clean — no orphaned user messages
    history.pop();
    throw err;
  }
}

// Helper to send a WhatsApp message back to user
// Helper to send a WhatsApp message back to user
async function sendWhatsAppMessage(to, message) {

console.log("---- WHATSAPP DEBUG ----");
  console.log("Token exists:", !!WHATSAPP_TOKEN);
  console.log("Token preview:", WHATSAPP_TOKEN?.slice(0, 12));
  console.log("Phone ID:", WHATSAPP_PHONE_NUMBER_ID);
  console.log("------------------------");

  await axios.post(
    `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    message: "VibeBot is running 🚀",
    usage: "POST /message with { from, text }"
  });
});

// WhatsApp webhook verification
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified!');
    return res.status(200).send(challenge);
  }

  console.log('❌ Webhook verification failed');
  res.sendStatus(403);
});

// WhatsApp webhook — receives incoming messages from users
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== 'whatsapp_business_account') return;

  const changes = body.entry?.[0]?.changes?.[0]?.value;
  const message = changes?.messages?.[0];

  if (!message || message.type !== 'text') return;

  const from = message.from;
  const text = message.text.body;

  console.log(`📩 Message from ${from}: ${text}`);

  if (text.length > MAX_MESSAGE_LENGTH) {
    await sendWhatsAppMessage(from, `Please keep messages under ${MAX_MESSAGE_LENGTH} characters.`);
    return;
  }

  try {
    const reply = await getGeminiReply(from, text);
    await sendWhatsAppMessage(from, reply);
    console.log(`✅ Reply sent to ${from}`);
  } catch (err) {
    // Only send error message to user if ALL retries failed
    console.error("❌ All retries exhausted:", err.message);
    await sendWhatsAppMessage(from, "Sorry, I'm having trouble responding right now. Please try again in a moment!");
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
  console.log(`VibeBot running on port ${PORT}`);
});