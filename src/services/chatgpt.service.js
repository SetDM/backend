const OpenAI = require('openai');
const config = require('../config/environment');
const logger = require('../utils/logger');
const { getPromptByName, DEFAULT_PROMPT_NAME } = require('./prompt.service');

const DEFAULT_PROMPT_TEXT =
  'You are a helpful assistant for Instagram Direct Messages. Respond professionally and courteously.';

let systemPrompt = null;
let systemPromptVersion = 0;
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
const buildChatMessages = ({ systemPromptText, conversationHistory, userMessage }) => {
  const messages = [];

  if (systemPromptText) {
    messages.push({ role: 'system', content: systemPromptText });
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

const generateResponse = async (userMessage, conversationHistory = []) => {
  try {
    const prompt = await loadSystemPrompt();
    const client = getOpenAIClient();

    const messages = buildChatMessages({
      systemPromptText: prompt,
      conversationHistory,
      userMessage
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

module.exports = {
  generateResponse,
  loadSystemPrompt,
  resetSystemPromptCache
};
