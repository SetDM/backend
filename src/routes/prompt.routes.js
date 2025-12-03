const express = require('express');
const requirePromptAdmin = require('../middleware/prompt-admin-auth');
const {
  getSystemPrompt,
  updateSystemPrompt
} = require('../controllers/prompt.controller');

const router = express.Router();

router.get('/prompts/system', requirePromptAdmin, getSystemPrompt);
router.put('/prompts/system', requirePromptAdmin, updateSystemPrompt);

module.exports = router;
