const crypto = require('crypto');
const { getDb } = require('../database/mongo');
const config = require('../config/environment');

const SESSIONS_COLLECTION = 'sessions';

const getCollection = () => getDb().collection(SESSIONS_COLLECTION);

const createSession = async ({ instagramId }) => {
  if (!instagramId) {
    throw new Error('instagramId is required to create a session.');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.session.maxAgeMs);

  await getCollection().insertOne({
    token,
    instagramId,
    createdAt: now,
    updatedAt: now,
    expiresAt
  });

  return { token, expiresAt };
};

const getSessionByToken = async (token) => {
  if (!token) {
    return null;
  }

  return getCollection().findOne({ token });
};

const deleteSessionByToken = async (token) => {
  if (!token) {
    return null;
  }

  return getCollection().deleteOne({ token });
};

const deleteSessionsForUser = async (instagramId) => {
  if (!instagramId) {
    return null;
  }

  return getCollection().deleteMany({ instagramId });
};

module.exports = {
  createSession,
  getSessionByToken,
  deleteSessionByToken,
  deleteSessionsForUser
};
