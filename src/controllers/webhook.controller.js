const config = require('../config/environment');
const logger = require('../utils/logger');
const { getInstagramUserById } = require('../services/instagram-user.service');
const { sendInstagramTextMessage } = require('../services/instagram-messaging.service');
const { generateResponse } = require('../services/chatgpt.service');
const {
  storeMessage,
  getConversationHistory,
  formatForChatGPT
} = require('../services/conversation.service');
const { splitMessageByGaps } = require('../utils/message-utils');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getLastAssistantTimestamp = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant' && message.timestamp) {
      return new Date(message.timestamp);
    }
  }
  return null;
};

const shouldDelayReply = (lastAssistantTimestamp) => {
  const delayConfig = config.responses?.replyDelay;
  if (!delayConfig) {
    return false;
  }

  const { minMs, maxMs, skipIfLastReplyOlderThanMs } = delayConfig;
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= 0) {
    return false;
  }

  if (!lastAssistantTimestamp) {
    return true;
  }

  const elapsedMs = Date.now() - new Date(lastAssistantTimestamp).getTime();
  if (elapsedMs > skipIfLastReplyOlderThanMs) {
    return false;
  }

  return true;
};

const maybeDelayReply = async (lastAssistantTimestamp) => {
  if (!shouldDelayReply(lastAssistantTimestamp)) {
    return;
  }

  const { minMs, maxMs } = config.responses.replyDelay;
  const span = Math.max(0, maxMs - minMs);
  const delayMs = span === 0 ? maxMs : minMs + Math.floor(Math.random() * (span + 1));

  logger.info('Delaying AI response to simulate natural chat timing', { delayMs });
  await wait(delayMs);
};

const applyTemplateVariables = (text, replacements = {}, context = {}) => {
  if (!text || typeof text !== 'string') {
    return text;
  }

  return Object.entries(replacements).reduce((acc, [key, value]) => {
    const templateTokens = [`{{${key}}}`];

    if (key === 'CALENDLY_LINK') {
      templateTokens.push('[calendly link]', '[booking_link]');
    }

    return templateTokens.reduce((textAcc, token) => {
      if (!textAcc.includes(token)) {
        return textAcc;
      }

      const tokenRegex = new RegExp(escapeRegExp(token), 'g');

      if (!value) {
        logger.warn('Missing template variable replacement', {
          key,
          token,
          ...context
        });
        return textAcc.replace(tokenRegex, '').trim();
      }

      return textAcc.replace(tokenRegex, value);
    }, acc);
  }, text);
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

  if (!businessAccount || !businessAccount.tokens?.longLived?.accessToken) {
    logger.warn('No stored long-lived token for Instagram account', { businessAccountId });
    return;
  }

  try {
    // Store user message in conversation history
    await storeMessage(senderId, businessAccountId, messageText, 'user');

    // Retrieve conversation history
    const conversationHistory = await getConversationHistory(senderId, businessAccountId);
    const lastAssistantTimestamp = getLastAssistantTimestamp(conversationHistory);
    const formattedHistory = formatForChatGPT(conversationHistory);

    // Generate AI response using ChatGPT
    logger.info('Generating ChatGPT response', { senderId, messageLength: messageText.length });
    const rawAiResponse = await generateResponse(messageText, formattedHistory);
    const aiResponse = applyTemplateVariables(
      rawAiResponse,
      {
        CALENDLY_LINK: calendlyLink
      },
      { businessAccountId }
    );

    const messageParts = splitMessageByGaps(aiResponse);
    let partsToSend = messageParts.length ? messageParts : [aiResponse];

    const maxMessageParts = Math.max(1, Number(config.responses?.maxMessageParts) || 3);
    if (partsToSend.length > maxMessageParts) {
      const preserved = partsToSend.slice(0, maxMessageParts - 1);
      const mergedRemainder = partsToSend.slice(maxMessageParts - 1).join('\n\n').trim();
      partsToSend = mergedRemainder ? [...preserved, mergedRemainder] : preserved;
    }

    await maybeDelayReply(lastAssistantTimestamp);

    // Send the AI response via Instagram (respecting order)
    for (const part of partsToSend) {
      await sendInstagramTextMessage({
        instagramBusinessId: businessAccount.instagramId,
        recipientUserId: senderId,
        text: part,
        accessToken: businessAccount.tokens.longLived.accessToken
      });
    }

    try {
      await storeMessage(senderId, businessAccountId, aiResponse, 'assistant');
    } catch (storeAssistantError) {
      logger.error('Failed to persist AI assistant response after sending', {
        senderId,
        error: storeAssistantError.message
      });
    }

    logger.info('AI response sent to Instagram user', {
      senderId,
      responseLength: aiResponse.length,
      partsSent: partsToSend.length
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
