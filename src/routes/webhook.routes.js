const express = require('express');
const {
  verifyInstagramWebhook,
  handleInstagramWebhook,
  listInstagramWebhookEvents
} = require('../controllers/webhook.controller');

const router = express.Router();

router.get('/webhooks/instagram', verifyInstagramWebhook);
router.post('/webhooks/instagram', handleInstagramWebhook);
router.get('/webhooks/instagram/updates', listInstagramWebhookEvents);

module.exports = router;
