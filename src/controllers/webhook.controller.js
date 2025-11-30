const config = require('../config/environment');
const logger = require('../utils/logger');
const receivedUpdates = [];

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

const handleInstagramWebhook = (req, res) => {
  logger.info('Instagram request body:', req.body);
  receivedUpdates.unshift(req.body);
  res.sendStatus(200);
};

const listInstagramWebhookEvents = (req, res) => {
  res.send(`<pre>${JSON.stringify(receivedUpdates, null, 2)}</pre>`);
};

module.exports = {
  verifyInstagramWebhook,
  handleInstagramWebhook,
  listInstagramWebhookEvents
};
