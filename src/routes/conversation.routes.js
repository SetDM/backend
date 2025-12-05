const express = require('express');
const { requireSession } = require('../middleware/session-auth');
const { getAllConversations } = require('../controllers/conversation.controller');

const router = express.Router();

router.get('/conversations', requireSession, getAllConversations);

module.exports = router;
