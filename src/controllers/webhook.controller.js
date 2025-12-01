const config = require('../config/environment');
const logger = require('../utils/logger');
const { getInstagramUserById } = require('../services/instagram-user.service');
const { sendInstagramTextMessage } = require('../services/instagram-messaging.service');
const receivedUpdates = [];
const AUTO_REPLY_TEXT = 'Hello testing';

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
  const messages = [];

  if (!payload) {
    return messages;
  }

  if (payload.field === 'messages' && payload.value) {
    messages.push(payload.value);
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  entries.forEach((entry) => {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    changes.forEach((change) => {
      if (change.field === 'messages' && change.value) {
        messages.push(change.value);
      }
    });
  });

  return messages;
};

const processMessagePayload = async (messagePayload) => {
  const senderId = messagePayload?.sender?.id;
  const businessAccountId = messagePayload?.recipient?.id;

  if (!senderId || !businessAccountId) {
    return;
  }

  if (senderId === businessAccountId) {
    return; // avoid replying to our own messages
  }

  const businessAccount = await getInstagramUserById(businessAccountId);

  if (!businessAccount || !businessAccount.tokens?.longLived?.accessToken) {
    logger.warn('No stored long-lived token for Instagram account', { businessAccountId });
    return;
  }

  try {
    await sendInstagramTextMessage({
      instagramBusinessId: businessAccount.instagramId,
      recipientUserId: senderId,
      text: AUTO_REPLY_TEXT,
      accessToken: businessAccount.tokens.longLived.accessToken
    });
    logger.info('Auto reply sent to Instagram user', { senderId });
  } catch (error) {
    logger.error('Failed to send auto reply', { senderId, error: error.message });
  }
};

const handleInstagramWebhook = (req, res) => {
  logger.info('Instagram request body:', req.body);
  receivedUpdates.unshift(req.body);
  res.sendStatus(200);

  const messagePayloads = extractMessagePayloads(req.body);
  if (!messagePayloads.length) {
    return;
  }

  Promise.allSettled(messagePayloads.map(processMessagePayload)).then((results) => {
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      logger.warn('Some Instagram auto replies failed', { count: failures.length });
    }
  });
};

const listInstagramWebhookEvents = (req, res) => {
  res.send(`<pre>${JSON.stringify(receivedUpdates, null, 2)}</pre>`);
};

module.exports = {
  verifyInstagramWebhook,
  handleInstagramWebhook,
  listInstagramWebhookEvents
};
