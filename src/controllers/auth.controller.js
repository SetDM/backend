const config = require('../config/environment');
const logger = require('../utils/logger');
const {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchUserProfile
} = require('../services/instagram.service');
const { upsertInstagramUser } = require('../services/instagram-user.service');

const startInstagramAuth = (req, res, next) => {
  try {
    const { state } = req.query;
    const redirectUri = config.instagram.redirectUri;

    if (!redirectUri) {
      const error = new Error('Instagram redirect URI is not configured.');
      error.statusCode = 500;
      throw error;
    }

    const authorizationUrl = buildAuthorizationUrl({ state, redirectUri });
    res.redirect(authorizationUrl);
  } catch (error) {
    logger.error('Failed to initiate Instagram auth', error);
    next(error);
  }
};

const handleInstagramCallback = async (req, res, next) => {
  try {
    const { code, error: igError, error_description: errorDescription } = req.query;
    const redirectUri = config.instagram.redirectUri;

    if (!redirectUri) {
      const error = new Error('Instagram redirect URI is not configured.');
      error.statusCode = 500;
      throw error;
    }

    if (igError) {
      const error = new Error(`Instagram authorization declined: ${errorDescription || igError}`);
      error.statusCode = 400;
      throw error;
    }

    if (!code) {
      const error = new Error('Missing authorization code from Instagram.');
      error.statusCode = 400;
      throw error;
    }

    const tokenResponse = await exchangeCodeForToken({ code, redirectUri });
    const profile = await fetchUserProfile(tokenResponse.access_token);
    const longLivedToken = await exchangeForLongLivedToken(tokenResponse.access_token);
    const storedUser = await upsertInstagramUser({
      id: profile.user_id,
      username: profile.username,
      accountType: profile.account_type,
      longLivedToken: {
        accessToken: longLivedToken.access_token,
        tokenType: longLivedToken.token_type,
        expiresIn: longLivedToken.expires_in
      }
    });

    res.json({
      message: 'Instagram authentication successful.',
      user: {
        instagramId: storedUser.instagramId,
        username: storedUser.username,
        accountType: storedUser.accountType,
        lastLoginAt: storedUser.lastLoginAt
      },
        longLived: {
          accessToken: longLivedToken.access_token,
          tokenType: longLivedToken.token_type,
          expiresIn: longLivedToken.expires_in
        }
    });
  } catch (error) {
    logger.error('Failed to complete Instagram auth', error);
    next(error);
  }
};

module.exports = {
  startInstagramAuth,
  handleInstagramCallback
};
