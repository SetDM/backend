const OpenAI = require('openai');
const config = require('../config/environment');
const logger = require('../utils/logger');
const {
  getPromptByName,
  DEFAULT_PROMPT_NAME,
  USER_PROMPT_NAME,
  extractPromptSections,
  mergeSectionsWithDefaults,
  buildPromptFromSections
} = require('./prompt.service');

const DEFAULT_PROMPT_TEXT =
  'You are a helpful assistant for Instagram Direct Messages. Respond professionally and courteously.';
const SUMMARY_SYSTEM_PROMPT =
  'You are an assistant that reviews Instagram DM transcripts and writes concise CRM notes. Return JSON with a "notes" array containing up to {{maxNotes}} action-oriented bullet points (12 words max each). Focus on intent, objections, commitments, and next steps. Do not include any other text.';

let systemPrompt = null;
let systemPromptVersion = 0;
let userPrompt = null;
let userPromptVersion = 0;
let openaiClient = null;

const getOpenAIClient = () => {
  if (openaiClient) {
    return openaiClient;
  }

  if (!config.openai?.apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  return openaiClient;
};

/**
 * Load system prompt from MongoDB (cached in-memory once loaded).
 */
const loadSystemPrompt = async () => {
  try {
    const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

    if (promptDoc?.content) {
      if (systemPrompt !== promptDoc.content) {
        systemPrompt = promptDoc.content;
        systemPromptVersion += 1;
        logger.info('System prompt refreshed from database', {
          name: promptDoc.name,
          version: systemPromptVersion
        });
      }

      return systemPrompt;
    }

    logger.warn('Prompt document missing or empty, using fallback prompt', {
      name: DEFAULT_PROMPT_NAME
    });
  } catch (error) {
    logger.error('Failed to load system prompt from database', {
      error: error.message
    });
  }

  if (!systemPrompt) {
    systemPrompt = DEFAULT_PROMPT_TEXT;
  }

  return systemPrompt;
};

/**
 * Generate a response using ChatGPT
 * @param {string} userMessage - The user's message
 * @param {Array} conversationHistory - Previous messages in format [{role, content}, ...]
 */
const buildChatMessages = ({
  systemPromptText,
  userPromptText,
  conversationHistory,
  userMessage,
  stageTag
}) => {
  const messages = [];

  if (systemPromptText) {
    messages.push({ role: 'system', content: systemPromptText });
  }

  if (userPromptText) {
    messages.push({ role: 'system', content: userPromptText });
  }

  if (stageTag && typeof stageTag === 'string' && stageTag.trim().length > 0) {
    messages.push({
      role: 'system',
      content: `Context: The prospect's current stage tag is "${stageTag.trim()}". Use this flag to maintain continuity and avoid repeating previously completed steps.`
    });
  }

  conversationHistory.forEach((msg) => {
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    });
  });

  messages.push({ role: 'user', content: userMessage });
  return messages;
};

const generateResponse = async (userMessage, conversationHistory = [], options = {}) => {
  try {
    const [prompt, customPrompt] = await Promise.all([loadSystemPrompt(), loadUserPrompt()]);
    const client = getOpenAIClient();
    const stageTag = typeof options?.stageTag === 'string' ? options.stageTag : null;

    const messages = buildChatMessages({
      systemPromptText: prompt,
      userPromptText: customPrompt,
      conversationHistory,
      userMessage,
      stageTag
    });

    logger.info('Sending request to OpenAI Chat Completions API', {
      messageCount: messages.length,
      userMessageLength: userMessage.length
    });

    const requestPayload = {
      model: config.openai.model || 'gpt-4o-mini',
      messages
    };

    if (Number.isFinite(config.openai.temperature)) {
      requestPayload.temperature = Number(config.openai.temperature);
    }

    const response = await client.chat.completions.create(requestPayload);

    const assistantMessage = response.choices?.[0]?.message?.content?.trim();

    if (!assistantMessage) {
      throw new Error('No message content in Chat Completions response');
    }

    logger.info('OpenAI chat completion generated', {
      responseLength: assistantMessage.length,
      tokensUsed: response.usage?.total_tokens
    });

    return assistantMessage;
  } catch (error) {
    logger.error('OpenAI Chat Completions API error', {
      error: error.message,
      status: error.status,
      data: error.response?.data || error.stack
    });
    throw error;
  }
};

const resetSystemPromptCache = () => {
  systemPrompt = null;
  systemPromptVersion = 0;
};

const loadUserPrompt = async () => {
  if (userPrompt) {
    return userPrompt;
  }

  try {
    const [systemPromptDoc, userPromptDoc] = await Promise.all([
      getPromptByName(DEFAULT_PROMPT_NAME),
      getPromptByName(USER_PROMPT_NAME)
    ]);

    const baseSections = extractPromptSections(systemPromptDoc?.content || '');
    const overrideSections = userPromptDoc?.sections || {};
    const mergedSections = mergeSectionsWithDefaults({
      base: baseSections,
      overrides: overrideSections
    });

    const renderedPrompt = buildPromptFromSections(mergedSections);

    if (renderedPrompt && renderedPrompt.trim()) {
      userPrompt = renderedPrompt;
      userPromptVersion += 1;
      logger.info('User prompt refreshed from database', {
        version: userPromptVersion
      });
      return userPrompt;
    }
  } catch (error) {
    logger.error('Failed to load user prompt from database', {
      error: error.message
    });
  }

  userPrompt = null;
  return null;
};

const resetUserPromptCache = () => {
  userPrompt = null;
  userPromptVersion = 0;
};

const sanitizeNote = (value) => {
  if (!value) {
    return null;
  }

  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
};

const parseNotesFromContent = (content, maxNotes) => {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const trimmed = content.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(sanitizeNote).filter(Boolean).slice(0, maxNotes);
    }

    if (parsed && Array.isArray(parsed.notes)) {
      return parsed.notes.map(sanitizeNote).filter(Boolean).slice(0, maxNotes);
    }
  } catch (error) {
    logger.debug('Failed to parse JSON notes from OpenAI summary response, falling back to text parsing', {
      error: error.message
    });
  }

  const lines = trimmed
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);

  return lines.slice(0, maxNotes);
};

const generateConversationNotes = async ({ transcript, maxNotes = 5 }) => {
  if (!transcript || typeof transcript !== 'string') {
    return [];
  }

  const client = getOpenAIClient();
  const resolvedMaxNotes = Math.max(1, Math.min(10, Number(maxNotes) || 5));
  const systemPromptText = SUMMARY_SYSTEM_PROMPT.replace('{{maxNotes}}', String(resolvedMaxNotes));
  const messages = [
    {
      role: 'system',
      content: systemPromptText
    },
    {
      role: 'user',
      content: [
        'Conversation transcript:',
        transcript,
        '',
        `Return up to ${resolvedMaxNotes} bullet notes as JSON.`
      ].join('\n')
    }
  ];

  const requestPayload = {
    model: config.openai?.summaryModel || config.openai?.model || 'gpt-4o-mini',
    messages,
    temperature: 0.2
  };

  try {
    const response = await client.chat.completions.create(requestPayload);
    const content = response.choices?.[0]?.message?.content?.trim();
    const notes = parseNotesFromContent(content, resolvedMaxNotes);

    logger.info('Generated AI notes for conversation', {
      noteCount: notes.length
    });

    return notes;
  } catch (error) {
    logger.error('Failed to generate conversation notes via OpenAI', {
      error: error.message,
      status: error.status,
      data: error.response?.data || error.stack
    });
    throw error;
  }
};

module.exports = {
  generateResponse,
  loadSystemPrompt,
  resetSystemPromptCache,
  resetUserPromptCache,
  generateConversationNotes
};
