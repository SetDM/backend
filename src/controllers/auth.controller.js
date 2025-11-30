const logger = require('../utils/logger');
const {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchUserProfile,
  sendDirectMessage
} = require('../services/instagram.service');

const startInstagramAuth = (req, res, next) => {
  try {
    const { state } = req.query;
    const authorizationUrl = buildAuthorizationUrl(state);
    res.redirect(authorizationUrl);
  } catch (error) {
    logger.error('Failed to initiate Instagram auth', error);
    next(error);
  }
};

const handleInstagramCallback = async (req, res, next) => {
  try {
    const { code, state, error: igError, error_description: errorDescription } = req.query;

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

    const tokenResponse = await exchangeCodeForToken(code);
    const profile = await fetchUserProfile(tokenResponse.access_token);
    const longLivedToken = await exchangeForLongLivedToken(tokenResponse.access_token);
    console.log('Instagram tokens:', {
      shortLived: tokenResponse.access_token,
      longLived: longLivedToken.access_token
    });

    res.json({
      profile,
      tokens: {
        shortLived: {
          accessToken: tokenResponse.access_token,
          userId: tokenResponse.user_id,
          expiresIn: tokenResponse.expires_in
        },
        longLived: {
          accessToken: longLivedToken.access_token,
          tokenType: longLivedToken.token_type,
          expiresIn: longLivedToken.expires_in
        }
      },
      state: state || null
    });
  } catch (error) {
    logger.error('Failed to complete Instagram auth', error);
    next(error);
  }
};

const sendInstagramDm = async (req, res, next) => {
  try {
    const { recipientId, message, accessToken } = req.body;

    if (!recipientId || !message || !accessToken) {
      const error = new Error('recipientId, message, and accessToken are required');
      error.statusCode = 400;
      throw error;
    }

    const response = await sendDirectMessage({ recipientId, message, accessToken });

    res.json({
      status: 'sent',
      response
    });
  } catch (error) {
    logger.error('Failed to send Instagram DM', error);
    next(error);
  }
};

module.exports = {
  startInstagramAuth,
  handleInstagramCallback,
  sendInstagramDm
};
