const { randomUUID } = require('crypto');
const { getDb, connectToDatabase } = require('../database/mongo');
const logger = require('../utils/logger');

const CONVERSATIONS_COLLECTION = 'conversations';
const MAX_QUEUED_MESSAGES = 3;

const buildConversationId = (recipientId, senderId) => `${recipientId}_${senderId}`;

const normalizeStageValue = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

const canonicalStageKey = (value) => {
  const normalized = normalizeStageValue(value);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/[\s_]+/g, '-');
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

  const shouldDisableAutopilot = !isFlagUpdate && normalizedStage === 'call-booked';

  if (isFlagUpdate) {
    updateFields.isFlagged = true;
    updateFields.isAutopilotOn = false;
    updateFields.queuedMessages = [];
  } else {
    updateFields.stageTag = normalizedStage;
    updateFields.isFlagged = false;
    if (shouldDisableAutopilot) {
      updateFields.isAutopilotOn = false;
      updateFields.queuedMessages = [];
    }
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
    isFlagged: isFlagUpdate,
    autopilotDisabled: shouldDisableAutopilot,
    queuedMessagesCleared: shouldDisableAutopilot
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

const clearQueueIfLimitExceeded = async ({
  collection,
  conversationId,
  recipientId,
  senderId,
  queueLength,
  allowEqualToLimit = false,
  reason = 'queue-limit-check'
}) => {
  const hasBreach =
    queueLength > MAX_QUEUED_MESSAGES ||
    (allowEqualToLimit && queueLength >= MAX_QUEUED_MESSAGES);

  if (!hasBreach) {
    return false;
  }

  await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $set: {
        queuedMessages: []
      }
    }
  );

  logger.warn('Queued message limit exceeded; clearing queue', {
    conversationId,
    recipientId,
    senderId,
    queueLength,
    limit: MAX_QUEUED_MESSAGES,
    reason
  });

  return true;
};

const ensureQueuedMessageIds = async (conversation, collection) => {
  if (
    !conversation ||
    !Array.isArray(conversation.queuedMessages) ||
    conversation.queuedMessages.length === 0
  ) {
    return conversation;
  }

  const queueLength = conversation.queuedMessages.length;
  if (queueLength > MAX_QUEUED_MESSAGES) {
    if (collection) {
      await clearQueueIfLimitExceeded({
        collection,
        conversationId: conversation.conversationId,
        recipientId: conversation.recipientId,
        senderId: conversation.senderId,
        queueLength,
        reason: 'read-normalization'
      });
    }

    conversation.queuedMessages = [];
    return conversation;
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

  if (!requiresUpdate) {
    return conversation;
  }

  conversation.queuedMessages = normalizedQueue;

  if (!collection) {
    return conversation;
  }

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

  return conversation;
};

const listConversations = async ({ limit = 100, skip = 0, stageTag, messageSlice = 'all' } = {}) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);

  const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const normalizedSkip = Math.max(Number(skip) || 0, 0);

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

  const projection = {
    conversationId: 1,
    recipientId: 1,
    senderId: 1,
    stageTag: 1,
    lastUpdated: 1,
    isFlagged: 1,
    isAutopilotOn: 1,
    aiNotes: 1,
    metadata: 1
  };

  if (messageSlice === 'last') {
    projection.messages = { $slice: -1 };
    projection.queuedMessages = 0;
  } else if (messageSlice === 'none') {
    projection.messages = { $slice: 0 };
    projection.queuedMessages = 0;
  } else {
    projection.messages = 1;
    projection.queuedMessages = 1;
  }

  const conversations = await collection
    .find(query, { projection })
    .sort({ lastUpdated: -1 })
    .skip(normalizedSkip)
    .limit(normalizedLimit)
    .toArray();

  for (const conversation of conversations) {
    await ensureQueuedMessageIds(conversation, collection);
  }

  return conversations;
};

const getConversationDetail = async ({
  senderId,
  recipientId,
  messageLimit = 200,
  includeQueuedMessages = true
} = {}) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const normalizedLimit = Math.min(Math.max(Number(messageLimit) || 50, 1), 1000);

  const projection = {
    conversationId: 1,
    recipientId: 1,
    senderId: 1,
    stageTag: 1,
    lastUpdated: 1,
    isFlagged: 1,
    isAutopilotOn: 1,
    aiNotes: 1,
    metadata: 1,
    messages: { $slice: -normalizedLimit }
  };

  if (includeQueuedMessages) {
    projection.queuedMessages = 1;
  } else {
    projection.queuedMessages = 0;
  }

  const conversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection }
  );

  if (!conversation) {
    return null;
  }

  await ensureQueuedMessageIds(conversation, collection);

  return conversation;
};

const getConversationAutopilotStatus = async (senderId, recipientId) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const conversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { isAutopilotOn: 1, stageTag: 1 } }
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
  const existingConversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { isFlagged: 1 } }
  );

  if (normalizedValue && existingConversation?.isFlagged) {
    const error = new Error('Cannot enable autopilot for flagged conversations');
    error.code = 'FLAGGED_CONVERSATION_NOT_ALLOWED';
    throw error;
  }

  const resolvedAutopilotValue = normalizedValue && !existingConversation?.isFlagged;

  const result = await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $set: {
        conversationId,
        recipientId,
        senderId,
        isAutopilotOn: resolvedAutopilotValue,
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
    isAutopilotOn: resolvedAutopilotValue
  });

  return result;
};

const enqueueConversationMessage = async ({
  senderId,
  recipientId,
  content,
  delayMs,
  metadata
}) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const existingConversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { queuedMessages: 1 } }
  );

  const existingQueueLength = Array.isArray(existingConversation?.queuedMessages)
    ? existingConversation.queuedMessages.length
    : 0;

  if (existingQueueLength >= MAX_QUEUED_MESSAGES) {
    await clearQueueIfLimitExceeded({
      collection,
      conversationId,
      recipientId,
      senderId,
      queueLength: existingQueueLength,
      allowEqualToLimit: true,
      reason: 'enqueue'
    });
  }

  const now = new Date();
  const scheduledFor = new Date(now.getTime() + Math.max(0, Number(delayMs) || 0));

  const entry = {
    id: randomUUID(),
    content,
    createdAt: now,
    scheduledFor,
    delayMs: Math.max(0, Number(delayMs) || 0)
  };

  if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
    entry.metadata = metadata;
  }

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

const popQueuedConversationMessage = async ({ senderId, recipientId, queuedMessageId }) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const conversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { queuedMessages: 1 } }
  );

  const queuedMessages = Array.isArray(conversation?.queuedMessages)
    ? conversation.queuedMessages
    : [];

  if (!queuedMessages.length) {
    return null;
  }

  const targetId = String(queuedMessageId);
  const removedEntry = queuedMessages.find((entry) => {
    if (!entry) {
      return false;
    }
    const candidateId = entry.id ?? entry._id;
    if (candidateId === undefined || candidateId === null) {
      return false;
    }
    return String(candidateId) === targetId;
  });

  if (!removedEntry) {
    return null;
  }

  const pullFilter =
    removedEntry.id !== undefined
      ? { id: removedEntry.id }
      : removedEntry._id !== undefined
        ? { _id: removedEntry._id }
        : removedEntry;

  await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $pull: {
        queuedMessages: pullFilter
      }
    }
  );

  return removedEntry;
};

const removeQueuedConversationMessage = async ({ senderId, recipientId, queuedMessageId }) => {
  const removedEntry = await popQueuedConversationMessage({
    senderId,
    recipientId,
    queuedMessageId
  });

  return Boolean(removedEntry);
};

const restoreQueuedConversationMessage = async ({ senderId, recipientId, entry }) => {
  if (!entry) {
    return false;
  }

  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);

  const existingConversation = await collection.findOne(
    { conversationId, recipientId, senderId },
    { projection: { queuedMessages: 1 } }
  );

  const existingQueueLength = Array.isArray(existingConversation?.queuedMessages)
    ? existingConversation.queuedMessages.length
    : 0;

  if (existingQueueLength >= MAX_QUEUED_MESSAGES) {
    await clearQueueIfLimitExceeded({
      collection,
      conversationId,
      recipientId,
      senderId,
      queueLength: existingQueueLength,
      allowEqualToLimit: true,
      reason: 'restore'
    });
  }

  const normalizedEntry = {
    ...entry
  };

  if (!normalizedEntry.id) {
    normalizedEntry.id = randomUUID();
  }

  await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $push: {
        queuedMessages: normalizedEntry
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

  if (conversation) {
    await ensureQueuedMessageIds(conversation, collection);
  }

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

const clearConversationFlag = async (senderId, recipientId) => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);
  const conversationId = buildConversationId(recipientId, senderId);
  const now = new Date();

  const result = await collection.updateOne(
    { conversationId, recipientId, senderId },
    {
      $set: {
        conversationId,
        recipientId,
        senderId,
        isFlagged: false,
        lastUpdated: now
      },
      $setOnInsert: {
        messages: [],
        isAutopilotOn: false,
        queuedMessages: []
      }
    },
    { upsert: true }
  );

  return result.modifiedCount > 0 || result.upsertedCount > 0;
};

const buildEmptyFunnelMetrics = () => ({
  responded: 0,
  lead: 0,
  qualified: 0,
  bookingSent: 0,
  callBooked: 0,
  sale: 0
});

const getConversationMetricsSummary = async () => {
  await connectToDatabase();
  const db = getDb();
  const collection = db.collection(CONVERSATIONS_COLLECTION);

  const stageBucketsPromise = collection
    .aggregate([
      {
        $match: {
          isFlagged: { $ne: true }
        }
      },
      {
        $group: {
          _id: { $ifNull: ['$stageTag', 'responded'] },
          count: { $sum: 1 }
        }
      }
    ])
    .toArray();

  const activeCountPromise = collection.countDocuments({ isFlagged: { $ne: true } });
  const autopilotEnabledPromise = collection.countDocuments({ isAutopilotOn: true });
  const flaggedCountPromise = collection.countDocuments({ isFlagged: true });
  const followupCountPromise = collection.countDocuments({ 'queuedMessages.0': { $exists: true } });

  const [stageBuckets, activeCount, autopilotEnabled, needsReview, inFollowupSequence] =
    await Promise.all([
      stageBucketsPromise,
      activeCountPromise,
      autopilotEnabledPromise,
      flaggedCountPromise,
      followupCountPromise
    ]);

  const funnel = buildEmptyFunnelMetrics();

  stageBuckets.forEach(({ _id: stageValue, count }) => {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }

    const canonicalStage = canonicalStageKey(stageValue) || 'responded';

    if (isFlagStageValue(canonicalStage)) {
      return;
    }

    switch (canonicalStage) {
      case 'lead':
        funnel.lead += count;
        break;
      case 'qualified':
        funnel.qualified += count;
        break;
      case 'booking-sent':
        funnel.bookingSent += count;
        break;
      case 'call-booked':
        funnel.callBooked += count;
        break;
      case 'sale':
      case 'sales':
        funnel.sale += count;
        break;
      case 'responded':
        funnel.responded += count;
        break;
      default:
        funnel.responded += count;
    }
  });

  if (funnel.responded === 0 && activeCount > 0) {
    funnel.responded = activeCount;
  }

  return {
    stats: {
      ongoingChats: activeCount,
      autopilotEnabled,
      needsReview,
      inFollowupSequence
    },
    funnel
  };
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
  getConversationDetail,
  getConversationAutopilotStatus,
  setConversationAutopilotStatus,
  enqueueConversationMessage,
  removeQueuedConversationMessage,
  getQueuedConversationMessages,
  clearQueuedConversationMessages,
  popQueuedConversationMessage,
  restoreQueuedConversationMessage,
  clearConversationFlag,
  getConversationMetricsSummary
};
