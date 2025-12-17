const { connectToDatabase, getDb } = require('../database/mongo');
const logger = require('../utils/logger');

const COLLECTION_NAME = 'prompts';
const DEFAULT_PROMPT_NAME = 'system';
const DEFAULT_COACH_NAME = 'John';
const USER_PROMPT_NAME = 'user-custom';

const PromptSectionLabels = {
  coachName: 'Coach Name',
  leadSequence: 'lead sequence',
  qualificationSequence: 'qualification sequence',
  bookingSequence: 'booking sequence'
};

const DEFAULT_SECTION_VALUES = {
  coachName: DEFAULT_COACH_NAME,
  leadSequence: '',
  qualificationSequence: '',
  bookingSequence: ''
};

const getCollection = async () => {
  await connectToDatabase();
  return getDb().collection(COLLECTION_NAME);
};

/**
 * Retrieve the prompt document by name (defaults to 'system').
 * Returns null if not found.
 */
const getPromptByName = async (name = DEFAULT_PROMPT_NAME) => {
  const collection = await getCollection();
  const promptDoc = await collection.findOne({ name });

  if (!promptDoc) {
    logger.warn('Prompt document not found', { name });
    return null;
  }

  return promptDoc;
};

/**
 * Upsert the prompt content for a given name. Useful for admin tooling.
 */
const upsertPrompt = async ({ name = DEFAULT_PROMPT_NAME, content }) => {
  if (!content) {
    throw new Error('Prompt content is required for upsert.');
  }

  const collection = await getCollection();
  const now = new Date();

  await collection.updateOne(
    { name },
    {
      $set: {
        name,
        content,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );

  logger.info('Prompt document upserted', { name });
};

const normalizeLineEndings = (value = '') => value.replace(/\r\n/g, '\n');

const sanitizeSectionValue = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  return normalizeLineEndings(value).trim();
};

const sanitizeSections = (sections = {}) => {
  const sanitized = {};

  Object.keys(PromptSectionLabels).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(sections, key)) {
      sanitized[key] = sanitizeSectionValue(sections[key]);
    }
  });

  return sanitized;
};

const upsertPromptSections = async ({ name, sections }) => {
  if (!name) {
    throw new Error('Prompt name is required for sections upsert.');
  }

  if (!sections || typeof sections !== 'object') {
    throw new Error('Prompt sections payload is required.');
  }

  const sanitizedSections = sanitizeSections(sections);
  const collection = await getCollection();
  const now = new Date();

  await collection.updateOne(
    { name },
    {
      $set: {
        name,
        sections: sanitizedSections,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );

  logger.info('Prompt sections upserted', { name });
  return sanitizedSections;
};

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extractCoachName = (content = '') => {
  const match = content.match(/Coach Name:\s*(.+)/i);
  return match?.[1]?.trim() || DEFAULT_COACH_NAME;
};

const upsertCoachNameLine = (content = '', coachName) => {
  const safeName = typeof coachName === 'string' ? coachName.trim() : '';

  if (!safeName) {
    return content;
  }

  if (/Coach Name:/i.test(content)) {
    return content.replace(/Coach Name:\s*.*/i, `Coach Name: ${safeName}`);
  }

  return `Coach Name: ${safeName}\n\n${content}`;
};

const extractBracketBlock = (content = '', label) => {
  if (!content || !label) {
    return '';
  }

  const pattern = new RegExp(`\\[${escapeRegex(label)}\\]\\s*\\{([\\s\\S]*?)\\}`, 'i');
  const match = content.match(pattern);
  return match ? match[1].trim() : '';
};

const replaceBracketBlock = (content = '', label, nextValue) => {
  if (!label) {
    return content;
  }

  const normalizedValue = typeof nextValue === 'string' ? nextValue.trim() : '';
  const pattern = new RegExp(`(\\[${escapeRegex(label)}\\]\\s*\\{)([\\s\\S]*?)(\\})`, 'i');

  if (pattern.test(content)) {
    return content.replace(pattern, (_match, start, _current, end) => {
      const body = normalizedValue ? `\n${normalizedValue}\n` : '\n';
      return `${start}${body}${end}`;
    });
  }

  const body = normalizedValue ? `\n${normalizedValue}\n` : '\n';
  const appendix = `\n\nThis is the variable [${label}] {${body}}`;
  return `${content}${appendix}`;
};

const extractPromptSections = (content = '') => ({
  coachName: extractCoachName(content),
  leadSequence: extractBracketBlock(content, PromptSectionLabels.leadSequence),
  qualificationSequence: extractBracketBlock(content, PromptSectionLabels.qualificationSequence),
  bookingSequence: extractBracketBlock(content, PromptSectionLabels.bookingSequence)
});

const mergePromptSections = ({
  baseContent = '',
  coachName,
  leadSequence,
  qualificationSequence,
  bookingSequence
} = {}) => {
  let workingContent = typeof baseContent === 'string' ? baseContent : '';

  if (typeof coachName === 'string') {
    workingContent = upsertCoachNameLine(workingContent, coachName);
  }

  if (leadSequence !== undefined) {
    workingContent = replaceBracketBlock(
      workingContent,
      PromptSectionLabels.leadSequence,
      leadSequence
    );
  }

  if (qualificationSequence !== undefined) {
    workingContent = replaceBracketBlock(
      workingContent,
      PromptSectionLabels.qualificationSequence,
      qualificationSequence
    );
  }

  if (bookingSequence !== undefined) {
    workingContent = replaceBracketBlock(
      workingContent,
      PromptSectionLabels.bookingSequence,
      bookingSequence
    );
  }

  return workingContent;
};

const mergeSectionsWithDefaults = ({ base = {}, overrides = {} } = {}) => {
  const normalizedBase = { ...DEFAULT_SECTION_VALUES, ...sanitizeSections(base) };
  const normalizedOverrides = sanitizeSections(overrides);
  const merged = {};

  Object.keys(DEFAULT_SECTION_VALUES).forEach((key) => {
    merged[key] =
      normalizedOverrides[key] ||
      normalizedBase[key] ||
      DEFAULT_SECTION_VALUES[key];
  });

  return merged;
};

const buildPromptFromSections = (sections = {}) => {
  const resolvedSections = mergeSectionsWithDefaults({ overrides: sections });
  const lines = [];

  if (resolvedSections.coachName) {
    lines.push(`Coach Name: ${resolvedSections.coachName}`);
    lines.push('');
  }

  const pushBlock = (key) => {
    const label = PromptSectionLabels[key];
    if (!label) {
      return;
    }

    const value = resolvedSections[key];
    lines.push(`This is the variable [${label}] {`);

    if (value) {
      lines.push(value);
    }

    lines.push('}');
    lines.push('');
  };

  pushBlock('leadSequence');
  pushBlock('qualificationSequence');
  pushBlock('bookingSequence');

  return lines.join('\n').trim();
};

module.exports = {
  COLLECTION_NAME,
  DEFAULT_PROMPT_NAME,
  DEFAULT_COACH_NAME,
  USER_PROMPT_NAME,
  PromptSectionLabels,
  getPromptByName,
  upsertPrompt,
  upsertPromptSections,
  extractPromptSections,
  mergePromptSections,
  mergeSectionsWithDefaults,
  buildPromptFromSections,
  sanitizeSections
};
