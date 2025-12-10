const logger = require('../utils/logger');
const {
  getPromptByName,
  upsertPrompt,
  upsertPromptSections,
  DEFAULT_PROMPT_NAME,
  USER_PROMPT_NAME,
  extractPromptSections,
  mergeSectionsWithDefaults,
  buildPromptFromSections,
  sanitizeSections
} = require('../services/prompt.service');
const { resetSystemPromptCache, resetUserPromptCache } = require('../services/chatgpt.service');

const getSystemPrompt = async (req, res, next) => {
  try {
    const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

    if (!promptDoc?.content) {
      return res.status(404).json({ message: 'Prompt not found' });
    }

    return res.json({
      name: promptDoc.name,
      content: promptDoc.content,
      sections: extractPromptSections(promptDoc.content),
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
    resetUserPromptCache();

    return res.json({ message: 'Prompt updated successfully' });
  } catch (error) {
    logger.error('Failed to update system prompt', { error: error.message });
    return next(error);
  }
};

const getUserPrompt = async (req, res, next) => {
  try {
    const systemPromptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);
    const baseSections = extractPromptSections(systemPromptDoc?.content || '');
    const userPromptDoc = await getPromptByName(USER_PROMPT_NAME);
    const overrideSections = userPromptDoc?.sections || {};
    const mergedSections = mergeSectionsWithDefaults({
      base: baseSections,
      overrides: overrideSections
    });

    return res.json({
      sections: mergedSections,
      overrides: overrideSections,
      content: buildPromptFromSections(mergedSections),
      updatedAt: userPromptDoc?.updatedAt,
      createdAt: userPromptDoc?.createdAt
    });
  } catch (error) {
    logger.error('Failed to fetch user prompt', { error: error.message });
    return next(error);
  }
};

const updateUserPrompt = async (req, res, next) => {
  try {
    const { sections } = req.body || {};

    if (!sections || typeof sections !== 'object') {
      return res.status(400).json({ message: 'sections object is required.' });
    }

    const sanitizedSections = sanitizeSections(sections);

    if (!Object.keys(sanitizedSections).length) {
      return res.status(400).json({ message: 'Provide at least one section to update.' });
    }

    const savedSections = await upsertPromptSections({
      name: USER_PROMPT_NAME,
      sections: sanitizedSections
    });

    resetUserPromptCache();

    const mergedSections = mergeSectionsWithDefaults({ overrides: savedSections });

    return res.json({
      message: 'User prompt updated successfully',
      sections: mergedSections,
      overrides: savedSections,
      content: buildPromptFromSections(mergedSections)
    });
  } catch (error) {
    logger.error('Failed to update user prompt', { error: error.message });
    return next(error);
  }
};

module.exports = {
  getSystemPrompt,
  updateSystemPrompt,
  getUserPrompt,
  updateUserPrompt
};
