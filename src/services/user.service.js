const { connectToDatabase, getDb } = require('../database/mongo');
const { fetchInstagramProfileById } = require('./instagram.service');
const logger = require('../utils/logger');

const USERS_COLLECTION = 'users';

const getUserByInstagramId = async (instagramId) => {
  if (!instagramId) {
    return null;
  }

  await connectToDatabase();
  const db = getDb();
  return db.collection(USERS_COLLECTION).findOne({ instagramId });
};

const insertInstagramUserProfile = async ({
  instagramId,
  username,
  name,
  profilePic,
  followerCount,
  isUserFollowBusiness,
  isBusinessFollowUser
}) => {
  if (!instagramId) {
    throw new Error('instagramId is required to store user profile.');
  }

  await connectToDatabase();
  const db = getDb();
  const now = new Date();

  const doc = {
    instagramId,
    username: username || null,
    name: name || null,
    profilePic: profilePic || null,
    followerCount: Number.isFinite(followerCount) ? followerCount : null,
    isUserFollowBusiness:
      typeof isUserFollowBusiness === 'boolean' ? isUserFollowBusiness : null,
    isBusinessFollowUser:
      typeof isBusinessFollowUser === 'boolean' ? isBusinessFollowUser : null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(USERS_COLLECTION).insertOne(doc);
  return doc;
};

const ensureInstagramUserProfile = async ({ instagramId, accessToken }) => {
  if (!instagramId || !accessToken) {
    throw new Error('instagramId and accessToken are required to sync user profile.');
  }

  const existing = await getUserByInstagramId(instagramId);
  if (existing) {
    return existing;
  }

  const profile = await fetchInstagramProfileById({ instagramId, accessToken });
  const normalizedProfile = {
    instagramId,
    username: profile?.username,
    name: profile?.name,
    profilePic: profile?.profile_pic,
    followerCount: profile?.follower_count,
    isUserFollowBusiness: profile?.is_user_follow_business,
    isBusinessFollowUser: profile?.is_business_follow_user
  };

  try {
    return await insertInstagramUserProfile(normalizedProfile);
  } catch (error) {
    logger.error('Failed to store Instagram user profile', {
      instagramId,
      error: error.message
    });
    throw error;
  }
};

module.exports = {
  getUserByInstagramId,
  ensureInstagramUserProfile
};
