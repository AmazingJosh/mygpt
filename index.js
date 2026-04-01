require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────
// ENVIRONMENT VARIABLES
// ─────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// WhatsApp (commented out until ready)
// const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
// const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
// const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ─────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.5-flash";
const DEEPSEEK_MODEL = "deepseek-chat";
const MAX_HISTORY = 30;
const MAX_GROUP_BUFFER = 50; // max messages to silently track per group
const MAX_MESSAGE_LENGTH = 1000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────

// Private chat conversation history — keyed by userId
const privateConversations = {};

// Group AI conversation history — keyed by groupId
// Used for the AI's multi-turn memory after responding
const groupConversations = {};

// Group message buffer — silently stores EVERY message in group
// So when @mentioned, bot already has full debate context
// Format: { groupId: [ "[Name]: message text", ... ] }
const groupMessageBuffer = {};

// AI selection per user — keyed by userId
const userAiSelection = {};

// ─────────────────────────────────────────
// SYSTEM PROMPTS
// ─────────────────────────────────────────

const PRIVATE_SYSTEM_PROMPT = `
You are VibesAi — not a typical assistant, but something closer to a brilliant,
emotionally intelligent best friend who happens to know a lot about everything.

## Core Identity
- You are honest, direct, and real. You never sugarcoat things.
- You are warm but not fake. You care, but you don't perform caring.
- You are deeply knowledgeable but never arrogant about it.
- You treat every person as an intelligent adult capable of handling the truth.

## How You Read The Room
You carefully read the energy, tone, and context of every message before responding.
You adapt naturally — the way any emotionally intelligent person adjusts how they
speak depending on the situation.

- If someone is casual and jokey → match that energy, be relaxed, witty
- If someone is curious and wants to learn → go deep, be thorough, be fascinating
- If someone is struggling emotionally → be present, be real, don't minimize their feelings
- If someone shares a bad idea → be honest about the weaknesses, constructive not crushing
- If someone is venting → listen first, give perspective second, never lecture
- If someone wants debate → engage critically, hold your position if you're right

## What You Never Do
- Never give fake motivation like "You got this! 💪 Believe in yourself!"
- Never be a yes-man. If something is wrong or flawed, say so.
- Never be preachy or moralize repeatedly — say it once, move on
- Never use corporate filler phrases like "Certainly!", "Great question!", "Absolutely!"
- Never give wishy-washy answers when a direct one is possible
- Never pretend to have emotions you don't have
- Never overwhelm with bullet points when natural conversation flows better

## How You Explain Things
- Use analogies and real world examples — make complex things click
- Go as deep as the person seems to want — read their curiosity level
- If something has nuance, honor that nuance instead of oversimplifying
- If you don't know something, say so directly

## One Rule Above All
Always prioritize what's actually useful and true for this specific person
in this specific moment — over what sounds good or what they want to hear.
`;

// Group system prompt — receives full conversation context
function getGroupSystemPrompt(groupName, conversationContext) {
  return `
You are VibesAi — a brilliant, neutral, and emotionally intelligent AI adviser
living inside a group chat called "${groupName || 'this group'}".

## The Group Conversation So Far
Here is EVERYTHING that has been said in this group recently — read it carefully
before responding. You already know the full context:

${conversationContext}

## Your Role In This Group
You are the trusted third party. The neutral brain everyone turns to when they
need an honest answer, a settled debate, or a fresh perspective.
You are NOT anyone's ally — you serve the truth and the group.

## How You Handle The Group Dynamic
- You already have the full conversation context above — USE IT
- Never ask "what is the disagreement about?" — you can already see it
- Address people by their first name naturally when relevant
- When asked to settle a debate, jump straight to the verdict with evidence
- When both sides have merit, say so clearly and explain both
- When one side is clearly wrong, say so directly but with good humor
- Reference specific things people said: "Joshua said X..." "Sandra's point about Y..."

## What You Never Do
- NEVER ask for context you already have — this is the #1 rule
- Never take sides based on who asked more nicely
- Never give vague answers just to avoid conflict
- Never use corporate filler phrases
- Never be preachy

## Response Style In Groups
- Jump straight to the answer — no preamble
- Keep it focused and clear — groups have short attention spans
- Use names naturally
- Add light humor when appropriate — groups love it
- Be the smartest person in the room who doesn't need to prove it

## One Rule Above All
Truth over comfort. Always. The group called on you — give them a real answer.
`;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.body?.from || req.ip,
  message: { error: "Too many messages. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

function getPrivateHistory(userId) {
  if (!privateConversations[userId]) privateConversations[userId] = [];
  return privateConversations[userId];
}

function getGroupHistory(groupId) {
  if (!groupConversations[groupId]) groupConversations[groupId] = [];
  return groupConversations[groupId];
}

// Add a message to the silent group buffer
function addToGroupBuffer(groupId, senderName, text) {
  if (!groupMessageBuffer[groupId]) groupMessageBuffer[groupId] = [];
  const buffer = groupMessageBuffer[groupId];

  buffer.push(`[${senderName}]: ${text}`);

  // Keep buffer from growing forever
  if (buffer.length > MAX_GROUP_BUFFER) {
    buffer.splice(0, buffer.length - MAX_GROUP_BUFFER);
  }
}

// Get the full group conversation as a readable string for the AI
function getGroupContext(groupId) {
  const buffer = groupMessageBuffer[groupId];
  if (!buffer || buffer.length === 0) return "No prior conversation in this group yet.";
  return buffer.join('\n');
}

function isGreeting(text) {
  const greetings = ["hi", "hello", "hey", "yo", "good morning", "good evening", "/start"];
  const cleaned = text.toLowerCase().trim().replace(/[!.,?]+$/, "");
  return greetings.includes(cleaned);
}

function trimHistory(history) {
  while (history.length > MAX_HISTORY) history.splice(0, 2);
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

function getWelcomeMessage(name) {
  return `Hey ${name}! 👋

⚡ *Welcome to VibesAi* — _The World's First 2-in-1 AI Bot._

While everyone else gives you a basic chatbot, we give you two elite AI engines in one place AND drop it straight into your group chats as a neutral adviser. No other bot does this.

─────────────────────
🤖 *PRIVATE MODE*
Your personal AI companion.
Honest. Direct. Emotionally intelligent.
Not a yes-man — a real one.
Powered by *Gemini* or *DeepSeek* — your choice.

👥 *GROUP MODE*
Add me to any group. @mention me.
I become your neutral third-party adviser.
Settling debates. Answering questions.
Bringing real intelligence to your conversations.
No sides. Just truth.
─────────────────────

_Premium responses. Zero fluff. Built different._

Now — choose your AI engine:

1️⃣ *Gemini* — Google's finest
2️⃣ *DeepSeek* — Powerful open-source AI

Reply *1* or *2* to get started.
_Type /help anytime to see all commands._`;
}

function getHelpMessage(isGroup = false) {
  if (isGroup) {
    return `*VibesAi Group Commands* 🤖

Mention me anytime: *@${process.env.BOT_USERNAME || 'Amj1bot'}*

I can help with:
→ Settling debates & arguments
→ Answering group questions
→ Giving neutral third-party advice
→ Brainstorming ideas together
→ Explaining anything to the group

I silently read the conversation so when you call me,
I already know what's going on. Just ask!`;
  }

  return `*VibesAi Commands* 🤖

/start — Main menu
/switch — Change AI engine
/help — Show this message
/reset — Clear conversation history
/about — About VibesAi

*Current features:*
→ Private AI companion (Gemini or DeepSeek)
→ Group chat adviser (add me to any group!)
→ Honest, premium responses — no fluff`;
}

function getAboutMessage() {
  return `*VibesAi* ⚡ — _Built Different._

The world's first 2-in-1 AI bot that works as hard in your private chat as it does in your group.

*🤖 Private Mode*
Two elite AI engines. One honest companion.
Gemini or DeepSeek — you choose.
No corporate fluff. No fake motivation.
Just real, intelligent conversation that respects your intelligence.

*👥 Group Mode*
The first bot that lives inside your arguments.
Add it to any group. @mention it.
It reads the ENTIRE conversation silently.
So when you call it — it already knows the full story.
No sides. Just truth.

*⚙️ Powered by:*
→ Google Gemini 2.5 Flash
→ DeepSeek V3

*🌍 Built for:*
→ Individuals who want more than a basic chatbot
→ Groups who want a neutral intelligent voice
→ Anyone tired of AI that tells them what they want to hear

_This isn't just a bot. It's the conversation upgrade you didn't know you needed._`;
}

function isBotMentioned(text, botUsername) {
  if (!text) return false;
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

function removeBotMention(text, botUsername) {
  return text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
}

function isGroupMessage(message) {
  return message.chat.type === 'group' || message.chat.type === 'supergroup';
}

// ─────────────────────────────────────────
// AI CALLERS
// ─────────────────────────────────────────

async function callGemini(history, systemPrompt) {
  const geminiHistory = history.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      systemInstruction: { parts: [{ text: systemPrompt }] },
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

  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callDeepSeek(history, systemPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(msg => ({
      role: msg.role === "model" ? "assistant" : "user",
      content: msg.content
    }))
  ];

  const response = await axios.post(
    "https://api.deepseek.com/chat/completions",
    { model: DEEPSEEK_MODEL, messages },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      timeout: REQUEST_TIMEOUT_MS
    }
  );

  return response.data.choices?.[0]?.message?.content || "";
}

async function withRetry(fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
      if (attempt === MAX_RETRIES) throw err;
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`⚠️ Attempt ${attempt} failed. Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// Private chat reply
async function getPrivateReply(userId, text) {
  const history = getPrivateHistory(userId);
  history.push({ role: "user", content: text });

  try {
    const selectedAi = userAiSelection[userId] || 'gemini';
    const reply = await withRetry(() =>
      selectedAi === 'deepseek'
        ? callDeepSeek(history, PRIVATE_SYSTEM_PROMPT)
        : callGemini(history, PRIVATE_SYSTEM_PROMPT)
    );
    history.push({ role: "model", content: reply });
    trimHistory(history);
    return reply;
  } catch (err) {
    history.pop();
    throw err;
  }
}

// Group chat reply — injects full conversation context into system prompt
async function getGroupReply(groupId, groupName, senderName, question) {
  const history = getGroupHistory(groupId);

  // Get full conversation context from buffer
  const conversationContext = getGroupContext(groupId);

  // Build system prompt with full context baked in
  const systemPrompt = getGroupSystemPrompt(groupName, conversationContext);

  // The actual question being asked
  const taggedQuestion = `[${senderName} is asking]: ${question}`;
  history.push({ role: "user", content: taggedQuestion });

  try {
    const reply = await withRetry(() => callGemini(history, systemPrompt));
    history.push({ role: "model", content: reply });
    trimHistory(history);
    return reply;
  } catch (err) {
    history.pop();
    throw err;
  }
}

// ─────────────────────────────────────────
// TELEGRAM
// ─────────────────────────────────────────

async function sendTelegramMessage(chatId, text, markdown = true) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: markdown ? 'Markdown' : undefined
    });
  } catch (err) {
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: text
      });
    } catch (e) {
      console.error("❌ Failed to send message:", e.message);
    }
  }
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ message: "VibesAi is running 🚀" });
});

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  const message = body?.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text.trim();
  const username = message.from.first_name || "Friend";
  const botUsername = process.env.BOT_USERNAME || 'Amj1bot';

  // ── GROUP CHAT HANDLER ──
  if (isGroupMessage(message)) {
    const groupId = String(message.chat.id);
    const groupName = message.chat.title || 'the group';

    // Always silently store every group message in the buffer
    // This gives the bot full context when it's eventually @mentioned
    addToGroupBuffer(groupId, username, text);

    // Only respond when @mentioned
    if (!isBotMentioned(text, botUsername)) return;

    // Clean the @mention from the question
    const cleanQuestion = removeBotMention(text, botUsername);

    if (!cleanQuestion) {
      await sendTelegramMessage(chatId,
        `I'm here! 👀 Ask me anything or describe the debate — I've been reading the conversation.`
      );
      return;
    }

    // Handle /help in group
    if (cleanQuestion.toLowerCase() === '/help') {
      await sendTelegramMessage(chatId, getHelpMessage(true));
      return;
    }

    console.log(`👥 Group mention in "${groupName}" from ${username}: ${cleanQuestion}`);

    try {
      const reply = await getGroupReply(groupId, groupName, username, cleanQuestion);
      await sendTelegramMessage(chatId, reply, false);
      console.log(`✅ Group reply sent in "${groupName}"`);
    } catch (err) {
      console.error("❌ Group reply error:", err.message);
      await sendTelegramMessage(chatId,
        "Having some trouble right now. Give it a second and try again.", false
      );
    }
    return;
  }

  // ── PRIVATE CHAT HANDLER ──
  console.log(`📩 Private from ${username} (${userId}): ${text}`);

  if (isGreeting(text)) {
    userAiSelection[userId] = null;
    privateConversations[userId] = [];
    await sendTelegramMessage(chatId, getWelcomeMessage(username));
    return;
  }

  if (text.toLowerCase() === '/switch') {
    userAiSelection[userId] = null;
    privateConversations[userId] = [];
    await sendTelegramMessage(chatId, getWelcomeMessage(username));
    return;
  }

  if (text.toLowerCase() === '/reset') {
    privateConversations[userId] = [];
    await sendTelegramMessage(chatId,
      `Conversation cleared! 🧹 Fresh start.\n\nWhat's on your mind, ${username}?`
    );
    return;
  }

  if (text.toLowerCase() === '/help') {
    await sendTelegramMessage(chatId, getHelpMessage(false));
    return;
  }

  if (text.toLowerCase() === '/about') {
    await sendTelegramMessage(chatId, getAboutMessage());
    return;
  }

  // AI selection
  if (!userAiSelection[userId]) {
    if (text === '1') {
      userAiSelection[userId] = 'gemini';
      await sendTelegramMessage(chatId,
        `✅ *Gemini* locked in.\n\nAlright ${username}, I'm listening. What's on your mind?`
      );
    } else if (text === '2') {
      userAiSelection[userId] = 'deepseek';
      await sendTelegramMessage(chatId,
        `✅ *DeepSeek* locked in.\n\nAlright ${username}, I'm listening. What's on your mind?`
      );
    } else {
      await sendTelegramMessage(chatId,
        `Reply with *1* for Gemini or *2* for DeepSeek to get started 👇`
      );
    }
    return;
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    await sendTelegramMessage(chatId,
      `Keep it under ${MAX_MESSAGE_LENGTH} characters please.`, false
    );
    return;
  }

  try {
    const reply = await getPrivateReply(userId, text);
    await sendTelegramMessage(chatId, reply, false);
    console.log(`✅ Private reply to ${username} via ${userAiSelection[userId]}`);
  } catch (err) {
    console.error("❌ Private reply error:", err.message);
    await sendTelegramMessage(chatId,
      "Having some trouble right now. Give it a second and try again.", false
    );
  }
});

// ═══════════════════════════════════════════════════════
// WHATSAPP HANDLER (commented out — activate when ready)
// ═══════════════════════════════════════════════════════

/*

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified!');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;
  const changes = body.entry?.[0]?.changes?.[0]?.value;
  const message = changes?.messages?.[0];
  if (!message || message.type !== 'text') return;

  const from = message.from;
  const text = message.text.body.trim();
  const senderName = changes?.contacts?.[0]?.profile?.name || 'Friend';
  const groupId = message?.context?.group_id || null;
  const isGroup = !!groupId;

  console.log(`📱 WhatsApp ${isGroup ? 'group' : 'private'} from ${senderName}: ${text}`);

  if (isGroup) {
    // Silently store all group messages
    addToGroupBuffer(groupId, senderName, text);

    const isMentioned = text.toLowerCase().includes('vibesai');
    const isReply = !!message?.context?.id;
    if (!isMentioned && !isReply) return;

    const cleanText = text.replace(/vibesai/gi, '').trim();
    if (!cleanText) {
      await sendWhatsAppMessage(from, "I'm here! What's the debate?");
      return;
    }

    try {
      const reply = await getGroupReply(groupId, 'WhatsApp Group', senderName, cleanText);
      await sendWhatsAppMessage(from, reply);
    } catch (err) {
      console.error("❌ WhatsApp group error:", err.message);
      await sendWhatsAppMessage(from, "Having some trouble. Try again in a moment!");
    }
    return;
  }

  if (isGreeting(text)) {
    userAiSelection[from] = null;
    privateConversations[from] = [];
    await sendWhatsAppMessage(from,
      `Hey ${senderName}! 👋 Welcome to VibesAi.\n\nChoose your AI:\n1️⃣ Gemini\n2️⃣ DeepSeek\n\nReply 1 or 2.`
    );
    return;
  }

  if (!userAiSelection[from]) {
    if (text === '1') {
      userAiSelection[from] = 'gemini';
      await sendWhatsAppMessage(from, `✅ Gemini locked in. What's on your mind, ${senderName}?`);
    } else if (text === '2') {
      userAiSelection[from] = 'deepseek';
      await sendWhatsAppMessage(from, `✅ DeepSeek locked in. What's on your mind, ${senderName}?`);
    } else {
      await sendWhatsAppMessage(from, "Reply 1 for Gemini or 2 for DeepSeek.");
    }
    return;
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    await sendWhatsAppMessage(from, `Keep it under ${MAX_MESSAGE_LENGTH} characters.`);
    return;
  }

  try {
    const reply = await getPrivateReply(from, text);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("❌ WhatsApp error:", err.message);
    await sendWhatsAppMessage(from, "Having some trouble. Try again in a moment!");
  }
});

async function sendWhatsAppMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

*/

// ─────────────────────────────────────────
// MANUAL TEST ROUTE
// ─────────────────────────────────────────
app.post('/message', messageLimiter, async (req, res) => {
  const { from, text } = req.body;
  if (!from || !text) return res.status(400).json({ error: "Missing 'from' or 'text'" });
  if (text.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: "Message too long." });
  if (!userAiSelection[from]) userAiSelection[from] = 'gemini';

  try {
    const reply = await getPrivateReply(from, text);
    res.json({ reply, ai: userAiSelection[from] });
  } catch (err) {
    if (err.code === 'ECONNABORTED') return res.status(504).json({ error: "Timed out." });
    console.error("Error:", err.response?.status, err.message);
    res.status(500).json({ error: "AI request failed." });
  }
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VibesAi running on port ${PORT} 🚀`));