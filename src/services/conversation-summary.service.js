const logger = require('../utils/logger');
const { getConversationHistory } = require('./conversation.service');
const { generateConversationNotes } = require('./chatgpt.service');

const MAX_MESSAGES_FOR_SUMMARY = 60;
const MAX_TRANSCRIPT_CHARS = 8000;

const buildTranscript = (messages = []) => {
  const entries = messages
    .map((message) => {
      if (!message || typeof message.content !== 'string' || !message.content.trim()) {
        return null;
      }

      const roleLabel = message.role === 'assistant' ? 'Business' : 'Prospect';
      const normalized = message.content.replace(/\s+/g, ' ').trim();
      return `${roleLabel}: ${normalized}`;
    })
    .filter(Boolean);

  if (!entries.length) {
    return '';
  }

  let transcript = entries.join('\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  }

  return transcript;
};

const getConversationNotes = async ({ senderId, recipientId, maxNotes = 5 }) => {
  const history = await getConversationHistory(senderId, recipientId, MAX_MESSAGES_FOR_SUMMARY);

  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  const transcript = buildTranscript(history);
  if (!transcript) {
    return [];
  }

  try {
    const notes = await generateConversationNotes({ transcript, maxNotes });
    return notes;
  } catch (error) {
    logger.error('Failed to generate conversation notes via OpenAI', {
      senderId,
      recipientId,
      error: error.message
    });
    throw error;
  }
};

module.exports = {
  getConversationNotes
};
