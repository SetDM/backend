const logger = require('../utils/logger');
const {
  listConversations,
  setConversationAutopilotStatus,
  storeMessage,
  getConversationStageTag,
  removeQueuedConversationMessage,
  popQueuedConversationMessage,
  restoreQueuedConversationMessage,
  clearConversationFlag
} = require('../services/conversation.service');
const { getInstagramUserById } = require('../services/instagram-user.service');
const { processPendingMessagesWithAI } = require('../services/ai-response.service');
const { sendInstagramTextMessage } = require('../services/instagram-messaging.service');
const { getConversationNotes } = require('../services/conversation-summary.service');

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

  const queuedMessages = Array.isArray(rest?.queuedMessages) ? rest.queuedMessages : [];
  const isFlagged = Boolean(rest?.isFlagged);

  return {
    id,
    ...rest,
    queuedMessages,
    isFlagged
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
          forceQueuePreview: true,
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
    if (error?.code === 'FLAGGED_CONVERSATION_NOT_ALLOWED') {
      return res.status(409).json({
        message: 'Cannot enable autopilot while conversation is flagged'
      });
    }
    logger.error('Failed to update conversation autopilot status', {
      conversationId,
      error: error.message
    });
    return next(error);
  }
};

const sendConversationMessage = async (req, res, next) => {
  const { conversationId } = req.params;
  const { message } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ message: 'message is required and must be a string' });
  }

  const identifiers = parseConversationIdentifier(conversationId);
  if (!identifiers) {
    return res.status(400).json({ message: 'conversationId must follow recipient_sender format' });
  }

  const trimmedMessage = message.trim();

  try {
    const businessAccount = await getInstagramUserById(identifiers.recipientId);

    if (!businessAccount) {
      return res.status(404).json({ message: 'Instagram business account not found' });
    }

    const accessToken = businessAccount?.tokens?.longLived?.accessToken;
    if (!accessToken) {
      return res.status(400).json({ message: 'Business account is missing a valid access token' });
    }

    const sendResult = await sendInstagramTextMessage({
      instagramBusinessId: businessAccount.instagramId,
      recipientUserId: identifiers.senderId,
      text: trimmedMessage,
      accessToken
    });

    const instagramMessageId =
      typeof sendResult?.id === 'string' && sendResult.id.length > 0 ? sendResult.id : null;
    const messageMetadata = {
      source: 'operator'
    };
    if (instagramMessageId) {
      messageMetadata.instagramMessageId = instagramMessageId;
      messageMetadata.mid = instagramMessageId;
    }

    await storeMessage(
      identifiers.senderId,
      identifiers.recipientId,
      trimmedMessage,
      'assistant',
      messageMetadata,
      { isAiGenerated: false }
    );

    const responseTimestamp = new Date().toISOString();
    const stageTag = await getConversationStageTag(identifiers.senderId, identifiers.recipientId);

    return res.status(200).json({
      conversationId,
      message: {
        id: instagramMessageId,
        content: trimmedMessage,
        role: 'assistant',
        timestamp: responseTimestamp,
        metadata: messageMetadata,
        stageTag: stageTag || null
      }
    });
  } catch (error) {
    logger.error('Failed to send manual conversation message', {
      conversationId,
      error: error.message
    });
    return next(error);
  }
};

const getConversationSummaryNotes = async (req, res, next) => {
  const { conversationId } = req.params;

  const identifiers = parseConversationIdentifier(conversationId);
  if (!identifiers) {
    return res.status(400).json({ message: 'conversationId must follow recipient_sender format' });
  }

  try {
    const notes = await getConversationNotes({
      senderId: identifiers.senderId,
      recipientId: identifiers.recipientId
    });

    return res.json({
      data: {
        conversationId,
        notes
      }
    });
  } catch (error) {
    logger.error('Failed to generate conversation notes', {
      conversationId,
      error: error.message
    });
    return next(error);
  }
};

const cancelQueuedConversationMessage = async (req, res, next) => {
  const { conversationId, queuedMessageId } = req.params;

  if (!queuedMessageId) {
    return res.status(400).json({ message: 'queuedMessageId is required' });
  }

  const identifiers = parseConversationIdentifier(conversationId);
  if (!identifiers) {
    return res.status(400).json({ message: 'conversationId must follow recipient_sender format' });
  }

  try {
    const removed = await removeQueuedConversationMessage({
      senderId: identifiers.senderId,
      recipientId: identifiers.recipientId,
      queuedMessageId
    });

    if (!removed) {
      return res.status(404).json({ message: 'Queued message not found' });
    }

    return res.json({
      conversationId,
      queuedMessageId
    });
  } catch (error) {
    logger.error('Failed to cancel queued conversation message', {
      conversationId,
      queuedMessageId,
      error: error.message
    });
    return next(error);
  }
};

const sendQueuedConversationMessageNow = async (req, res, next) => {
  const { conversationId, queuedMessageId } = req.params;

  if (!queuedMessageId) {
    return res.status(400).json({ message: 'queuedMessageId is required' });
  }

  const identifiers = parseConversationIdentifier(conversationId);
  if (!identifiers) {
    return res.status(400).json({ message: 'conversationId must follow recipient_sender format' });
  }

  let poppedQueuedEntry = null;

  try {
    poppedQueuedEntry = await popQueuedConversationMessage({
      senderId: identifiers.senderId,
      recipientId: identifiers.recipientId,
      queuedMessageId
    });

    if (!poppedQueuedEntry || !poppedQueuedEntry.content) {
      return res.status(404).json({ message: 'Queued message not found or already processed' });
    }

    const trimmedContent = poppedQueuedEntry.content.trim();
    if (!trimmedContent.length) {
      await restoreQueuedConversationMessage({
        senderId: identifiers.senderId,
        recipientId: identifiers.recipientId,
        entry: poppedQueuedEntry
      });
      return res.status(400).json({ message: 'Queued message content is empty' });
    }

    const businessAccount = await getInstagramUserById(identifiers.recipientId);
    const accessToken = businessAccount?.tokens?.longLived?.accessToken;

    if (!businessAccount || !accessToken) {
      await restoreQueuedConversationMessage({
        senderId: identifiers.senderId,
        recipientId: identifiers.recipientId,
        entry: poppedQueuedEntry
      });

      return res.status(400).json({ message: 'Business account is missing a valid access token' });
    }

    const sendResult = await sendInstagramTextMessage({
      instagramBusinessId: businessAccount.instagramId,
      recipientUserId: identifiers.senderId,
      text: trimmedContent,
      accessToken
    });

    const instagramMessageId =
      typeof sendResult?.id === 'string' && sendResult.id.length > 0 ? sendResult.id : null;
    const resolvedTimestamp = new Date().toISOString();

    const metadata = {
      source: 'autopilot',
      queuedMessageId
    };

    if (instagramMessageId) {
      metadata.instagramMessageId = instagramMessageId;
      metadata.mid = instagramMessageId;
    } else {
      metadata.mid = queuedMessageId;
    }

    await storeMessage(
      identifiers.senderId,
      identifiers.recipientId,
      trimmedContent,
      'assistant',
      metadata,
      { isAiGenerated: true }
    );

    const stageTag = await getConversationStageTag(identifiers.senderId, identifiers.recipientId);

    return res.json({
      conversationId,
      queuedMessageId,
      message: {
        id: instagramMessageId || queuedMessageId,
        content: trimmedContent,
        role: 'assistant',
        timestamp: resolvedTimestamp,
        metadata,
        isAiGenerated: true,
        stageTag: stageTag || null
      }
    });
  } catch (error) {
    if (poppedQueuedEntry) {
      try {
        await restoreQueuedConversationMessage({
          senderId: identifiers.senderId,
          recipientId: identifiers.recipientId,
          entry: poppedQueuedEntry
        });
      } catch (restoreError) {
        logger.error('Failed to restore queued message after send-now error', {
          conversationId,
          queuedMessageId,
          error: restoreError.message
        });
      }
    }

    logger.error('Failed to send queued conversation message immediately', {
      conversationId,
      queuedMessageId,
      error: error.message
    });
    return next(error);
  }
};

const removeConversationFlag = async (req, res, next) => {
  const { conversationId } = req.params;

  const identifiers = parseConversationIdentifier(conversationId);
  if (!identifiers) {
    return res.status(400).json({ message: 'conversationId must follow recipient_sender format' });
  }

  try {
    const cleared = await clearConversationFlag(identifiers.senderId, identifiers.recipientId);

    if (!cleared) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    return res.json({
      conversationId,
      isFlagged: false,
      stageTag: 'responded'
    });
  } catch (error) {
    logger.error('Failed to clear conversation flag', {
      conversationId,
      error: error.message
    });
    return next(error);
  }
};

module.exports = {
  getAllConversations,
  updateConversationAutopilot,
  sendConversationMessage,
  getConversationSummaryNotes,
  cancelQueuedConversationMessage,
  sendQueuedConversationMessageNow,
  removeConversationFlag
};
