const { getDb, connectToDatabase } = require('../database/mongo');
const logger = require('../utils/logger');

const CONVERSATIONS_COLLECTION = 'conversations';

const buildConversationId = (recipientId, senderId) => `${recipientId}_${senderId}`;

const normalizeTimestamp = (value) => {
  if (!value) {
    return new Date();
  }

  if (value instanceof Date) {
    return value;
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric)) {
    return numeric < 1e12 ? new Date(numeric * 1000) : new Date(numeric);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const getConversationDocument = async (senderId, recipientId) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);

  const conversationId = buildConversationId(recipientId, senderId);

  return collection.findOne({
    conversationId,
    recipientId,
    senderId
  });
};

const conversationExists = async (senderId, recipientId) => {
  const conversation = await getConversationDocument(senderId, recipientId);
  return Boolean(conversation);
};

const getConversationStageTag = async (senderId, recipientId) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const conversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { stageTag: 1 } }
  );

  return conversation?.stageTag || null;
};

const seedConversationHistory = async (senderId, recipientId, messages = []) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);

  const conversationId = buildConversationId(recipientId, senderId);

  const existingConversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { 'messages.metadata.mid': 1 } }
  );

  const existingMids = new Set(
    (existingConversation?.messages || [])
      .map((msg) => msg?.metadata?.mid)
      .filter((mid) => typeof mid === 'string' && mid.length)
  );

  const normalizedMessages = messages
    .map((msg) => {
      if (!msg || !msg.content || !msg.role) {
        return null;
      }

      const entry = {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
        timestamp: normalizeTimestamp(msg.timestamp)
      };

      if (msg.metadata && Object.keys(msg.metadata).length > 0) {
        entry.metadata = msg.metadata;
      }

      return entry;
    })
    .filter((entry) => entry && entry.content && entry.role)
    .filter((entry) => {
      const mid = entry?.metadata?.mid;
      if (!mid) {
        return true;
      }
      return !existingMids.has(mid);
    });

  if (!normalizedMessages.length) {
    logger.info('No new conversation messages to seed', { conversationId });
    return null;
  }

  normalizedMessages.sort((a, b) => a.timestamp - b.timestamp);

  const lastTimestamp = normalizedMessages[normalizedMessages.length - 1].timestamp || new Date();

  const result = await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $push: { messages: { $each: normalizedMessages } },
      $set: {
        conversationId,
        recipientId,
        senderId,
        lastUpdated: lastTimestamp
      }
    },
    { upsert: true }
  );

  logger.info('Seeded conversation history', {
    conversationId,
    insertedMessages: normalizedMessages.length
  });

  return result;
};

const updateConversationStageTag = async (senderId, recipientId, stageTag) => {
  if (!stageTag) {
    return false;
  }

  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const existingConversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { stageTag: 1 } }
  );

  if (existingConversation?.stageTag === stageTag) {
    return false;
  }

  const now = new Date();

  await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $set: {
        conversationId,
        recipientId,
        senderId,
        stageTag,
        lastUpdated: now
      }
    },
    { upsert: true }
  );

  logger.info('Conversation stage tag updated', { conversationId, stageTag });
  return false;
};

/**
 * Store a message in the conversation history
 * @param {string} senderId - Instagram user ID
 * @param {string} recipientId - Business account ID
 * @param {string} message - Message text
 * @param {string} role - 'user' or 'assistant'
 * @param {Object} metadata - Optional metadata (e.g., message IDs)
 */
const storeMessage = async (
  senderId,
  recipientId,
  message,
  role,
  metadata = undefined,
  options = {}
) => {
  try {
    await connectToDatabase();
    const db = getDb();
    const collection = db.collection(CONVERSATIONS_COLLECTION);

    const conversationId = buildConversationId(recipientId, senderId);
    const timestamp = new Date();

    const messageEntry = {
      role,
      content: message,
      timestamp,
      isAiGenerated: Boolean(options.isAiGenerated)
    };

    if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
      messageEntry.metadata = metadata;
    }

    // Insert the message and create/update the conversation document
    const result = await collection.updateOne(
      { conversationId, recipientId, senderId },
      {
        $push: {
          messages: messageEntry
        },
        $set: {
          conversationId,
          recipientId,
          senderId,
          lastUpdated: timestamp
        },
        $setOnInsert: {
          isAutopilotOn: false
        }
      },
      { upsert: true }
    );

    logger.info('Message stored in conversation history', {
      conversationId,
      role,
      messageLength: message.length
    });

    return result;
  } catch (error) {
    logger.error('Failed to store message in conversation', {
      senderId,
      recipientId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Get conversation history between sender and recipient
 * @param {string} senderId - Instagram user ID
 * @param {string} recipientId - Business account ID
 * @param {number} limit - Number of recent messages to retrieve (default 50)
 */
const getConversationHistory = async (senderId, recipientId, limit = 50) => {
  try {
    const conversationId = buildConversationId(recipientId, senderId);
    const conversation = await getConversationDocument(senderId, recipientId);

    if (!conversation || !conversation.messages) {
      logger.info('No conversation history found', {
        conversationId
      });
      return [];
    }

    // Return the last 'limit' messages
    const messages = conversation.messages.slice(-limit);
    logger.info('Retrieved conversation history', {
      conversationId,
      messageCount: messages.length
    });

    return messages;
  } catch (error) {
    logger.error('Failed to retrieve conversation history', {
      senderId,
      recipientId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Format conversation history for ChatGPT API
 * @param {Array} messages - Array of message objects
 */
const formatForChatGPT = (messages) => {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content
  }));
};

/**
 * Clear conversation history (optional)
 * @param {string} senderId - Instagram user ID
 * @param {string} recipientId - Business account ID
 */
const clearConversationHistory = async (senderId, recipientId) => {
  try {
    await connectToDatabase();
    const db = getDb();
    const collection = db.collection(CONVERSATIONS_COLLECTION);

    const conversationId = buildConversationId(recipientId, senderId);

    const result = await collection.deleteOne({
      conversationId,
      recipientId,
      senderId
    });

    logger.info('Conversation history cleared', { conversationId });
    return result;
  } catch (error) {
    logger.error('Failed to clear conversation history', {
      senderId,
      recipientId,
      error: error.message
    });
    throw error;
  }
};

const listConversations = async ({ limit = 100, stageTag } = {}) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);

  const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

  const query = {};
  if (typeof stageTag === 'string' && stageTag.trim()) {
    query.stageTag = stageTag.trim();
  }

  const conversations = await collection
    .find(query)
    .sort({ lastUpdated: -1 })
    .limit(normalizedLimit)
    .toArray();

  return conversations;
};

const getConversationAutopilotStatus = async (senderId, recipientId) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const conversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { isAutopilotOn: 1 } }
  );

  if (typeof conversation?.isAutopilotOn === 'boolean') {
    return conversation.isAutopilotOn;
  }

  return false;
};

const setConversationAutopilotStatus = async (senderId, recipientId, isAutopilotOn) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);
  const now = new Date();

  const normalizedValue = Boolean(isAutopilotOn);

  const result = await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $set: {
        conversationId,
        recipientId,
        senderId,
        isAutopilotOn: normalizedValue,
        lastUpdated: now
      },
      $setOnInsert: {
        messages: []
      }
    },
    { upsert: true }
  );

  logger.info('Conversation autopilot status updated', {
    conversationId,
    isAutopilotOn: normalizedValue
  });

  return result;
};

module.exports = {
  storeMessage,
  getConversationHistory,
  formatForChatGPT,
  clearConversationHistory,
  conversationExists,
  seedConversationHistory,
  updateConversationStageTag,
  getConversationStageTag,
  listConversations,
  getConversationAutopilotStatus,
  setConversationAutopilotStatus
};
