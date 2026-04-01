const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Telegram user ID — unique identifier
  userId: {
    type: String,
    required: true,
    unique: true
  },

  // Telegram display name
  username: {
    type: String,
    default: 'Friend'
  },

  // Their selected AI engine
  selectedAi: {
    type: String,
    enum: ['gemini', 'deepseek'],
    default: 'gemini'
  },

  // Premium status
  isPremium: {
    type: Boolean,
    default: false
  },

  // Premium expiry date (null if not premium)
  premiumExpiry: {
    type: Date,
    default: null
  },

  // Usage tracking
  messageCount: {
    type: Number,
    default: 0
  },

  // Daily message count — resets every day
  dailyMessageCount: {
    type: Number,
    default: 0
  },

  // Last time daily count was reset
  lastResetDate: {
    type: Date,
    default: Date.now
  },

  // When they first started using the bot
  joinDate: {
    type: Date,
    default: Date.now
  },

  // Last active timestamp
  lastActive: {
    type: Date,
    default: Date.now
  }
});

// Method to check if daily limit is reached
userSchema.methods.isDailyLimitReached = function () {
  const FREE_DAILY_LIMIT = 30;

  // Premium users have no limit
  if (this.isPremium) return false;

  // Check if we need to reset daily count
  const now = new Date();
  const lastReset = new Date(this.lastResetDate);
  const hoursSinceReset = (now - lastReset) / (1000 * 60 * 60);

  if (hoursSinceReset >= 24) {
    // Reset the daily count
    this.dailyMessageCount = 0;
    this.lastResetDate = now;
  }

  return this.dailyMessageCount >= FREE_DAILY_LIMIT;
};

// Method to increment message counts
userSchema.methods.incrementMessageCount = async function () {
  this.messageCount += 1;
  this.dailyMessageCount += 1;
  this.lastActive = new Date();
  await this.save();
};

module.exports = mongoose.model('User', userSchema);
