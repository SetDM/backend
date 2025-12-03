const { getDb } = require('../database/mongo');

const COLLECTION_NAME = 'instagram_users';

const buildSettingsSetDoc = (settings = {}) =>
  Object.entries(settings).reduce((acc, [key, value]) => {
    acc[`settings.${key}`] = value;
    return acc;
  }, {});

const computeExpiryDate = (issuedAt, expiresInSeconds) => {
  if (!expiresInSeconds || Number.isNaN(expiresInSeconds)) {
    return null;
  }

  return new Date(issuedAt.getTime() + expiresInSeconds * 1000);
};

const upsertInstagramUser = async ({
  id,
  username,
  accountType,
  longLivedToken
}) => {
  if (!id || !username) {
    const error = new Error('Invalid Instagram profile payload.');
    error.statusCode = 400;
    throw error;
  }

  const db = getDb();
  const now = new Date();

  const setDoc = {
    instagramId: id,
    username,
    accountType: accountType || null,
    lastLoginAt: now,
    updatedAt: now
  };

  if (longLivedToken) {
    setDoc.tokens = setDoc.tokens || {};
    setDoc.tokens.longLived = {
      accessToken: longLivedToken.accessToken,
      expiresAt: computeExpiryDate(now, longLivedToken.expiresIn),
      fetchedAt: now
    };
  }

  const updateDoc = {
    $set: setDoc,
    $setOnInsert: {
      createdAt: now
    }
  };

  const options = {
    upsert: true,
    returnDocument: 'after'
  };

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { instagramId: id },
    updateDoc,
    options
  );

  return result;
};

const getInstagramUserById = async (instagramId) => {
  if (!instagramId) {
    return null;
  }

  const db = getDb();
  return db.collection(COLLECTION_NAME).findOne({ instagramId });
};

const updateInstagramUserSettings = async (instagramId, settings = {}) => {
  if (!instagramId) {
    throw new Error('Instagram ID is required to update settings.');
  }

  const db = getDb();
  const now = new Date();
  const settingsSetDoc = buildSettingsSetDoc(settings);

  const updateDoc = {
    $set: {
      updatedAt: now,
      ...settingsSetDoc
    },
    $setOnInsert: {
      instagramId,
      createdAt: now
    }
  };

  return db.collection(COLLECTION_NAME).findOneAndUpdate(
    { instagramId },
    updateDoc,
    { upsert: true, returnDocument: 'after' }
  );
};

const updateCalendlyLink = async (instagramId, calendlyLink) =>
  updateInstagramUserSettings(instagramId, { calendlyLink });

module.exports = {
  upsertInstagramUser,
  getInstagramUserById,
  updateInstagramUserSettings,
  updateCalendlyLink
};
