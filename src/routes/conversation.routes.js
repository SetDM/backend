const express = require('express');
const { requireSession } = require('../middleware/session-auth');
const {
	getAllConversations,
	getConversationDetailById,
	updateConversationAutopilot,
	sendConversationMessage,
	getConversationSummaryNotes,
	cancelQueuedConversationMessage,
	sendQueuedConversationMessageNow,
	removeConversationFlag
} = require('../controllers/conversation.controller');

const router = express.Router();

router.get('/conversations', requireSession, getAllConversations);
router.get('/conversations/:conversationId', requireSession, getConversationDetailById);
router.patch('/conversations/:conversationId/autopilot', requireSession, updateConversationAutopilot);
router.post('/conversations/:conversationId/messages', requireSession, sendConversationMessage);
router.get('/conversations/:conversationId/notes', requireSession, getConversationSummaryNotes);
router.post(
	'/conversations/:conversationId/queue/:queuedMessageId/send-now',
	requireSession,
	sendQueuedConversationMessageNow
);
router.delete(
	'/conversations/:conversationId/queue/:queuedMessageId',
	requireSession,
	cancelQueuedConversationMessage
);
router.delete('/conversations/:conversationId/flag', requireSession, removeConversationFlag);

module.exports = router;
