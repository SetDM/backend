const config = require('../config/environment');
const logger = require('../utils/logger');
const { getInstagramUserById } = require('../services/instagram-user.service');
const { sendInstagramTextMessage } = require('../services/instagram-messaging.service');
const {
  storeMessage,
  conversationExists,
  seedConversationHistory,
  getConversationFlagStatus,
  getConversationAutopilotStatus
} = require('../services/conversation.service');
const {
  getConversationIdForUser,
  getConversationMessages
} = require('../services/instagram.service');
const { ensureInstagramUserProfile } = require('../services/user.service');
const {
  processPendingMessagesWithAI
} = require('../services/ai-response.service');


const parseInstagramTimestamp = (value) => {
  if (!value) {
    return new Date();
  }

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) {
    if (asNumber < 1e12) {
      return new Date(asNumber * 1000);
    }
    return new Date(asNumber);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const mapInstagramMessagesToHistoryEntries = ({
  messages = [],
  senderId,
  conversationId
}) =>
  messages
    .map((msg) => {
      const text = msg?.text || msg?.message || msg?.messages?.text;

      if (!text) {
        return null;
      }

      const role = msg?.from?.id === senderId ? 'user' : 'assistant';

      return {
        role,
        content: text,
        timestamp: parseInstagramTimestamp(msg?.created_time),
        metadata: {
          mid: msg?.id,
          instagramMessageId: msg?.id,
          instagramConversationId: conversationId
        }
      };
    })
    .filter(Boolean);

const ensureConversationHistorySeeded = async ({
  senderId,
  businessAccountId,
  accessToken
}) => {
  const exists = await conversationExists(senderId, businessAccountId);
  if (exists) {
    return;
  }

  try {
    const conversationId = await getConversationIdForUser({
      instagramBusinessId: businessAccountId,
      userId: senderId,
      accessToken
    });

    if (!conversationId) {
      logger.info('No existing Instagram conversation found for user; starting fresh', {
        senderId,
        businessAccountId
      });
      return;
    }

    const remoteMessages = await getConversationMessages({
      conversationId,
      accessToken
    });

    const formattedMessages = mapInstagramMessagesToHistoryEntries({
      messages: remoteMessages,
      senderId,
      conversationId
    });

    if (!formattedMessages.length) {
      logger.info('Remote conversation contained no textual messages to backfill', {
        senderId,
        businessAccountId,
        conversationId
      });
      return;
    }

    await seedConversationHistory(senderId, businessAccountId, formattedMessages);
  } catch (error) {
    logger.error('Failed to backfill Instagram conversation history', {
      senderId,
      businessAccountId,
      error: error.message
    });
  }
};

const verifyInstagramWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = config.instagram.webhookVerifyToken || process.env.TOKEN || 'token';

  if (mode === 'subscribe' && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(400);
};

const extractMessagePayloads = (payload) => {
  if (!payload || !Array.isArray(payload.entry) || payload.entry.length === 0) {
    return [];
  }

  const events = [];

  payload.entry.forEach((entry) => {
    const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];

    messagingEvents.forEach((event) => {
      if (event && !event.read) {
        events.push(event)
      }
    });
  });

  return events;
};

const processMessagePayload = async (messagePayload) => {
  const senderId = messagePayload?.sender?.id;
  const businessAccountId = messagePayload?.recipient?.id;
  const messageText = messagePayload?.message?.text;
  const isEcho = messagePayload?.message?.is_echo;

  // console.log("Payload", messagePayload)

  if (isEcho) {
    logger.debug('Ignoring echo message (already sent by business account)', {
      senderId,
      businessAccountId
    });
    return;
  }

  // Only process text messages
  if (!messageText) {
    logger.debug('Ignoring non-text message', { senderId });
    return;
  }

  const businessAccount = await getInstagramUserById(businessAccountId);
  const calendlyLink =
    businessAccount?.settings?.calendlyLink || businessAccount?.calendlyLink || null;

  if (!senderId || !businessAccountId) {
    logger.warn('Invalid message payload: missing sender or recipient ID');
    return;
  }

  if (senderId === businessAccountId) {
    logger.debug('Ignoring message from self', { senderId });
    return;
  }

  try {
    const isFlagged = await getConversationFlagStatus(senderId, businessAccountId);
    if (isFlagged) {
      logger.info('Ignoring message because conversation is flagged', {
        senderId,
        businessAccountId
      });
      return;
    }
  } catch (stageLookupError) {
    logger.error('Failed to check conversation stage tag before processing', {
      senderId,
      businessAccountId,
      error: stageLookupError.message
    });
  }

  if (!businessAccount || !businessAccount.tokens?.longLived?.accessToken) {
    logger.warn('No stored long-lived token for Instagram account', { businessAccountId });
    return;
  }

  try {
    await ensureInstagramUserProfile({
      instagramId: senderId,
      accessToken: businessAccount.tokens.longLived.accessToken
    });
  } catch (profileError) {
    logger.error('Failed to sync Instagram user profile', {
      senderId,
      error: profileError.message
    });
  }

  try {
    await ensureConversationHistorySeeded({
      senderId,
      businessAccountId,
      accessToken: businessAccount.tokens.longLived.accessToken
    });

    // Store user message in conversation history
    await storeMessage(senderId, businessAccountId, messageText, 'user', {
      mid: messagePayload?.message?.mid
    });

    const incomingMessageMid = messagePayload?.message?.mid || null;

    let autopilotEnabled = true;
    try {
      autopilotEnabled = await getConversationAutopilotStatus(senderId, businessAccountId);
    } catch (autopilotError) {
      logger.error('Failed to determine autopilot status; defaulting to enabled', {
        senderId,
        businessAccountId,
        error: autopilotError.message
      });
    }

    if (!autopilotEnabled) {
      logger.info('Autopilot disabled for conversation; stored user message only', {
        senderId,
        businessAccountId
      });
      return;
    }

    await processPendingMessagesWithAI({
      senderId,
      businessAccountId,
      businessAccount,
      incomingMessageMid,
      calendlyLink
    });
  } catch (error) {
    logger.error('Failed to process message with AI', {
      senderId,
      error: error.message
    });

    // Send a fallback message in case of error
    try {
      await sendInstagramTextMessage({
        instagramBusinessId: businessAccount.instagramId,
        recipientUserId: senderId,
        text: 'Sorry, I encountered an issue processing your message. Please try again later.',
        accessToken: businessAccount.tokens.longLived.accessToken
      });
    } catch (fallbackError) {
      logger.error('Failed to send fallback error message', {
        senderId,
        error: fallbackError.message
      });
    }
  }
};

const handleInstagramWebhook = (req, res) => {
  logger.info('Instagram request body:', req.body);
  res.sendStatus(200);

  const messagePayloads = extractMessagePayloads(req.body);
  if (!messagePayloads.length) {
    logger.debug('No message payloads found in webhook body.');
    return;
  }

  messagePayloads.forEach((payload) => {
    processMessagePayload(payload).catch((error) => {
      logger.error('Error processing Instagram message payload', { error: error.message });
    });
  });
};

module.exports = {
  verifyInstagramWebhook,
  handleInstagramWebhook
};
