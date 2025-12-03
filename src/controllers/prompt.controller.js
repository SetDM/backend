const logger = require('../utils/logger');
const {
  getPromptByName,
  upsertPrompt,
  DEFAULT_PROMPT_NAME
} = require('../services/prompt.service');
const { resetSystemPromptCache } = require('../services/chatgpt.service');

const getSystemPrompt = async (req, res, next) => {
  try {
    const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

    if (!promptDoc?.content) {
      return res.status(404).json({ message: 'Prompt not found' });
    }

    return res.json({
      name: promptDoc.name,
      content: promptDoc.content,
      updatedAt: promptDoc.updatedAt,
      createdAt: promptDoc.createdAt
    });
  } catch (error) {
    logger.error('Failed to fetch system prompt', { error: error.message });
    return next(error);
  }
};

const updateSystemPrompt = async (req, res, next) => {
  try {
    const { content } = req.body || {};

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ message: 'content is required and must be a string' });
    }

    await upsertPrompt({ name: DEFAULT_PROMPT_NAME, content });
    resetSystemPromptCache();

    return res.json({ message: 'Prompt updated successfully' });
  } catch (error) {
    logger.error('Failed to update system prompt', { error: error.message });
    return next(error);
  }
};

module.exports = {
  getSystemPrompt,
  updateSystemPrompt
};
