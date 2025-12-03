const { getDb, connectToDatabase } = require('../database/mongo');
const logger = require('../utils/logger');

const CONVERSATIONS_COLLECTION = 'conversations';

/**
 * Store a message in the conversation history
 * @param {string} senderId - Instagram user ID
 * @param {string} recipientId - Business account ID
 * @param {string} message - Message text
 * @param {string} role - 'user' or 'assistant'
 */
const storeMessage = async (senderId, recipientId, message, role) => {
  try {
    await connectToDatabase();
    const db = getDb();
    const collection = db.collection(CONVERSATIONS_COLLECTION);

    const conversationId = `${recipientId}_${senderId}`;
    const timestamp = new Date();

    // Insert the message and create/update the conversation document
    const result = await collection.updateOne(
      { conversationId, recipientId, senderId },
      {
        $push: {
          messages: {
            role,
            content: message,
            timestamp
          }
        },
        $set: {
          conversationId,
          recipientId,
          senderId,
          lastUpdated: timestamp
        }
      },
      { upsert: true }
    );

    logger.info('Message stored in conversation history', {
      conversationId,
      role,
      messageLength: message.length
    });

    return result;
  } catch (error) {
    logger.error('Failed to store message in conversation', {
      senderId,
      recipientId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Get conversation history between sender and recipient
 * @param {string} senderId - Instagram user ID
 * @param {string} recipientId - Business account ID
 * @param {number} limit - Number of recent messages to retrieve (default 50)
 */
const getConversationHistory = async (senderId, recipientId, limit = 50) => {
  try {
    await connectToDatabase();
    const db = getDb();
    const collection = db.collection(CONVERSATIONS_COLLECTION);

    const conversationId = `${recipientId}_${senderId}`;

    const conversation = await collection.findOne({
      conversationId,
      recipientId,
      senderId
    });

    if (!conversation || !conversation.messages) {
      logger.info('No conversation history found', { conversationId });
      return [];
    }

    // Return the last 'limit' messages
    const messages = conversation.messages.slice(-limit);
    logger.info('Retrieved conversation history', {
      conversationId,
      messageCount: messages.length
    });

    return messages;
  } catch (error) {
    logger.error('Failed to retrieve conversation history', {
      senderId,
      recipientId,
      error: error.message
    });
    throw error;
  }
};

/**
 * Format conversation history for ChatGPT API
 * @param {Array} messages - Array of message objects
 */
const formatForChatGPT = (messages) => {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content
  }));
};

/**
 * Clear conversation history (optional)
 * @param {string} senderId - Instagram user ID
 * @param {string} recipientId - Business account ID
 */
const clearConversationHistory = async (senderId, recipientId) => {
  try {
    await connectToDatabase();
    const db = getDb();
    const collection = db.collection(CONVERSATIONS_COLLECTION);

    const conversationId = `${recipientId}_${senderId}`;

    const result = await collection.deleteOne({
      conversationId,
      recipientId,
      senderId
    });

    logger.info('Conversation history cleared', { conversationId });
    return result;
  } catch (error) {
    logger.error('Failed to clear conversation history', {
      senderId,
      recipientId,
      error: error.message
    });
    throw error;
  }
};

module.exports = {
  storeMessage,
  getConversationHistory,
  formatForChatGPT,
  clearConversationHistory
};
