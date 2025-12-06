const express = require('express');
const { requireSession } = require('../middleware/session-auth');
const {
	getAllConversations,
	updateConversationAutopilot,
	sendConversationMessage
} = require('../controllers/conversation.controller');

const router = express.Router();

router.get('/conversations', requireSession, getAllConversations);
router.patch('/conversations/:conversationId/autopilot', requireSession, updateConversationAutopilot);
router.post('/conversations/:conversationId/messages', requireSession, sendConversationMessage);

module.exports = router;
