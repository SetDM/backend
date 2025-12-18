const logger = require('../utils/logger');
const {
  getPromptByName,
  upsertPrompt,
  upsertPromptSections,
  upsertPromptConfig,
  DEFAULT_PROMPT_NAME,
  USER_PROMPT_NAME,
  DEFAULT_CONFIG,
  extractPromptSections,
  mergeSectionsWithDefaults,
  mergeConfigWithDefaults,
  buildPromptFromSections,
  buildPromptFromConfig,
  sanitizeSections,
  sanitizeConfig
} = require('../services/prompt.service');
const {
  resetSystemPromptCache,
  resetUserPromptCache,
  generateResponse
} = require('../services/chatgpt.service');
const { stripTrailingStageTag } = require('../utils/message-utils');

const normalizeHistory = (historyInput = []) => {
  if (!Array.isArray(historyInput)) {
    return [];
  }

  return historyInput
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null;
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';

      if (!role || !content) {
        return null;
      }

      return { role, content };
    })
    .filter(Boolean);
};

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
    const userPromptDoc = await getPromptByName(USER_PROMPT_NAME);

    // Check if we have the new config structure
    if (userPromptDoc?.config) {
      const mergedConfig = mergeConfigWithDefaults(userPromptDoc.config);
      return res.json({
        config: mergedConfig,
        content: buildPromptFromConfig(mergedConfig),
        updatedAt: userPromptDoc.updatedAt,
        createdAt: userPromptDoc.createdAt
      });
    }

    // Legacy fallback: use sections structure
    const systemPromptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);
    const baseSections = extractPromptSections(systemPromptDoc?.content || '');
    const overrideSections = userPromptDoc?.sections || {};
    const mergedSections = mergeSectionsWithDefaults({
      base: baseSections,
      overrides: overrideSections
    });

    // Convert legacy sections to config format for frontend compatibility
    const legacyConfig = {
      ...DEFAULT_CONFIG,
      coachName: mergedSections.coachName,
      sequences: {
        ...DEFAULT_CONFIG.sequences,
        lead: { script: mergedSections.leadSequence || '', followups: [] },
        qualification: { script: mergedSections.qualificationSequence || '', followups: [] },
        booking: { script: mergedSections.bookingSequence || '', followups: [] }
      }
    };

    return res.json({
      config: legacyConfig,
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
    const { config, sections } = req.body || {};

    // Handle new config structure (from frontend)
    if (config && typeof config === 'object') {
      const sanitizedConfig = sanitizeConfig(config);
      const savedConfig = await upsertPromptConfig({
        name: USER_PROMPT_NAME,
        config: sanitizedConfig
      });

      resetUserPromptCache();

      const mergedConfig = mergeConfigWithDefaults(savedConfig);

      return res.json({
        message: 'Prompt configuration updated successfully',
        config: mergedConfig,
        content: buildPromptFromConfig(mergedConfig)
      });
    }

    // Legacy fallback: handle sections structure
    if (!sections || typeof sections !== 'object') {
      return res.status(400).json({ message: 'config or sections object is required.' });
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

const testUserPrompt = async (req, res, next) => {
  try {
    const { message, history, config, sections, stageTag } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'message field is required for testing.' });
    }

    const sanitizedHistory = normalizeHistory(history);

    const options = {};

    if (typeof stageTag === 'string' && stageTag.trim().length) {
      options.stageTag = stageTag.trim();
    }

    // Handle new config structure
    if (config && typeof config === 'object') {
      options.userPromptText = buildPromptFromConfig(config) || '';
    }
    // Legacy fallback: handle sections structure
    else if (sections && typeof sections === 'object') {
      options.userPromptText = buildPromptFromSections(sections) || '';
    }

    const rawReply = await generateResponse(message.trim(), sanitizedHistory, options);
    const reply = stripTrailingStageTag(rawReply);

    return res.json({ reply });
  } catch (error) {
    logger.error('Failed to execute prompt test', { error: error.message });
    return next(error);
  }
};

module.exports = {
  getSystemPrompt,
  updateSystemPrompt,
  getUserPrompt,
  updateUserPrompt,
  testUserPrompt
};
