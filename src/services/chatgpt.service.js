const OpenAI = require('openai');
const config = require('../config/environment');
const logger = require('../utils/logger');
const { getPromptByName, DEFAULT_PROMPT_NAME } = require('./prompt.service');

const DEFAULT_PROMPT_TEXT =
  'You are a helpful assistant for Instagram Direct Messages. Respond professionally and courteously.';

let systemPrompt = null;
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
  if (systemPrompt) {
    return systemPrompt;
  }

  try {
    const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

    if (promptDoc?.content) {
      systemPrompt = promptDoc.content;
      logger.info('System prompt loaded from database', { name: promptDoc.name });
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

  systemPrompt = DEFAULT_PROMPT_TEXT;
  return systemPrompt;
};

/**
 * Generate a response using ChatGPT
 * @param {string} userMessage - The user's message
 * @param {Array} conversationHistory - Previous messages in format [{role, content}, ...]
 */
const generateResponse = async (userMessage, conversationHistory = []) => {
  try {
    const prompt = await loadSystemPrompt();
    const client = getOpenAIClient();

    // Build messages array with system prompt, conversation history, and new message
    const messages = [
      {
        role: 'system',
        content: prompt
      },
      ...conversationHistory,
      {
        role: 'user',
        content: userMessage
      }
    ];

    logger.info('Sending request to ChatGPT', {
      messageCount: messages.length,
      userMessageLength: userMessage.length
    });

    const response = await client.chat.completions.create({
      model: config.openai.model || 'gpt-4o-mini',
      messages,
      temperature: config.openai.temperature ?? 0.1
    });

    const assistantMessage = response.choices?.[0]?.message?.content;

    if (!assistantMessage) {
      throw new Error('No message content in ChatGPT response');
    }

    logger.info('ChatGPT response generated', {
      responseLength: assistantMessage.length,
      tokensUsed: response.usage?.total_tokens
    });

    return assistantMessage;
  } catch (error) {
    logger.error('ChatGPT API error', {
      error: error.message,
      status: error.status,
      data: error.response?.data || error.stack
    });
    throw error;
  }
};

const resetSystemPromptCache = () => {
  systemPrompt = null;
};

module.exports = {
  generateResponse,
  loadSystemPrompt,
  resetSystemPromptCache
};
