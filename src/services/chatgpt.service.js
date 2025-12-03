const axios = require('axios');
const config = require('../config/environment');
const logger = require('../utils/logger');
const { getPromptByName, DEFAULT_PROMPT_NAME } = require('./prompt.service');

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_PROMPT_TEXT =
  'You are a helpful assistant for Instagram Direct Messages. Respond professionally and courteously.';

let systemPrompt = null;

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
  if (!config.openai?.apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  try {
    const prompt = await loadSystemPrompt();

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

    const response = await axios.post(
      OPENAI_API_URL,
      {
        model: config.openai.model || 'gpt-3.5-turbo',
        messages,
        temperature: config.openai.temperature || 0.7,
        max_tokens: config.openai.maxTokens || 500
      },
      {
        headers: {
          'Authorization': `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 seconds timeout
      }
    );

    const assistantMessage = response.data?.choices?.[0]?.message?.content;

    if (!assistantMessage) {
      throw new Error('No message content in ChatGPT response');
    }

    logger.info('ChatGPT response generated', {
      responseLength: assistantMessage.length,
      tokensUsed: response.data?.usage?.total_tokens
    });

    return assistantMessage;
  } catch (error) {
    logger.error('ChatGPT API error', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    throw error;
  }
};

module.exports = {
  generateResponse,
  loadSystemPrompt
};
