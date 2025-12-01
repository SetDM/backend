const config = require('../config/environment');
const logger = require('../utils/logger');
const { getInstagramUserById } = require('../services/instagram-user.service');
const { sendInstagramTextMessage } = require('../services/instagram-messaging.service');
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
  if (!payload || !Array.isArray(payload.entry)) {
    return [];
  }

  return payload.entry.flatMap((entry) => {
    if (!Array.isArray(entry.messaging)) {
      return [];
    }

    return entry.messaging.filter((event) => Boolean(event && event.message));
  });
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
  res.sendStatus(200);

  const messagePayloads = extractMessagePayloads(req.body);
  console.log(messagePayloads)
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

module.exports = {
  verifyInstagramWebhook,
  handleInstagramWebhook
};
