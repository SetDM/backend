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
const buildResponseInput = ({ systemPromptText, conversationHistory, userMessage }) => {
  const input = [];

  if (systemPromptText) {
    input.push({ role: 'developer', content: systemPromptText });
  }

  conversationHistory.forEach((msg) => {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    input.push({ role, content: msg.content });
  });

  input.push({ role: 'user', content: userMessage });
  return input;
};

const extractOutputText = (response) => {
  if (response.output_text) {
    return response.output_text.trim();
  }

  const messageItem = Array.isArray(response.output)
    ? response.output.find((item) => item.type === 'message')
    : null;

  if (!messageItem?.content) {
    return '';
  }

  const textChunks = messageItem.content
    .filter((chunk) => chunk.type === 'output_text' && chunk.text)
    .map((chunk) => chunk.text.trim())
    .filter(Boolean);

  return textChunks.join('\n').trim();
};

const generateResponse = async (userMessage, conversationHistory = []) => {
  try {
    const prompt = await loadSystemPrompt();
    const client = getOpenAIClient();

    const input = buildResponseInput({
      systemPromptText: prompt,
      conversationHistory,
      userMessage
    });

    logger.info('Sending request to OpenAI Responses API', {
      messageCount: input.length,
      userMessageLength: userMessage.length
    });

    const requestPayload = {
      model: config.openai.model || 'gpt-5-nano',
      input,
      reasoning: { effort: config.openai.reasoningEffort || 'medium' }
    };

    const response = await client.responses.create(requestPayload);

    const assistantMessage = extractOutputText(response);

    if (!assistantMessage) {
      throw new Error('No message content in Responses API output');
    }

    logger.info('OpenAI response generated', {
      responseLength: assistantMessage.length,
      tokensUsed: response.usage?.total_tokens
    });

    return assistantMessage;
  } catch (error) {
    logger.error('OpenAI Responses API error', {
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
