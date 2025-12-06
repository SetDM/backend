const { randomUUID } = require('crypto');
const { getDb, connectToDatabase } = require('../database/mongo');
const logger = require('../utils/logger');

const CONVERSATIONS_COLLECTION = 'conversations';

const buildConversationId = (recipientId, senderId) => `${recipientId}_${senderId}`;

const normalizeStageValue = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

const isFlagStageValue = (value) => {
  const normalized = normalizeStageValue(value);
  return normalized === 'flag' || normalized === 'flagged';
};

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
    { projection: { stageTag: 1, isFlagged: 1 } }
  );

  if (conversation?.isFlagged) {
    return 'flag';
  }

  return conversation?.stageTag || null;
};

const getConversationFlagStatus = async (senderId, recipientId) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const conversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { isFlagged: 1, stageTag: 1 } }
  );

  if (typeof conversation?.isFlagged === 'boolean') {
    return conversation.isFlagged;
  }

  return isFlagStageValue(conversation?.stageTag);
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
      },
      $setOnInsert: {
        isFlagged: false
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
  const normalizedStage = normalizeStageValue(stageTag);
  if (!normalizedStage) {
    return false;
  }

  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const existingConversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { stageTag: 1, isFlagged: 1 } }
  );

  const isFlagUpdate = isFlagStageValue(normalizedStage);

  if (isFlagUpdate) {
    if (existingConversation?.isFlagged) {
      return false;
    }
  } else if (
    existingConversation?.stageTag === normalizedStage &&
    existingConversation?.isFlagged !== true
  ) {
    return false;
  }

  const now = new Date();
  const updateFields = {
    conversationId,
    recipientId,
    senderId,
    lastUpdated: now
  };

  if (isFlagUpdate) {
    updateFields.isFlagged = true;
  } else {
    updateFields.stageTag = normalizedStage;
    updateFields.isFlagged = false;
  }

  await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $set: updateFields,
      $setOnInsert: {
        messages: []
      }
    },
    { upsert: true }
  );

  logger.info('Conversation stage state updated', {
    conversationId,
    stageTag: normalizedStage,
    isFlagged: isFlagUpdate
  });
  return true;
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
          isAutopilotOn: false,
          queuedMessages: [],
          isFlagged: false
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
    const normalizedStage = normalizeStageValue(stageTag);

    if (normalizedStage) {
      if (isFlagStageValue(normalizedStage)) {
        query.isFlagged = true;
      } else {
        query.stageTag = normalizedStage;
        query.isFlagged = { $ne: true };
      }
    }
  }

  const conversations = await collection
    .find(query)
    .sort({ lastUpdated: -1 })
    .limit(normalizedLimit)
    .toArray();

  for (const conversation of conversations) {
    if (!Array.isArray(conversation.queuedMessages) || !conversation.queuedMessages.length) {
      continue;
    }

    let requiresUpdate = false;
    const normalizedQueue = conversation.queuedMessages.map((entry = {}) => {
      if (entry && typeof entry.id === 'string' && entry.id.trim().length > 0) {
        return entry;
      }

      requiresUpdate = true;
      return {
        ...entry,
        id: randomUUID()
      };
    });

    if (requiresUpdate) {
      conversation.queuedMessages = normalizedQueue;
      await collection.updateOne(
        {
          conversationId: conversation.conversationId,
          recipientId: conversation.recipientId,
          senderId: conversation.senderId
        },
        {
          $set: {
            queuedMessages: normalizedQueue
          }
        }
      );
    }
  }

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
        messages: [],
        isFlagged: false
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

const enqueueConversationMessage = async ({ senderId, recipientId, content, delayMs }) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const now = new Date();
  const scheduledFor = new Date(now.getTime() + Math.max(0, Number(delayMs) || 0));

  const entry = {
    id: randomUUID(),
    content,
    createdAt: now,
    scheduledFor,
    delayMs: Math.max(0, Number(delayMs) || 0)
  };

  await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $push: {
        queuedMessages: entry
      },
      $setOnInsert: {
        conversationId,
        recipientId,
        senderId,
        messages: [],
        lastUpdated: now,
        isAutopilotOn: false,
        isFlagged: false
      }
    },
    { upsert: true }
  );

  return entry;
};

const removeQueuedConversationMessage = async ({ senderId, recipientId, queuedMessageId }) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const result = await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $pull: {
        queuedMessages: {
          id: queuedMessageId
        }
      }
    }
  );

  return result.modifiedCount > 0;
};

const popQueuedConversationMessage = async ({ senderId, recipientId, queuedMessageId }) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const result = await collection.findOneAndUpdate(
    {
      conversationId,
      recipientId,
      senderId,
      'queuedMessages.id': queuedMessageId
    },
    {
      $pull: {
        queuedMessages: {
          id: queuedMessageId
        }
      }
    },
    {
      projection: { queuedMessages: 1 },
      returnDocument: 'before'
    }
  );

  if (!result?.value?.queuedMessages) {
    return null;
  }

  const removedEntry = result.value.queuedMessages.find((entry) => entry?.id === queuedMessageId);
  return removedEntry || null;
};

const restoreQueuedConversationMessage = async ({ senderId, recipientId, entry }) => {
  if (!entry) {
    return false;
  }

  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $push: {
        queuedMessages: entry
      }
    }
  );

  return true;
};

const getQueuedConversationMessages = async (senderId, recipientId) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const conversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { queuedMessages: 1 } }
  );

  return Array.isArray(conversation?.queuedMessages) ? conversation.queuedMessages : [];
};

const clearQueuedConversationMessages = async (senderId, recipientId) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $set: {
        queuedMessages: []
      }
    }
  );
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
  getConversationFlagStatus,
  listConversations,
  getConversationAutopilotStatus,
  setConversationAutopilotStatus,
  enqueueConversationMessage,
  removeQueuedConversationMessage,
  getQueuedConversationMessages,
  clearQueuedConversationMessages,
  popQueuedConversationMessage,
  restoreQueuedConversationMessage
};
