const logger = require('../utils/logger');
const { getUserByInstagramId } = require('../services/user.service');

const normalizeUserDocument = (doc = {}) => {
  if (!doc) {
    return null;
  }

  const { _id, ...rest } = doc;
  const id = typeof _id?.toString === 'function' ? _id.toString() : _id ?? null;

  return {
    id,
    instagramId: rest.instagramId || null,
    username: rest.username || null,
    name: rest.name || null,
    profilePic: rest.profilePic || null,
    followerCount: rest.followerCount ?? null,
    isUserFollowBusiness: rest.isUserFollowBusiness ?? null,
    isBusinessFollowUser: rest.isBusinessFollowUser ?? null,
    source: rest.source || null,
    createdAt: rest.createdAt || null,
    updatedAt: rest.updatedAt || null
  };
};

const getUserProfile = async (req, res, next) => {
  try {
    const { instagramId } = req.params;

    if (!instagramId) {
      return res.status(400).json({ message: 'instagramId is required' });
    }

    const userDoc = await getUserByInstagramId(instagramId);

    if (!userDoc) {
      return res.status(404).json({ message: 'User not found' });
    }

    const payload = normalizeUserDocument(userDoc);

    return res.json({ data: payload });
  } catch (error) {
    logger.error('Failed to fetch stored Instagram user', {
      error: error.message,
      instagramId: req.params?.instagramId
    });
    return next(error);
  }
};

module.exports = {
  getUserProfile
};
