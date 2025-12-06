const logger = require('../utils/logger');
const {
  listConversations,
  setConversationAutopilotStatus
} = require('../services/conversation.service');
const { getInstagramUserById } = require('../services/instagram-user.service');
const { processPendingMessagesWithAI } = require('../services/ai-response.service');

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

const parseConversationIdentifier = (conversationId) => {
  if (typeof conversationId !== 'string') {
    return null;
  }

  const separatorIndex = conversationId.indexOf('_');
  if (separatorIndex === -1) {
    return null;
  }

  const recipientId = conversationId.slice(0, separatorIndex).trim();
  const senderId = conversationId.slice(separatorIndex + 1).trim();

  if (!recipientId || !senderId) {
    return null;
  }

  return { recipientId, senderId };
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

const updateConversationAutopilot = async (req, res, next) => {
  const { conversationId } = req.params;
  const { enabled } = req.body || {};

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ message: 'enabled must be a boolean' });
  }

  const identifiers = parseConversationIdentifier(conversationId);
  if (!identifiers) {
    return res.status(400).json({ message: 'conversationId must follow recipient_sender format' });
  }

  try {
    await setConversationAutopilotStatus(identifiers.senderId, identifiers.recipientId, enabled);

    if (enabled) {
      const businessAccount = await getInstagramUserById(identifiers.recipientId);

      if (businessAccount?.tokens?.longLived?.accessToken) {
        const calendlyLink =
          businessAccount?.settings?.calendlyLink || businessAccount?.calendlyLink || null;

        processPendingMessagesWithAI({
          senderId: identifiers.senderId,
          businessAccountId: identifiers.recipientId,
          businessAccount,
          forceProcessPending: true,
          calendlyLink
        }).catch((error) => {
          logger.error('Failed to trigger AI response after enabling autopilot', {
            conversationId,
            error: error.message
          });
        });
      } else {
        logger.warn('Autopilot enabled but missing Instagram access token; skipping AI trigger', {
          conversationId
        });
      }
    }

    return res.json({
      conversationId,
      isAutopilotOn: enabled
    });
  } catch (error) {
    logger.error('Failed to update conversation autopilot status', {
      conversationId,
      error: error.message
    });
    return next(error);
  }
};

module.exports = {
  getAllConversations,
  updateConversationAutopilot
};
