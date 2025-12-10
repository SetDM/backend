const express = require('express');
const requirePromptAdmin = require('../middleware/prompt-admin-auth');
const { requireSession } = require('../middleware/session-auth');
const {
  getSystemPrompt,
  updateSystemPrompt,
  getUserPrompt,
  updateUserPrompt,
  testUserPrompt
} = require('../controllers/prompt.controller');

const router = express.Router();

router.get('/prompts/system', requirePromptAdmin, getSystemPrompt);
router.put('/prompts/system', requirePromptAdmin, updateSystemPrompt);
router.get('/prompts/user', requireSession, getUserPrompt);
router.put('/prompts/user', requireSession, updateUserPrompt);
router.post('/prompts/user/test', requireSession, testUserPrompt);

module.exports = router;
