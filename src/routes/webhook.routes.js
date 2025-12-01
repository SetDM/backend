const express = require('express');
const {
  verifyInstagramWebhook,
  handleInstagramWebhook
} = require('../controllers/webhook.controller');

const router = express.Router();

router.get('/webhooks/instagram', verifyInstagramWebhook);
router.post('/webhooks/instagram', handleInstagramWebhook);

module.exports = router;
