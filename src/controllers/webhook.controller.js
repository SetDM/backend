const crypto = require('crypto');

const config = require('../config/environment');
const logger = require('../utils/logger');
const { appendEntry } = require('../utils/conversation-store');
const { sendDirectMessage } = require('../services/instagram.service');

const verifyInstagramWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.instagram.webhookVerifyToken) {
    return res.status(200).send(challenge);
  }

  return res.status(403).json({ message: 'Verification failed' });
};

const extractMessages = (body) => {
  const entries = body.entry || [];
  const messages = [];

  entries.forEach((entry) => {
    (entry.changes || []).forEach((change) => {
      const value = change.value || {};
      if (Array.isArray(value.messages)) {
        value.messages.forEach((message) => messages.push(message));
      }
      if (Array.isArray(value.messaging)) {
        value.messaging.forEach((message) => messages.push(message.message || message));
      }
    });
  });

  return messages;
};

const isValidSignature = (req) => {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !config.instagram.appSecret) {
    return false;
  }

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', config.instagram.appSecret)
    .update(rawBody)
    .digest('hex')}`;

  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
};

const getSenderId = (message) => {
  if (!message) {
    return null;
  }

  if (typeof message.from === 'string') {
    return message.from;
  }

  if (message.from && message.from.id) {
    return message.from.id;
  }

  if (message.sender && message.sender.id) {
    return message.sender.id;
  }

  return null;
};

const getInboundText = (message) =>
  message?.text || message?.body || message?.message?.text || '';

const handleInstagramWebhook = async (req, res, next) => {
  try {
    if (req.body.object !== 'instagram') {
      return res.status(404).json({ message: 'Event ignored' });
    }

    if (!isValidSignature(req)) {
      return res.status(403).json({ message: 'Invalid signature' });
    }

    if (!config.instagram.defaultLongLivedToken) {
      const error = new Error('INSTAGRAM_LONG_LIVED_TOKEN is not configured');
      error.statusCode = 500;
      throw error;
    }

    const messages = extractMessages(req.body);
    if (!messages.length) {
      return res.status(202).json({ message: 'No actionable messages' });
    }

    const sendOperations = messages
      .map((message) => ({
        message,
        recipientId: getSenderId(message)
      }))
      .filter(({ recipientId }) => Boolean(recipientId))
      .map(async ({ message, recipientId }) => {
        const inboundText = getInboundText(message);
        const logBase = {
          recipientId,
          inboundMessageId: message.id || message.mid || null,
          inboundText
        };
        try {
          await sendDirectMessage({
            recipientId,
            message: 'Hello Testing',
            accessToken: config.instagram.defaultLongLivedToken
          });
          logger.info(`Auto-replied to Instagram user ${recipientId}`);
          appendEntry({ ...logBase, status: 'sent' });
        } catch (error) {
          logger.error(`Failed to auto-reply to ${recipientId}`, error);
          appendEntry({ ...logBase, status: 'failed', error: error.message });
        }
      });

    await Promise.all(sendOperations);

    return res.status(200).json({ status: 'processed' });
  } catch (error) {
    logger.error('Error handling Instagram webhook', error);
    next(error);
  }
};

module.exports = {
  verifyInstagramWebhook,
  handleInstagramWebhook
};
