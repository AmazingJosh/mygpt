require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const User = require('./models/User');
const Conversation = require('./models/Conversation');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────
// ENVIRONMENT VARIABLES
// ─────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const MONGODB_URI = process.env.MONGODB_URI;

// WhatsApp (commented out until ready)
// const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
// const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
// const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ─────────────────────────────────────────
// DATABASE CONNECTION
// ─────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected!'))
  .catch(err => console.error('❌ MongoDB connection error:', err.message));

// ─────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.5-flash";
const DEEPSEEK_MODEL = "deepseek-chat";
const MAX_MESSAGE_LENGTH = 1000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const FREE_DAILY_LIMIT = 20;

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

function getGroupSystemPrompt(groupName, conversationContext) {
  return `
You are VibesAi — a brilliant, emotionally intelligent AI who has been casually
sitting in the group chat called "${groupName || 'this group'}", reading everything,
and only speaking when called upon. Think of yourself as that one friend in the
group who does not talk much but when they do — everyone listens.

## The Group Conversation So Far
Here is EVERYTHING said in this group recently. You have been reading all of it:

${conversationContext}

## Your Personality In This Group
You are warm, human, and real — not a robot giving a Wikipedia answer.
You talk like a person who genuinely cares about the group and finds them entertaining.
You are the smartest one in the room but you wear it lightly — no lecturing, no showing off.
You are neutral but not cold. Honest but not harsh. Funny but not trying too hard.

## How You Read The Group Energy
- If the group is being playful and silly → match that energy, be witty, joke around
- If it is a genuine debate → be sharp, clear, give a real verdict
- If someone seems genuinely upset → acknowledge it naturally before answering
- If it is a light question → keep it light and fun, do not over-explain

## How You Handle Debates
- You already have the full context — NEVER ask what the disagreement is about
- Jump straight to the verdict with confidence
- Reference what specific people said: "Joshua said X..." "Sandra's point about Y..."
- When one side is wrong, say so with humor not cruelty
- Use emojis naturally where they fit the vibe

## What You Never Do
- NEVER ask for context you already have — biggest rule
- Never sound like a corporate chatbot
- Never be preachy or moralize
- Never use filler phrases like "Great question!" or "Certainly!"

## One Rule Above All
Be human first, be right second. The group did not call on a search engine —
they called on VibesAi. Give them something worth reading.
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

function isGreeting(text) {
  const greetings = ["hi", "hello", "hey", "yo", "good morning", "good evening", "/start"];
  const cleaned = text.toLowerCase().trim().replace(/[!.,?]+$/, "");
  return greetings.includes(cleaned);
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

// ─────────────────────────────────────────
// DATABASE HELPERS
// ─────────────────────────────────────────

// Get or create a user in the database
async function getOrCreateUser(userId, username) {
  let user = await User.findOne({ userId });
  if (!user) {
    user = await User.create({ userId, username });
    console.log(`👤 New user created: ${username} (${userId})`);
  } else {
    // Update username in case they changed it
    user.username = username;
    user.lastActive = new Date();
    await user.save();
  }
  return user;
}

// Get or create a conversation in the database
async function getOrCreateConversation(ownerId, type = 'private', groupName = null) {
  let conversation = await Conversation.findOne({ ownerId });
  if (!conversation) {
    conversation = await Conversation.create({ ownerId, type, groupName });
  }
  return conversation;
}

// Check and handle daily message limit
async function checkDailyLimit(user, chatId) {
  // Reset daily count if 24 hours have passed
  const now = new Date();
  const lastReset = new Date(user.lastResetDate);
  const hoursSinceReset = (now - lastReset) / (1000 * 60 * 60);

  if (hoursSinceReset >= 24) {
    user.dailyMessageCount = 0;
    user.lastResetDate = now;
    await user.save();
  }

  // Premium users have no limit
  if (user.isPremium) return true;

  // Check if limit reached
  if (user.dailyMessageCount >= FREE_DAILY_LIMIT) {
    await sendTelegramMessage(chatId,
      `⚠️ You've reached your *${FREE_DAILY_LIMIT} free messages* for today.\n\n` +
      `Your limit resets in ${Math.ceil(24 - hoursSinceReset)} hours.\n\n` +
      `_Upgrade to Premium for unlimited messages — coming soon!_ 🚀`
    );
    return false;
  }

  return true;
}

// ─────────────────────────────────────────
// MESSAGE TEMPLATES
// ─────────────────────────────────────────

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

I silently read the conversation so when you call me, I already know what's going on. Just ask!

I can help with:
→ Settling debates & arguments
→ Answering group questions
→ Giving neutral third-party advice
→ Brainstorming ideas together
→ Explaining anything to the group`;
  }

  return `*VibesAi Commands* 🤖

/start — Main menu
/switch — Change AI engine
/reset — Clear conversation history
/stats — Your usage stats
/help — Show this message
/about — About VibesAi

*Free tier:* ${FREE_DAILY_LIMIT} messages per day
*Premium:* Unlimited — coming soon! 🚀`;
}

function getAboutMessage() {
  return `*VibesAi* ⚡ — _Built Different._

The world's first 2-in-1 AI bot that works as hard in your private chat as it does in your group.

*🤖 Private Mode*
Two elite AI engines. One honest companion.
Gemini or DeepSeek — you choose.
No corporate fluff. No fake motivation.
Just real, intelligent conversation.

*👥 Group Mode*
The first bot that lives inside your arguments.
Add it to any group. @mention it.
It reads the ENTIRE conversation silently.
So when you call it — it already knows the full story.

*⚙️ Powered by:*
→ Google Gemini 2.5 Flash
→ DeepSeek V3

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

// Private chat reply — persisted to MongoDB
async function getPrivateReply(user, text) {
  const conversation = await getOrCreateConversation(user.userId, 'private');

  await conversation.addMessage('user', text);

  try {
    const selectedAi = user.selectedAi || 'gemini';
    const reply = await withRetry(() =>
      selectedAi === 'deepseek'
        ? callDeepSeek(conversation.history, PRIVATE_SYSTEM_PROMPT)
        : callGemini(conversation.history, PRIVATE_SYSTEM_PROMPT)
    );

    await conversation.addMessage('model', reply);
    return reply;
  } catch (err) {
    // Remove the user message if AI failed
    conversation.history.pop();
    await conversation.save();
    throw err;
  }
}

// Group chat reply — persisted to MongoDB
async function getGroupReply(groupId, groupName, senderName, question) {
  const conversation = await getOrCreateConversation(groupId, 'group', groupName);
  const conversationContext = conversation.getBufferContext();
  const systemPrompt = getGroupSystemPrompt(groupName, conversationContext);

  const taggedQuestion = `[${senderName} is asking]: ${question}`;
  await conversation.addMessage('user', taggedQuestion);

  try {
    const reply = await withRetry(() => callGemini(conversation.history, systemPrompt));
    await conversation.addMessage('model', reply);
    return reply;
  } catch (err) {
    conversation.history.pop();
    await conversation.save();
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

    // Silently store every group message in DB
    try {
      const conversation = await getOrCreateConversation(groupId, 'group', groupName);
      await conversation.addToBuffer(username, text);
    } catch (err) {
      console.error("❌ Buffer save error:", err.message);
    }

    // Only respond when @mentioned
    if (!isBotMentioned(text, botUsername)) return;

    const cleanQuestion = removeBotMention(text, botUsername);

    if (!cleanQuestion) {
      await sendTelegramMessage(chatId,
        `I'm here! 👀 Ask me anything — I've been reading the conversation.`
      );
      return;
    }

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

  // Get or create user in DB
  const user = await getOrCreateUser(userId, username);

  // /start or greeting
  if (isGreeting(text)) {
    user.selectedAi = null;
    await user.save();

    // Clear conversation history
    await Conversation.findOneAndDelete({ ownerId: userId });

    await sendTelegramMessage(chatId, getWelcomeMessage(username));
    return;
  }

  // /switch
  if (text.toLowerCase() === '/switch') {
    user.selectedAi = null;
    await user.save();
    await Conversation.findOneAndDelete({ ownerId: userId });
    await sendTelegramMessage(chatId, getWelcomeMessage(username));
    return;
  }

  // /reset
  if (text.toLowerCase() === '/reset') {
    await Conversation.findOneAndDelete({ ownerId: userId });
    await sendTelegramMessage(chatId,
      `Conversation cleared! 🧹 Fresh start.\n\nWhat's on your mind, ${username}?`
    );
    return;
  }

  // /help
  if (text.toLowerCase() === '/help') {
    await sendTelegramMessage(chatId, getHelpMessage(false));
    return;
  }

  // /about
  if (text.toLowerCase() === '/about') {
    await sendTelegramMessage(chatId, getAboutMessage());
    return;
  }

  // /stats — show user's usage stats
  if (text.toLowerCase() === '/stats') {
    const resetIn = Math.ceil(24 - ((new Date() - new Date(user.lastResetDate)) / (1000 * 60 * 60)));
    const remaining = Math.max(0, FREE_DAILY_LIMIT - user.dailyMessageCount);

    await sendTelegramMessage(chatId,
      `📊 *Your VibesAi Stats*\n\n` +
      `👤 Name: ${user.username}\n` +
      `🤖 AI Engine: ${user.selectedAi || 'Not selected'}\n` +
      `💬 Total messages: ${user.messageCount}\n` +
      `📅 Today's messages: ${user.dailyMessageCount}/${FREE_DAILY_LIMIT}\n` +
      `⏳ Limit resets in: ${resetIn} hours\n` +
      `🌟 Status: ${user.isPremium ? '⭐ Premium' : 'Free tier'}\n` +
      `📆 Member since: ${new Date(user.joinDate).toDateString()}`
    );
    return;
  }

  // AI selection
  if (!user.selectedAi) {
    if (text === '1') {
      user.selectedAi = 'gemini';
      await user.save();
      await sendTelegramMessage(chatId,
        `✅ *Gemini* locked in.\n\nAlright ${username}, I'm listening. What's on your mind?`
      );
    } else if (text === '2') {
      user.selectedAi = 'deepseek';
      await user.save();
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

  // Message too long
  if (text.length > MAX_MESSAGE_LENGTH) {
    await sendTelegramMessage(chatId,
      `Keep it under ${MAX_MESSAGE_LENGTH} characters please.`, false
    );
    return;
  }

  // Check daily limit
  const withinLimit = await checkDailyLimit(user, chatId);
  if (!withinLimit) return;

  // Normal private conversation
  try {
    const reply = await getPrivateReply(user, text);

    // Increment message count after successful reply
    await user.incrementMessageCount();

    await sendTelegramMessage(chatId, reply, false);
    console.log(`✅ Private reply to ${username} via ${user.selectedAi}`);
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

  if (isGroup) {
    const conversation = await getOrCreateConversation(groupId, 'group', 'WhatsApp Group');
    await conversation.addToBuffer(senderName, text);

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

  const user = await getOrCreateUser(from, senderName);

  if (isGreeting(text)) {
    user.selectedAi = null;
    await user.save();
    await Conversation.findOneAndDelete({ ownerId: from });
    await sendWhatsAppMessage(from,
      `Hey ${senderName}! 👋 Welcome to VibesAi.\n\nChoose your AI:\n1️⃣ Gemini\n2️⃣ DeepSeek\n\nReply 1 or 2.`
    );
    return;
  }

  if (!user.selectedAi) {
    if (text === '1') {
      user.selectedAi = 'gemini';
      await user.save();
      await sendWhatsAppMessage(from, `✅ Gemini locked in. What's on your mind, ${senderName}?`);
    } else if (text === '2') {
      user.selectedAi = 'deepseek';
      await user.save();
      await sendWhatsAppMessage(from, `✅ DeepSeek locked in. What's on your mind, ${senderName}?`);
    } else {
      await sendWhatsAppMessage(from, "Reply 1 for Gemini or 2 for DeepSeek.");
    }
    return;
  }

  const withinLimit = await checkDailyLimit(user, from);
  if (!withinLimit) return;

  try {
    const reply = await getPrivateReply(user, text);
    await user.incrementMessageCount();
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

  const user = await getOrCreateUser(from, 'TestUser');
  if (!user.selectedAi) user.selectedAi = 'gemini';

  try {
    const reply = await getPrivateReply(user, text);
    await user.incrementMessageCount();
    res.json({ reply, ai: user.selectedAi });
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