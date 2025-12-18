const { connectToDatabase, getDb } = require('../database/mongo');
const logger = require('../utils/logger');

const COLLECTION_NAME = 'prompts';
const DEFAULT_PROMPT_NAME = 'system';
const DEFAULT_COACH_NAME = 'John';
const USER_PROMPT_NAME = 'user-custom';

// Legacy section labels for backward compatibility
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

// New config structure that matches frontend
const DEFAULT_CONFIG = {
  coachName: DEFAULT_COACH_NAME,
  addToExisting: true,
  coachingDetails: '',
  styleNotes: '',
  objectionHandlers: [],
  sequences: {
    lead: { script: '', followups: [] },
    qualification: { script: '', followups: [] },
    booking: { script: '', followups: [] },
    callBooked: { script: '', followups: [] },
    vslLink: ''
  },
  keywordSequence: {
    keyword: '',
    initialMessage: '',
    followups: []
  }
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
 * Retrieve the prompt document for a specific workspace.
 * @param {string} workspaceId - The Instagram ID of the workspace
 * @returns {Object|null} The prompt document or null if not found
 */
const getPromptByWorkspace = async (workspaceId) => {
  if (!workspaceId) {
    logger.warn('getPromptByWorkspace called without workspaceId');
    return null;
  }

  const collection = await getCollection();
  const promptDoc = await collection.findOne({ 
    name: USER_PROMPT_NAME,
    workspaceId 
  });

  if (!promptDoc) {
    logger.debug('Workspace prompt not found', { workspaceId });
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

/**
 * Sanitize a followup message object
 */
const sanitizeFollowup = (followup) => {
  if (!followup || typeof followup !== 'object') {
    return null;
  }

  return {
    id: typeof followup.id === 'string' ? followup.id : String(Date.now()) + Math.random().toString(36).slice(2),
    content: sanitizeSectionValue(followup.content),
    delayValue: String(followup.delayValue || '1'),
    delayUnit: followup.delayUnit === 'minutes' ? 'minutes' : 'hours'
  };
};

/**
 * Sanitize an objection handler object
 */
const sanitizeObjectionHandler = (handler) => {
  if (!handler || typeof handler !== 'object') {
    return null;
  }

  return {
    id: typeof handler.id === 'string' ? handler.id : String(Date.now()) + Math.random().toString(36).slice(2),
    objection: sanitizeSectionValue(handler.objection),
    response: sanitizeSectionValue(handler.response)
  };
};

/**
 * Sanitize a sequence block
 */
const sanitizeSequenceBlock = (block) => {
  if (!block || typeof block !== 'object') {
    return { script: '', followups: [] };
  }

  return {
    script: sanitizeSectionValue(block.script),
    followups: Array.isArray(block.followups)
      ? block.followups.map(sanitizeFollowup).filter(Boolean)
      : []
  };
};

/**
 * Sanitize the full config object from frontend
 */
const sanitizeConfig = (config = {}) => {
  const sanitized = {
    coachName: sanitizeSectionValue(config.coachName) || DEFAULT_COACH_NAME,
    addToExisting: config.addToExisting !== false,
    coachingDetails: sanitizeSectionValue(config.coachingDetails),
    styleNotes: sanitizeSectionValue(config.styleNotes),
    objectionHandlers: Array.isArray(config.objectionHandlers)
      ? config.objectionHandlers.map(sanitizeObjectionHandler).filter(Boolean)
      : [],
    sequences: {
      lead: sanitizeSequenceBlock(config.sequences?.lead),
      qualification: sanitizeSequenceBlock(config.sequences?.qualification),
      booking: sanitizeSequenceBlock(config.sequences?.booking),
      callBooked: sanitizeSequenceBlock(config.sequences?.callBooked),
      vslLink: sanitizeSectionValue(config.sequences?.vslLink)
    },
    keywordSequence: {
      keyword: sanitizeSectionValue(config.keywordSequence?.keyword),
      initialMessage: sanitizeSectionValue(config.keywordSequence?.initialMessage),
      followups: Array.isArray(config.keywordSequence?.followups)
        ? config.keywordSequence.followups.map(sanitizeFollowup).filter(Boolean)
        : []
    }
  };

  return sanitized;
};

/**
 * Upsert prompt config for a specific workspace
 * @param {Object} params
 * @param {string} params.workspaceId - The Instagram ID of the workspace
 * @param {Object} params.config - The config object to save
 */
const upsertPromptConfig = async ({ workspaceId, config }) => {
  if (!workspaceId) {
    throw new Error('workspaceId is required for config upsert.');
  }

  if (!config || typeof config !== 'object') {
    throw new Error('Prompt config payload is required.');
  }

  const sanitizedConfig = sanitizeConfig(config);
  const collection = await getCollection();
  const now = new Date();

  await collection.updateOne(
    { name: USER_PROMPT_NAME, workspaceId },
    {
      $set: {
        name: USER_PROMPT_NAME,
        workspaceId,
        config: sanitizedConfig,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );

  logger.info('Prompt config upserted', { workspaceId });
  return sanitizedConfig;
};

// Legacy section upsert for backward compatibility
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

/**
 * Merge config with defaults
 */
const mergeConfigWithDefaults = (config = {}) => {
  return {
    coachName: config.coachName || DEFAULT_CONFIG.coachName,
    addToExisting: config.addToExisting !== false,
    coachingDetails: config.coachingDetails || '',
    styleNotes: config.styleNotes || '',
    objectionHandlers: Array.isArray(config.objectionHandlers) ? config.objectionHandlers : [],
    sequences: {
      lead: config.sequences?.lead || DEFAULT_CONFIG.sequences.lead,
      qualification: config.sequences?.qualification || DEFAULT_CONFIG.sequences.qualification,
      booking: config.sequences?.booking || DEFAULT_CONFIG.sequences.booking,
      callBooked: config.sequences?.callBooked || DEFAULT_CONFIG.sequences.callBooked,
      vslLink: config.sequences?.vslLink || ''
    },
    keywordSequence: config.keywordSequence || DEFAULT_CONFIG.keywordSequence
  };
};

// Legacy function for backward compatibility
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

/**
 * Build the full prompt text from config
 * This is what gets sent to the LLM as context
 */
const buildPromptFromConfig = (config = {}) => {
  const resolved = mergeConfigWithDefaults(config);
  const lines = [];

  // Coach identity
  lines.push(`Coach Name: ${resolved.coachName}`);
  lines.push('');

  // About the coach
  if (resolved.coachingDetails) {
    lines.push('About the Coach:');
    lines.push(resolved.coachingDetails);
    lines.push('');
  }

  // Style preferences
  if (resolved.styleNotes) {
    lines.push('Communication Style:');
    lines.push(resolved.styleNotes);
    lines.push('');
  }

  // Objection handlers
  if (resolved.objectionHandlers.length > 0) {
    lines.push('Objection Handlers:');
    resolved.objectionHandlers.forEach((handler) => {
      if (handler.objection && handler.response) {
        lines.push(`If prospect says: "${handler.objection}"`);
        lines.push(`Response: ${handler.response}`);
        lines.push('');
      }
    });
  }

  // Keyword sequence
  if (resolved.keywordSequence.keyword) {
    lines.push(`Keyword Trigger: ${resolved.keywordSequence.keyword}`);
    if (resolved.keywordSequence.initialMessage) {
      lines.push(`When prospect sends this keyword, respond with: ${resolved.keywordSequence.initialMessage}`);
    }
    lines.push('');
  }

  // Lead sequence
  if (resolved.sequences.lead.script) {
    lines.push('This is the variable [lead sequence] {');
    lines.push(resolved.sequences.lead.script);
    lines.push('}');
    lines.push('');
  }

  // Qualification sequence
  if (resolved.sequences.qualification.script) {
    lines.push('This is the variable [qualification sequence] {');
    lines.push(resolved.sequences.qualification.script);
    lines.push('}');
    lines.push('');
  }

  // Booking sequence
  if (resolved.sequences.booking.script) {
    lines.push('This is the variable [booking sequence] {');
    lines.push(resolved.sequences.booking.script);
    lines.push('}');
    lines.push('');
  }

  // Call booked sequence
  if (resolved.sequences.callBooked.script) {
    lines.push('This is the variable [call booked sequence] {');
    lines.push(resolved.sequences.callBooked.script);
    lines.push('}');
    lines.push('');
  }

  // VSL link
  if (resolved.sequences.vslLink) {
    lines.push(`VSL Link: ${resolved.sequences.vslLink}`);
    lines.push('');
  }

  return lines.join('\n').trim();
};

module.exports = {
  COLLECTION_NAME,
  DEFAULT_PROMPT_NAME,
  DEFAULT_COACH_NAME,
  USER_PROMPT_NAME,
  DEFAULT_CONFIG,
  PromptSectionLabels,
  getPromptByName,
  getPromptByWorkspace,
  upsertPrompt,
  upsertPromptSections,
  upsertPromptConfig,
  extractPromptSections,
  mergePromptSections,
  mergeSectionsWithDefaults,
  mergeConfigWithDefaults,
  buildPromptFromSections,
  buildPromptFromConfig,
  sanitizeSections,
  sanitizeConfig
};
