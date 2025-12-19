const express = require('express');
const {
  verifyInstagramWebhook,
  handleInstagramWebhook
} = require('../controllers/webhook.controller');
const { validateWebhookSignature } = require('../middleware/webhook-signature');

const router = express.Router();

// GET - Webhook verification (no signature validation needed)
router.get('/webhooks/instagram', verifyInstagramWebhook);

// POST - Incoming webhook events (validate signature to prevent spoofing)
router.post('/webhooks/instagram', validateWebhookSignature, handleInstagramWebhook);

module.exports = router;
