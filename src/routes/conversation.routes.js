const express = require('express');
const { requireSession } = require('../middleware/session-auth');
const { requireEditPermission } = require('../middleware/permissions');
const {
	getAllConversations,
	getConversationMetrics,
	getConversationDetailById,
	updateConversationAutopilot,
	sendConversationMessage,
	getConversationSummaryNotes,
	cancelQueuedConversationMessage,
	sendQueuedConversationMessageNow,
	removeConversationFlag
} = require('../controllers/conversation.controller');

const router = express.Router();

// View operations - all authenticated users
router.get('/conversations', requireSession, getAllConversations);
router.get('/conversations/metrics', requireSession, getConversationMetrics);
router.get('/conversations/:conversationId', requireSession, getConversationDetailById);
router.get('/conversations/:conversationId/notes', requireSession, getConversationSummaryNotes);

// Edit operations - require edit permission (admin, editor, owner)
router.patch('/conversations/:conversationId/autopilot', requireSession, requireEditPermission, updateConversationAutopilot);
router.post('/conversations/:conversationId/messages', requireSession, requireEditPermission, sendConversationMessage);
router.post(
	'/conversations/:conversationId/queue/:queuedMessageId/send-now',
	requireSession,
	requireEditPermission,
	sendQueuedConversationMessageNow
);
router.delete(
	'/conversations/:conversationId/queue/:queuedMessageId',
	requireSession,
	requireEditPermission,
	cancelQueuedConversationMessage
);
router.delete('/conversations/:conversationId/flag', requireSession, requireEditPermission, removeConversationFlag);

module.exports = router;
