const logger = require('../utils/logger');
const { listConversations } = require('../services/conversation.service');

const normalizeLimit = (limit) => {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 100;
  }

  return Math.min(Math.max(Math.floor(numeric), 1), 500);
};

const normalizeConversationResponse = (conversation = {}) => {
  const { _id, ...rest } = conversation;
  let id = rest?.conversationId || null;

  if (_id && typeof _id === 'object') {
    if (typeof _id.toHexString === 'function') {
      id = _id.toHexString();
    } else if (typeof _id.toString === 'function') {
      id = _id.toString();
    }
  }

  if (!id) {
    id = `${rest?.senderId || 'unknown'}_${rest?.recipientId || 'unknown'}`;
  }

  return {
    id,
    ...rest
  };
};

const getAllConversations = async (req, res, next) => {
  try {
    const limit = normalizeLimit(req.query.limit);
    const stage = typeof req.query.stage === 'string' ? req.query.stage.trim() : undefined;

    const conversations = await listConversations({ limit, stageTag: stage });
    const data = conversations.map((conversation) => normalizeConversationResponse(conversation));

    return res.json({ data });
  } catch (error) {
    logger.error('Failed to fetch conversations', { error: error.message });
    return next(error);
  }
};

module.exports = {
  getAllConversations
};
