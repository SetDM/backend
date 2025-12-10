const logger = require('../utils/logger');
const {
  getPromptByName,
  upsertPrompt,
  DEFAULT_PROMPT_NAME,
  extractPromptSections,
  mergePromptSections
} = require('../services/prompt.service');
const { resetSystemPromptCache } = require('../services/chatgpt.service');

const SECTION_KEYS = ['coachName', 'leadSequence', 'qualificationSequence', 'bookingSequence'];

const hasSectionUpdates = (sections) =>
  Boolean(
    sections &&
      typeof sections === 'object' &&
      SECTION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(sections, key))
  );

const pickSectionUpdates = (sections = {}) => {
  const payload = {};

  SECTION_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(sections, key)) {
      const value = sections[key];
      payload[key] = typeof value === 'string' ? value : '';
    }
  });

  return payload;
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
    const { content, sections } = req.body || {};

    const hasContent = typeof content === 'string' && content.trim().length > 0;
    const hasSections = hasSectionUpdates(sections);

    if (!hasContent && !hasSections) {
      return res.status(400).json({ message: 'Provide prompt content or sections to update.' });
    }

    let resolvedContent = hasContent ? content : '';

    if (hasSections) {
      let baseContent = resolvedContent;

      if (!baseContent) {
        const currentPrompt = await getPromptByName(DEFAULT_PROMPT_NAME);
        baseContent = currentPrompt?.content || '';
      }

      if (!baseContent) {
        return res.status(400).json({
          message: 'No existing prompt content found. Seed the prompt before updating sections.'
        });
      }

      resolvedContent = mergePromptSections({
        baseContent,
        ...pickSectionUpdates(sections)
      });
    }

    if (!resolvedContent || !resolvedContent.trim()) {
      return res.status(400).json({ message: 'Resolved prompt content is empty.' });
    }

    await upsertPrompt({ name: DEFAULT_PROMPT_NAME, content: resolvedContent });
    resetSystemPromptCache();

    return res.json({
      message: 'Prompt updated successfully',
      content: resolvedContent,
      sections: extractPromptSections(resolvedContent)
    });
  } catch (error) {
    logger.error('Failed to update system prompt', { error: error.message });
    return next(error);
  }
};

module.exports = {
  getSystemPrompt,
  updateSystemPrompt
};
