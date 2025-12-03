const { connectToDatabase, getDb } = require('../database/mongo');
const logger = require('../utils/logger');

const COLLECTION_NAME = 'prompts';
const DEFAULT_PROMPT_NAME = 'system';

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

module.exports = {
  COLLECTION_NAME,
  DEFAULT_PROMPT_NAME,
  getPromptByName,
  upsertPrompt
};
