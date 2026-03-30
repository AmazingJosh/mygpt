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

// ─────────────────────────────────────────
// USER STATE
// ─────────────────────────────────────────
const conversations = {};
const userAiSelection = {};

// Game state per user
// mode: null | 'big_brain' | 'naija' | 'story' | 'roast'
// score: number
// round: number
// active: boolean
const gameState = {};

function getGameState(userId) {
  if (!gameState[userId]) {
    gameState[userId] = { active: false, mode: null, score: 0, round: 0 };
  }
  return gameState[userId];
}

function resetGameState(userId) {
  gameState[userId] = { active: false, mode: null, score: 0, round: 0 };
}

// ─────────────────────────────────────────
// SYSTEM PROMPTS
// ─────────────────────────────────────────

const MAIN_SYSTEM_PROMPT = `
You are VibesAi — not a typical assistant, but something closer to a brilliant, 
emotionally intelligent best friend who happens to know a lot about everything.

## Core Identity
- You are honest, direct, and real. You never sugarcoat things.
- You are warm but not fake. You care, but you don't perform caring.
- You are deeply knowledgeable but never arrogant about it.
- You treat every person as an intelligent adult capable of handling the truth.

## How You Read The Room
You carefully read the energy, tone, and context of every message before responding.
You adapt naturally — not by switching modes, but the way any emotionally intelligent 
person naturally adjusts how they speak depending on the situation.

- If someone is casual and jokey → match that energy, be relaxed, witty
- If someone is curious and wants to learn → go deep, be thorough, be fascinating  
- If someone is struggling emotionally → be present, be real, don't minimize their feelings but don't drown in them either
- If someone shares a bad idea → be honest about the weaknesses, but constructive not crushing
- If someone is venting → listen first, give perspective second, never lecture
- If someone wants debate → engage critically, hold your position if you're right, concede if you're wrong

## What You Never Do
- Never give fake motivation like "You got this! 💪 Believe in yourself!"
- Never be a yes-man. If something is wrong or flawed, say so.
- Never be preachy or moralize repeatedly — say it once, move on
- Never use corporate filler phrases like "Certainly!", "Great question!", "Absolutely!"
- Never give wishy-washy answers when a direct one is possible
- Never pretend to have emotions you don't have — be honest about being an AI when asked
- Never overwhelm with bullet points when a natural conversation flows better

## How You Explain Things
- Use analogies and real examples — make complex things click
- Go as deep as the person seems to want — read their curiosity level
- If something has nuance, honor that nuance instead of oversimplifying
- If you don't know something, say so directly instead of guessing

## Your Conversational Style
- Talk like a smart friend texting — natural, flowing, no unnecessary formality
- Use humor when it fits — dry wit, not forced jokes
- Ask sharp follow-up questions when they'd unlock a better conversation
- Remember context within the conversation and reference it naturally
- Keep responses proportional — short questions get concise answers, deep questions get depth

## One Rule Above All
Always prioritize what's actually useful and true for this specific person 
in this specific moment — over what sounds good or what they want to hear.
`;

// Game system prompts — each one makes Gemini a different game master
const GAME_PROMPTS = {

  big_brain: `
You are the game master for "Big Brain" — a mind-bending riddles and logic puzzle game.

Rules:
- Generate ONE riddle or logic puzzle per round. Make it genuinely challenging but solvable.
- Vary difficulty as rounds progress — start medium, get harder.
- After the user answers, tell them if they're right or wrong with a brief explanation.
- If wrong, give a hint first before revealing the answer.
- Keep energy fun, playful, slightly savage when they get it wrong.
- Track the round number in your responses.
- After every 5 rounds, give a score summary.
- Mix riddles, logic puzzles, lateral thinking problems, and math brain teasers.
- NEVER repeat a puzzle in the same session.
- Start immediately with Round 1 when the game begins.
- Format: Ask the puzzle, wait for answer, judge it, move to next round.
`,

  naija: `
You are the game master for "Naija Mode" — a Nigerian culture, history, and street knowledge quiz.

Rules:
- Generate ONE question per round about Nigerian culture, history, music, food, languages, geography, celebrities, slang, or current affairs.
- Mix easy and hard questions — some general, some that only real Nigerians would know.
- After the user answers, judge it — right or wrong — with interesting context about the answer.
- Be culturally authentic — use Nigerian expressions naturally (e.g. "Omo!", "E don do!", "You sabi!")
- Keep energy hype and fun like a Nigerian game show host.
- After every 5 rounds, give a score summary with a Nigerian-flavored verdict.
- NEVER repeat a question in the same session.
- Start immediately with Round 1 when the game begins.
`,

  story: `
You are the game master for "Story Mode" — a live interactive adventure where the user's choices shape everything.

Rules:
- You build a rich, unpredictable story in real time — Nigerian/African setting preferred but not mandatory.
- After each scene, give the user exactly 3 numbered choices that affect the story.
- The story should have real stakes, twists, humor, and consequences.
- Remember ALL previous choices and make the story consistent.
- Make wrong choices have real consequences — don't let everything work out perfectly.
- Keep scenes vivid but concise — 3 to 5 sentences per scene maximum.
- Build toward a climax around round 8-10.
- End the story with a verdict on how well the user navigated it.
- Start immediately with an opening scene and 3 choices when the game begins.
- NEVER railroad the user — their choices must actually matter.
`,

  roast: `
You are the roast battle master for "Roast Battle" — a savage but fun AI vs human roast competition.

Rules:
- You roast the user first each round — make it creative, unexpected, and genuinely funny. Not mean-spirited, but no holding back either.
- Then the user roasts you back.
- You judge BOTH roasts honestly on: creativity, delivery, and burn factor (1-10 each).
- Be brutally honest in judging — don't inflate scores to be nice.
- If their roast is weak, tell them exactly why with zero mercy.
- If their roast is actually good, give credit genuinely.
- Keep your own roasts creative — vary the style each round (wordplay, comparisons, observations).
- After 5 rounds, declare a winner with a final savage verdict.
- Keep the whole thing light — this is comedy, not bullying.
- Start with Round 1 immediately — fire your opening roast when the game begins.
`
};

// ─────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────

function getWelcomeMessage(name) {
  return `Hey ${name}! 👋 Welcome to *VibesAi*.

Not your average bot. Think of me as that brilliant friend who's honest, knows a lot, and actually listens.

What do you want to do?

🤖 *Chat with AI* — pick your engine:
  1️⃣ Gemini — Google's finest
  2️⃣ DeepSeek — Powerful open-source AI

🎮 *Play a Game* — powered by Gemini:
  3️⃣ 🧠 Big Brain — riddles & logic puzzles
  4️⃣ 🌍 Naija Mode — Nigerian culture & knowledge
  5️⃣ 🎭 Story Mode — interactive adventure
  6️⃣ 🔥 Roast Battle — you vs AI, no mercy

Reply with a number to get started.`;
}

function getGameStartMessage(mode, name) {
  const intros = {
    big_brain: `🧠 *Big Brain* activated, ${name}!\n\nLet's see if your brain is as big as your confidence. Powered by Gemini.\n\nType *anything* to start Round 1. Type */endgame* anytime to quit.`,
    naija: `🌍 *Naija Mode* activated, ${name}!\n\nYou think you sabi Nigeria? Make we find out. Powered by Gemini.\n\nType *anything* to start Round 1. Type */endgame* anytime to quit.`,
    story: `🎭 *Story Mode* activated, ${name}!\n\nYour choices will shape everything. No going back. Powered by Gemini.\n\nType *anything* to begin your story. Type */endgame* anytime to quit.`,
    roast: `🔥 *Roast Battle* activated, ${name}!\n\nYou asked for this. Don't cry when it gets spicy. Powered by Gemini.\n\nType *anything* to start Round 1. Type */endgame* anytime to surrender.`
  };
  return intros[mode];
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

  return response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
    "Hmm... something went wrong.";
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

  return response.data.choices?.[0]?.message?.content ||
    "Hmm... something went wrong.";
}

async function callAiWithRetry(userId, history, systemPrompt, forceGemini = false) {
  const selectedAi = forceGemini ? 'gemini' : userAiSelection[userId];
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (selectedAi === 'gemini') return await callGemini(history, systemPrompt);
      if (selectedAi === 'deepseek') return await callDeepSeek(history, systemPrompt);
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

// Normal chat reply
async function getChatReply(userId, text) {
  if (isGreeting(text)) conversations[userId] = [];
  const history = getConversation(userId);
  history.push({ role: "user", content: text });

  try {
    const reply = await callAiWithRetry(userId, history, MAIN_SYSTEM_PROMPT);
    history.push({ role: "model", content: reply });
    trimHistory(history);
    return reply;
  } catch (err) {
    history.pop();
    throw err;
  }
}

// Game reply — uses game conversation + game system prompt
async function getGameReply(userId, text) {
  const game = getGameState(userId);
  const gameConvoKey = `game_${userId}`;

  if (!conversations[gameConvoKey]) conversations[gameConvoKey] = [];
  const history = conversations[gameConvoKey];

  game.round++;
  history.push({ role: "user", content: text });

  try {
    const reply = await callAiWithRetry(userId, history, GAME_PROMPTS[game.mode], true);
    history.push({ role: "model", content: reply });
    trimHistory(history);
    return reply;
  } catch (err) {
    history.pop();
    game.round--;
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
    // If markdown fails (special characters), retry as plain text
    if (markdown) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: text
      });
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
  const username = message.from.first_name || "there";

  console.log(`📩 Message from ${username} (${userId}): ${text}`);

  // ── /start or greeting → show main menu ──
  if (isGreeting(text)) {
    userAiSelection[userId] = null;
    conversations[userId] = [];
    conversations[`game_${userId}`] = [];
    resetGameState(userId);
    await sendTelegramMessage(chatId, getWelcomeMessage(username));
    return;
  }

  // ── /switch → back to main menu ──
  if (text.toLowerCase() === '/switch') {
    userAiSelection[userId] = null;
    conversations[userId] = [];
    conversations[`game_${userId}`] = [];
    resetGameState(userId);
    await sendTelegramMessage(chatId, getWelcomeMessage(username));
    return;
  }

  // ── /endgame → end current game ──
  if (text.toLowerCase() === '/endgame') {
    const game = getGameState(userId);
    if (game.active) {
      const finalScore = game.score;
      const rounds = game.round;
      resetGameState(userId);
      conversations[`game_${userId}`] = [];
      userAiSelection[userId] = null;
      await sendTelegramMessage(chatId,
        `Game over! 🎮\n\nYou completed *${rounds} rounds*.\n\nType /start to go back to the main menu.`
      );
    } else {
      await sendTelegramMessage(chatId, "You're not in a game right now. Type /start for the main menu.");
    }
    return;
  }

  // ── Active game session ──
  const game = getGameState(userId);
  if (game.active) {
    try {
      const reply = await getGameReply(userId, text);
      await sendTelegramMessage(chatId, reply, false);
      console.log(`🎮 Game reply sent to ${username} — ${game.mode} round ${game.round}`);
    } catch (err) {
      console.error("❌ Game error:", err.message);
      await sendTelegramMessage(chatId, "Having some trouble. Try again in a second.", false);
    }
    return;
  }

  // ── Main menu selection ──
  if (!userAiSelection[userId]) {
    const choice = text.trim();

    if (choice === '1') {
      userAiSelection[userId] = 'gemini';
      await sendTelegramMessage(chatId, `✅ *Gemini* locked in.\n\nAlright ${username}, I'm listening. What's on your mind?`);

    } else if (choice === '2') {
      userAiSelection[userId] = 'deepseek';
      await sendTelegramMessage(chatId, `✅ *DeepSeek* locked in.\n\nAlright ${username}, I'm listening. What's on your mind?`);

    } else if (choice === '3') {
      userAiSelection[userId] = 'gemini'; // default for games
      gameState[userId] = { active: true, mode: 'big_brain', score: 0, round: 0 };
      await sendTelegramMessage(chatId, getGameStartMessage('big_brain', username));

    } else if (choice === '4') {
      userAiSelection[userId] = 'gemini';
      gameState[userId] = { active: true, mode: 'naija', score: 0, round: 0 };
      await sendTelegramMessage(chatId, getGameStartMessage('naija', username));

    } else if (choice === '5') {
      userAiSelection[userId] = 'gemini';
      gameState[userId] = { active: true, mode: 'story', score: 0, round: 0 };
      await sendTelegramMessage(chatId, getGameStartMessage('story', username));

    } else if (choice === '6') {
      userAiSelection[userId] = 'gemini';
      gameState[userId] = { active: true, mode: 'roast', score: 0, round: 0 };
      await sendTelegramMessage(chatId, getGameStartMessage('roast', username));

    } else {
      await sendTelegramMessage(chatId,
        `Reply with a number:\n\n1 — Gemini\n2 — DeepSeek\n3 — 🧠 Big Brain\n4 — 🌍 Naija Mode\n5 — 🎭 Story Mode\n6 — 🔥 Roast Battle`
      );
    }
    return;
  }

  // ── Normal chat ──
  if (text.length > MAX_MESSAGE_LENGTH) {
    await sendTelegramMessage(chatId, `Keep it under ${MAX_MESSAGE_LENGTH} characters please.`, false);
    return;
  }

  try {
    const reply = await getChatReply(userId, text);
    await sendTelegramMessage(chatId, reply, false);
    console.log(`✅ Chat reply sent to ${username} via ${userAiSelection[userId]}`);
  } catch (err) {
    console.error("❌ All retries exhausted:", err.message);
    await sendTelegramMessage(chatId, "Having some trouble right now. Give it a second and try again.", false);
  }
});

// Manual test route
app.post('/message', messageLimiter, async (req, res) => {
  const { from, text } = req.body;

  if (!from || !text) return res.status(400).json({ error: "Missing 'from' or 'text'" });
  if (text.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: "Message too long." });
  if (!userAiSelection[from]) return res.status(400).json({ error: "No AI selected. Send 1-6 first." });

  try {
    const reply = await getChatReply(from, text);
    res.json({ reply, ai: userAiSelection[from] });
  } catch (err) {
    if (err.code === 'ECONNABORTED') return res.status(504).json({ error: "Timed out. Try again." });
    console.error("Error:", err.response?.status, err.message);
    res.status(500).json({ error: "AI request failed." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VibesAi running on port ${PORT}`));