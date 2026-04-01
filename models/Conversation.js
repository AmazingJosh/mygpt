const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'model'],
    required: true
  },
  content: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const conversationSchema = new mongoose.Schema({
  // Who owns this conversation
  // For private: userId
  // For group: groupId
  ownerId: {
    type: String,
    required: true,
    unique: true
  },

  // private or group
  type: {
    type: String,
    enum: ['private', 'group'],
    default: 'private'
  },

  // Group name (only for group conversations)
  groupName: {
    type: String,
    default: null
  },

  // The actual conversation messages
  history: [messageSchema],

  // For groups — the raw message buffer (all messages, not just bot interactions)
  // Stored as simple strings: "[Name]: message"
  messageBuffer: [{
    type: String
  }],

  // Last updated
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

// Keep history trimmed to last 30 messages
conversationSchema.methods.addMessage = async function (role, content) {
  this.history.push({ role, content });

  // Trim in pairs to avoid orphaned messages
  while (this.history.length > 30) {
    this.history.splice(0, 2);
  }

  this.lastUpdated = new Date();
  await this.save();
};

// Add to group message buffer
conversationSchema.methods.addToBuffer = async function (senderName, text) {
  this.messageBuffer.push(`[${senderName}]: ${text}`);

  // Keep buffer at max 50 messages
  if (this.messageBuffer.length > 50) {
    this.messageBuffer.splice(0, this.messageBuffer.length - 50);
  }

  this.lastUpdated = new Date();
  await this.save();
};

// Get buffer as readable string for AI context
conversationSchema.methods.getBufferContext = function () {
  if (!this.messageBuffer || this.messageBuffer.length === 0) {
    return "No prior conversation in this group yet.";
  }
  return this.messageBuffer.join('\n');
};

module.exports = mongoose.model('Conversation', conversationSchema);
