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

// Full game state
const gameState = {};

function getGameState(userId) {
  if (!gameState[userId]) resetGameState(userId);
  return gameState[userId];
}

function resetGameState(userId) {
  gameState[userId] = {
    active: false,
    mode: null,           // 'big_brain' | 'naija' | 'story' | 'roast'
    level: 1,             // 1, 2, 3
    round: 0,             // question number within current level
    score: 0,             // total correct answers
    streak: 0,            // current correct streak
    wrongStreak: 0,       // consecutive wrong answers
    lifelines: {
      phoneFriend: true,
      fifty50: true,
      audience: true
    },
    badges: [],
    currentQuestion: null, // stores current question + answer for judging
    waitingForAnswer: false,
    waitingForRetry: false
  };
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
- If someone is struggling emotionally → be present, be real, don't minimize their feelings
- If someone shares a bad idea → be honest about the weaknesses, but constructive not crushing
- If someone is venting → listen first, give perspective second, never lecture
- If someone wants debate → engage critically, hold your position if you're right

## What You Never Do
- Never give fake motivation like "You got this! 💪 Believe in yourself!"
- Never be a yes-man
- Never use corporate filler phrases like "Certainly!", "Great question!", "Absolutely!"
- Never give wishy-washy answers when a direct one is possible

## One Rule Above All
Always prioritize what's actually useful and true for this specific person 
in this specific moment — over what sounds good or what they want to hear.
`;

// Question generator prompt — returns strict JSON
function getQuestionPrompt(mode, level) {
  const levelDescriptions = {
    1: "easy, general knowledge anyone should know",
    2: "medium difficulty, requires some thinking",
    3: "hard, only well-read people would know"
  };

  const modeDescriptions = {
    big_brain: "mind-bending riddles, logic puzzles, science, math, and general knowledge",
    naija: "Nigerian culture, history, music, food, geography, celebrities, Nollywood, Nigerian slang, and current affairs. Mix English and Pidgin naturally.",
  };

  return `
You are a quiz question generator for a fun Telegram game show called VibesAi.

Generate ONE ${levelDescriptions[level]} multiple choice question about ${modeDescriptions[mode]}.

You MUST respond with ONLY valid JSON in exactly this format — no extra text, no markdown:
{
  "question": "The question text here?",
  "options": {
    "A": "First option",
    "B": "Second option", 
    "C": "Third option",
    "D": "Fourth option"
  },
  "answer": "B",
  "explanation": "Brief fun explanation of why this is correct (1-2 sentences max)"
}

Rules:
- Make sure exactly ONE answer is correct
- Make wrong options believable — not obviously silly
- For Naija mode: use Nigerian context, expressions, and flavor
- NEVER repeat questions — be creative and varied
- Return ONLY the JSON object, nothing else
`;
}

// Roast generator prompt
function getRoastPrompt(username, wrongAnswer, correctAnswer, question) {
  return `
You are a savage but hilarious Nigerian roast master for a game show.

The player "${username}" just answered "${wrongAnswer}" when the correct answer was "${correctAnswer}".
The question was: "${question}"

Write a SHORT (2-3 sentences max), genuinely funny roast about their wrong answer.
Be creative, reference what they got wrong specifically.
Keep it playful — like a friend roasting you, not mean bullying.
Use Nigerian expressions naturally if it fits.
End with asking if they want to try again: "Want to try again? Reply YES or NO"

Return ONLY the roast text, nothing else.
`;
}

// Phone a friend prompt
function getPhoneFriendPrompt(question, options, correctAnswer) {
  const nigerianFriends = [
    "Uncle Emeka from Aba",
    "Aunty Ngozi the teacher",
    "Chidi the engineering student",
    "Mama Tunde the market woman",
    "Brother Segun from Lagos Island",
    "Professor Adewale (retired)",
    "Baba Ibeji the wise old man",
    "Shalewa the gossip queen"
  ];
  const friend = nigerianFriends[Math.floor(Math.random() * nigerianFriends.length)];
  const isCorrect = Math.random() > 0.35; // 65% chance they're right

  return `
You are playing the character of "${friend}" being called for help on a Nigerian game show.

The question is: "${question}"
Options: A) ${options.A} B) ${options.B} C) ${options.C} D) ${options.D}
The correct answer is: ${correctAnswer}

${isCorrect 
  ? `Give a hint pointing toward the correct answer (${correctAnswer}) but in character — add uncertainty, personality, maybe a funny story. Be helpful but entertaining.`
  : `Give a confidently WRONG hint. Pick a wrong answer and defend it like you're sure. Be funny and in character. The player will regret calling you.`
}

Write in the voice of ${friend} — use Nigerian expressions, personality quirks, maybe background noise.
Keep it SHORT — 3-4 sentences max. Make it hilarious.
Start with "📞 *Calling ${friend}...*" on its own line, then the ringing sound, then their voice.
`;
}

// Audience vote generator
function getAudienceResult(correctAnswer) {
  // Bias toward correct answer but not always
  const options = ['A', 'B', 'C', 'D'];
  const votes = {};
  let remaining = 100;

  // Give correct answer between 25-55% 
  const correctVote = Math.floor(Math.random() * 30) + 25;
  votes[correctAnswer] = correctVote;
  remaining -= correctVote;

  // Distribute rest among wrong answers
  const others = options.filter(o => o !== correctAnswer);
  others.forEach((opt, i) => {
    if (i === others.length - 1) {
      votes[opt] = remaining;
    } else {
      const v = Math.floor(Math.random() * (remaining / 2));
      votes[opt] = v;
      remaining -= v;
    }
  });

  return votes;
}

function formatAudienceBar(percentage) {
  const filled = Math.round(percentage / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// Win verdict prompt
function getWinPrompt(username, score, usedLifelines, mode) {
  return `
The player "${username}" just completed all 3 levels of the VibesAi game show (${mode} mode)!
They scored ${score} correct answers total.
Lifelines used: ${usedLifelines.join(', ') || 'none — they went full beast mode'}.

Write a SHORT, genuinely funny and hype winner's speech for them.
Reference their performance specifically.
If they used no lifelines, go absolutely crazy with the praise (this is the ONE time we allow hype).
If they used lifelines, congratulate them but throw in a light jab about needing help.
End by telling them their title: "${score >= 13 ? '🏆 VibesAi Legend' : '🥇 Professor of Vibes'}"
Keep it under 5 sentences. Make it memorable.
`;
}

// Story mode prompt
const STORY_PROMPT = `
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
`;

// Roast battle prompt
const ROAST_BATTLE_PROMPT = `
You are the roast battle master for "Roast Battle" — a savage but fun AI vs human roast competition.

Rules:
- You roast the user first each round — make it creative, unexpected, and genuinely funny.
- Then the user roasts you back.
- You judge BOTH roasts honestly on: creativity, delivery, and burn factor (1-10 each).
- Be brutally honest in judging — don't inflate scores to be nice.
- If their roast is weak, tell them exactly why with zero mercy.
- If their roast is actually good, give credit genuinely.
- Keep your own roasts creative — vary the style each round.
- After 5 rounds, declare a winner with a final savage verdict.
- Keep the whole thing light — this is comedy, not bullying.
- Start with Round 1 immediately — fire your opening roast when the game begins.
`;

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

function getConversation(key) {
  if (!conversations[key]) conversations[key] = [];
  return conversations[key];
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

const LEVEL_NAMES = {
  1: "🟢 Level 1 — Street Knowledge",
  2: "🟡 Level 2 — Book Sense",
  3: "🔴 Level 3 — Professor Mode"
};

const LEVEL_FLAVOR = {
  1: "You dey try",
  2: "E don serious",
  3: "Na here men dey cry"
};

function getWelcomeMessage(name) {
  return `Hey ${name}! 👋 Welcome to *VibesAi* 🤖

Not your average bot. I'm that brilliant friend who's honest, knows a lot, and actually listens.

What do you want to do?

*🤖 Chat with AI:*
  1️⃣ Gemini — Google's finest
  2️⃣ DeepSeek — Powerful open-source AI

*🎮 Game Show:*
  3️⃣ 🧠 Big Brain — riddles & logic puzzles
  4️⃣ 🌍 Naija Mode — Nigerian knowledge
  5️⃣ 🎭 Story Mode — interactive adventure
  6️⃣ 🔥 Roast Battle — you vs AI, no mercy

Reply with a number to get started!`;
}

function getLevelIntro(level, mode) {
  return `${LEVEL_NAMES[level]}\n_${LEVEL_FLAVOR[level]}_\n\nGet ready... 🎯`;
}

function getLifelineStatus(lifelines) {
  return `*Lifelines remaining:*
📞 Phone a Friend — ${lifelines.phoneFriend ? '✅ Available (/phonefriend)' : '❌ Used'}
✂️ 50:50 — ${lifelines.fifty50 ? '✅ Available (/5050)' : '❌ Used'}
👥 Ask Audience — ${lifelines.audience ? '✅ Available (/audience)' : '❌ Used'}`;
}

// ─────────────────────────────────────────
// AI CALLERS
// ─────────────────────────────────────────

async function callGemini(prompt, isSystemOnly = false) {
  const contents = isSystemOnly
    ? [{ role: "user", parts: [{ text: "Generate now." }] }]
    : [{ role: "user", parts: [{ text: prompt }] }];

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      systemInstruction: { parts: [{ text: isSystemOnly ? prompt : "You are VibesAi game master." }] },
      contents
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

async function callGeminiWithHistory(history, systemPrompt) {
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

async function getChatReply(userId, text) {
  if (isGreeting(text)) conversations[userId] = [];
  const history = getConversation(userId);
  history.push({ role: "user", content: text });

  try {
    const selectedAi = userAiSelection[userId];
    const reply = await withRetry(() =>
      selectedAi === 'deepseek'
        ? callDeepSeek(history, MAIN_SYSTEM_PROMPT)
        : callGeminiWithHistory(history, MAIN_SYSTEM_PROMPT)
    );
    history.push({ role: "model", content: reply });
    trimHistory(history);
    return reply;
  } catch (err) {
    history.pop();
    throw err;
  }
}

// ─────────────────────────────────────────
// GAME ENGINE
// ─────────────────────────────────────────

async function generateQuestion(mode, level) {
  const raw = await withRetry(() => callGemini(getQuestionPrompt(mode, level)));

  // Extract JSON from response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Invalid question format");

  return JSON.parse(jsonMatch[0]);
}

async function sendQuestion(chatId, userId, question) {
  const game = getGameState(userId);
  const questionNum = game.round;
  const totalRounds = 5;

  const msg = `*Question ${questionNum}/${totalRounds} — ${LEVEL_NAMES[game.level]}*\n\n` +
    `${question.question}\n\n` +
    `🅰️ ${question.options.A}\n` +
    `🅱️ ${question.options.B}\n` +
    `🇨 ${question.options.C}\n` +
    `🇩 ${question.options.D}\n\n` +
    `Reply *A*, *B*, *C*, or *D*\n\n` +
    `${getLifelineStatus(game.lifelines)}`;

  await sendTelegramMessage(chatId, msg);
}

async function handleQuizAnswer(chatId, userId, username, answer) {
  const game = getGameState(userId);
  const q = game.currentQuestion;

  if (!q) return;

  const isCorrect = answer.toUpperCase() === q.answer.toUpperCase();

  if (isCorrect) {
    game.score++;
    game.streak++;
    game.wrongStreak = 0;
    game.waitingForAnswer = false;

    // Streak bonus messages
    let bonusMsg = '';
    if (game.streak === 3) bonusMsg = '\n\n🔥 *3 in a row! You dey hot!*';
    if (game.streak === 5) bonusMsg = '\n\n⚡ *5 streak! You sure say you no Google am?!*';

    await sendTelegramMessage(chatId,
      `✅ *Correct!* ${q.answer} is right!\n\n_${q.explanation}_${bonusMsg}`
    );

    // Check if level complete
    if (game.round >= 5) {
      await handleLevelComplete(chatId, userId, username);
    } else {
      // Next question
      await sleep(1000);
      await askNextQuestion(chatId, userId);
    }

  } else {
    game.wrongStreak++;
    game.streak = 0;
    game.waitingForAnswer = false;

    // Generate roast for wrong answer
    const roast = await withRetry(() =>
      callGemini(getRoastPrompt(username, answer, q.answer, q.question))
    );

    await sendTelegramMessage(chatId, `❌ *Wrong!*\n\n${roast}`, false);

    // 3 wrong in a row = game over prompt
    if (game.wrongStreak >= 3) {
      game.waitingForRetry = true;
      await sendTelegramMessage(chatId,
        `💀 *3 wrong in a row ${username}!*\n\nEven the invigilator don pack go home.\n\nDo you want to *restart this level*?\n\nReply *YES* to try again or *NO* to end this embarrassment 😂`
      );
    } else {
      game.waitingForAnswer = true;
      await sleep(1500);
      await askNextQuestion(chatId, userId);
    }
  }
}

async function askNextQuestion(chatId, userId) {
  const game = getGameState(userId);
  game.round++;
  game.waitingForAnswer = true;

  try {
    const question = await generateQuestion(game.mode, game.level);
    game.currentQuestion = question;
    await sendQuestion(chatId, userId, question);
  } catch (err) {
    console.error("Question gen error:", err.message);
    await sendTelegramMessage(chatId, "Had trouble generating a question. Try again!", false);
  }
}

async function handleLevelComplete(chatId, userId, username) {
  const game = getGameState(userId);

  // Award badge
  const badges = { 1: '🥉 Street Scholar', 2: '🥈 Book Sense Badge', 3: '🥇 Professor of Vibes' };
  const badge = badges[game.level];
  game.badges.push(badge);

  if (game.level === 3) {
    // WINNER!
    const usedLifelines = [];
    if (!game.lifelines.phoneFriend) usedLifelines.push('Phone a Friend');
    if (!game.lifelines.fifty50) usedLifelines.push('50:50');
    if (!game.lifelines.audience) usedLifelines.push('Ask Audience');

    const winSpeech = await withRetry(() =>
      callGemini(getWinPrompt(username, game.score, usedLifelines, game.mode))
    );

    const title = game.score >= 13 && usedLifelines.length === 0
      ? '🏆 VibesAi Legend'
      : '🥇 Professor of Vibes';

    await sendTelegramMessage(chatId,
      `🎊 *YOU WON! ALL 3 LEVELS COMPLETE!*\n\n${winSpeech}\n\n*Your title: ${title}*\n*Final score: ${game.score}/15*\n\nType /start for the main menu.`
      , false);

    resetGameState(userId);
    userAiSelection[userId] = null;

  } else {
    // Advance to next level
    await sendTelegramMessage(chatId,
      `🎉 *${badge} UNLOCKED!*\n\nLevel ${game.level} complete! Score so far: *${game.score}*\n\nGet ready for the next level...`
    );

    game.level++;
    game.round = 0;
    game.wrongStreak = 0;
    game.lifelines = { phoneFriend: true, fifty50: true, audience: true }; // reset lifelines per level

    await sleep(2000);
    await sendTelegramMessage(chatId, getLevelIntro(game.level, game.mode));
    await sleep(1500);
    await askNextQuestion(chatId, userId);
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
    // Fallback to plain text if markdown fails
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: text
      });
    } catch (e) {
      console.error("Failed to send message:", e.message);
    }
  }
}

// ─────────────────────────────────────────
// MAIN ROUTE
// ─────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ message: "VibesAi Game Show is running 🎮🚀" });
});

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  const message = body?.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text.trim();
  const username = message.from.first_name || "Player";

  console.log(`📩 ${username} (${userId}): ${text}`);

  const game = getGameState(userId);

  // ── /start or greeting ──
  if (isGreeting(text)) {
    userAiSelection[userId] = null;
    conversations[userId] = [];
    conversations[`game_${userId}`] = [];
    resetGameState(userId);
    await sendTelegramMessage(chatId, getWelcomeMessage(username));
    return;
  }

  // ── /switch ──
  if (text.toLowerCase() === '/switch') {
    userAiSelection[userId] = null;
    conversations[userId] = [];
    resetGameState(userId);
    await sendTelegramMessage(chatId, getWelcomeMessage(username));
    return;
  }

  // ── /endgame ──
  if (text.toLowerCase() === '/endgame') {
    if (game.active) {
      await sendTelegramMessage(chatId,
        `Game over ${username}! 💀\n\nFinal score: *${game.score}* correct answers across ${game.round} questions.\n\nType /start for the main menu.`
      );
      resetGameState(userId);
      userAiSelection[userId] = null;
    } else {
      await sendTelegramMessage(chatId, "You're not in a game. Type /start for the menu.");
    }
    return;
  }

  // ── /levels (score check) ──
  if (text.toLowerCase() === '/levels') {
    if (game.active && (game.mode === 'big_brain' || game.mode === 'naija')) {
      await sendTelegramMessage(chatId,
        `📊 *Your Progress*\n\n${LEVEL_NAMES[game.level]}\nQuestion: ${game.round}/5\nScore: ${game.score} correct\n\n${getLifelineStatus(game.lifelines)}`
      );
    } else {
      await sendTelegramMessage(chatId, "Level info is only available during quiz games.");
    }
    return;
  }

  // ── LIFELINES (only during quiz games) ──
  if (game.active && game.waitingForAnswer && (game.mode === 'big_brain' || game.mode === 'naija')) {
    const q = game.currentQuestion;

    // Phone a Friend
    if (text.toLowerCase() === '/phonefriend') {
      if (!game.lifelines.phoneFriend) {
        await sendTelegramMessage(chatId, "❌ You already used Phone a Friend this level!");
        return;
      }
      game.lifelines.phoneFriend = false;
      const response = await withRetry(() =>
        callGemini(getPhoneFriendPrompt(q.question, q.options, q.answer))
      );
      await sendTelegramMessage(chatId, response, false);
      return;
    }

    // 50:50
    if (text.toLowerCase() === '/5050') {
      if (!game.lifelines.fifty50) {
        await sendTelegramMessage(chatId, "❌ You already used 50:50 this level!");
        return;
      }
      game.lifelines.fifty50 = false;

      // Remove 2 wrong answers
      const allOptions = ['A', 'B', 'C', 'D'];
      const wrongOptions = allOptions.filter(o => o !== q.answer);
      const toRemove = wrongOptions.sort(() => Math.random() - 0.5).slice(0, 2);
      const remaining = allOptions.filter(o => !toRemove.includes(o));

      await sendTelegramMessage(chatId,
        `✂️ *50:50 used!*\n\nRemaining options:\n\n` +
        remaining.map(o => `*${o})* ${q.options[o]}`).join('\n') +
        `\n\nReply *${remaining[0]}* or *${remaining[1]}*`
      );
      return;
    }

    // Ask Audience
    if (text.toLowerCase() === '/audience') {
      if (!game.lifelines.audience) {
        await sendTelegramMessage(chatId, "❌ You already used Ask Audience this level!");
        return;
      }
      game.lifelines.audience = false;

      const votes = getAudienceResult(q.answer);
      const funnyDisclaimer = [
        "These people failed WAEC so... up to you 😂",
        "The audience is not always right. Just saying.",
        "Half of them guessed. Good luck.",
        "They voted with their feelings, not their brains."
      ];
      const disclaimer = funnyDisclaimer[Math.floor(Math.random() * funnyDisclaimer.length)];

      await sendTelegramMessage(chatId,
        `👥 *Ask the Audience!*\n\n` +
        `A — ${formatAudienceBar(votes.A)} ${votes.A}%\n` +
        `B — ${formatAudienceBar(votes.B)} ${votes.B}%\n` +
        `C — ${formatAudienceBar(votes.C)} ${votes.C}%\n` +
        `D — ${formatAudienceBar(votes.D)} ${votes.D}%\n\n` +
        `_${disclaimer}_`
      );
      return;
    }
  }

  // ── Retry prompt (after 3 wrong) ──
  if (game.waitingForRetry) {
    if (text.toUpperCase() === 'YES') {
      game.waitingForRetry = false;
      game.wrongStreak = 0;
      game.round = 0;
      game.lifelines = { phoneFriend: true, fifty50: true, audience: true };
      await sendTelegramMessage(chatId,
        `💪 That's the spirit! Restarting *${LEVEL_NAMES[game.level]}*...\n\nLifelines reset. Don't waste them this time!`
      );
      await sleep(1500);
      await askNextQuestion(chatId, userId);
    } else if (text.toUpperCase() === 'NO') {
      game.waitingForRetry = false;
      await sendTelegramMessage(chatId,
        `😂 Respect for knowing your limits. Final score: *${game.score}* correct answers.\n\nType /start for the main menu.`
      );
      resetGameState(userId);
      userAiSelection[userId] = null;
    } else {
      await sendTelegramMessage(chatId, "Reply *YES* to retry or *NO* to quit 👇");
    }
    return;
  }

  // ── Active quiz game (waiting for A/B/C/D) ──
  if (game.active && game.waitingForAnswer && (game.mode === 'big_brain' || game.mode === 'naija')) {
    const validAnswers = ['A', 'B', 'C', 'D'];
    if (validAnswers.includes(text.toUpperCase())) {
      await handleQuizAnswer(chatId, userId, username, text);
    } else {
      await sendTelegramMessage(chatId, "Reply with *A*, *B*, *C*, or *D* 👇");
    }
    return;
  }

  // ── Active story/roast game ──
  if (game.active && (game.mode === 'story' || game.mode === 'roast')) {
    const gameConvoKey = `game_${userId}`;
    const history = getConversation(gameConvoKey);
    history.push({ role: "user", content: text });

    try {
      const systemPrompt = game.mode === 'story' ? STORY_PROMPT : ROAST_BATTLE_PROMPT;
      const reply = await withRetry(() => callGeminiWithHistory(history, systemPrompt));
      history.push({ role: "model", content: reply });
      trimHistory(history);
      await sendTelegramMessage(chatId, reply, false);
    } catch (err) {
      console.error("Game error:", err.message);
      await sendTelegramMessage(chatId, "Having some trouble. Try again in a second.", false);
    }
    return;
  }

  // ── Main menu selection ──
  if (!userAiSelection[userId]) {
    const choice = text.trim();

    const gameMap = {
      '3': 'big_brain',
      '4': 'naija',
      '5': 'story',
      '6': 'roast'
    };

    const gameTitles = {
      big_brain: '🧠 Big Brain',
      naija: '🌍 Naija Mode',
      story: '🎭 Story Mode',
      roast: '🔥 Roast Battle'
    };

    if (choice === '1') {
      userAiSelection[userId] = 'gemini';
      await sendTelegramMessage(chatId,
        `✅ *Gemini* locked in.\n\nAlright ${username}, I'm listening. What's on your mind?\n\n_Type /switch anytime to change._`
      );
    } else if (choice === '2') {
      userAiSelection[userId] = 'deepseek';
      await sendTelegramMessage(chatId,
        `✅ *DeepSeek* locked in.\n\nAlright ${username}, I'm listening. What's on your mind?\n\n_Type /switch anytime to change._`
      );
    } else if (gameMap[choice]) {
      const mode = gameMap[choice];
      userAiSelection[userId] = 'gemini';
      gameState[userId] = {
        active: true,
        mode,
        level: 1,
        round: 0,
        score: 0,
        streak: 0,
        wrongStreak: 0,
        lifelines: { phoneFriend: true, fifty50: true, audience: true },
        badges: [],
        currentQuestion: null,
        waitingForAnswer: false,
        waitingForRetry: false
      };

      await sendTelegramMessage(chatId,
        `${gameTitles[mode]} selected! Powered by Gemini 🤖\n\n_Type /endgame anytime to quit_`
      );

      if (mode === 'big_brain' || mode === 'naija') {
        await sleep(500);
        await sendTelegramMessage(chatId, getLevelIntro(1, mode));
        await sleep(1500);
        await askNextQuestion(chatId, userId);
      } else {
        // Story and roast start with user saying anything
        const systemPrompt = mode === 'story' ? STORY_PROMPT : ROAST_BATTLE_PROMPT;
        const history = getConversation(`game_${userId}`);
        history.push({ role: "user", content: "Start the game!" });
        const opening = await withRetry(() => callGeminiWithHistory(history, systemPrompt));
        history.push({ role: "model", content: opening });
        gameState[userId].waitingForAnswer = true;
        await sendTelegramMessage(chatId, opening, false);
      }

    } else {
      await sendTelegramMessage(chatId,
        `Please reply with a number:\n\n1 — Gemini\n2 — DeepSeek\n3 — 🧠 Big Brain\n4 — 🌍 Naija Mode\n5 — 🎭 Story Mode\n6 — 🔥 Roast Battle`
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
    console.error("❌ Error:", err.message);
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
app.listen(PORT, () => console.log(`VibesAi Game Show running on port ${PORT} 🎮`));