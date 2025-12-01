const { getDb } = require('../database/mongo');

const COLLECTION_NAME = 'instagram_users';

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
  shortLivedToken,
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

  if (shortLivedToken) {
    setDoc.tokens = setDoc.tokens || {};
    setDoc.tokens.shortLived = {
      accessToken: shortLivedToken.accessToken,
      userId: shortLivedToken.userId || null,
      expiresIn: shortLivedToken.expiresIn || null,
      expiresAt: computeExpiryDate(now, shortLivedToken.expiresIn),
      fetchedAt: now
    };
  }

  if (longLivedToken) {
    setDoc.tokens = setDoc.tokens || {};
    setDoc.tokens.longLived = {
      accessToken: longLivedToken.accessToken,
      tokenType: longLivedToken.tokenType || null,
      expiresIn: longLivedToken.expiresIn || null,
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

  return result.value;
};

const getInstagramUserById = async (instagramId) => {
  if (!instagramId) {
    return null;
  }

  const db = getDb();
  return db.collection(COLLECTION_NAME).findOne({ instagramId });
};

module.exports = {
  upsertInstagramUser,
  getInstagramUserById
};
