const express = require('express');
const { requireSession } = require('../middleware/session-auth');
const {
	getAllConversations,
	updateConversationAutopilot
} = require('../controllers/conversation.controller');

const router = express.Router();

router.get('/conversations', requireSession, getAllConversations);
router.patch('/conversations/:conversationId/autopilot', requireSession, updateConversationAutopilot);

module.exports = router;
