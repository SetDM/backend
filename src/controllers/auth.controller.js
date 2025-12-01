const logger = require('../utils/logger');
const {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchUserProfile
} = require('../services/instagram.service');
const { upsertInstagramUser } = require('../services/instagram-user.service');

const buildCallbackUrl = (req) => {
  const host = req.get('host');
  const protocolHeader = req.get('x-forwarded-proto');
  const protocol = (protocolHeader && protocolHeader.split(',')[0].trim()) || req.protocol || 'https';

  if (!host) {
    const error = new Error('Unable to determine request host for OAuth redirect.');
    error.statusCode = 500;
    throw error;
  }

  return `${protocol}://${host}/api/auth/instagram/callback`;
};

const startInstagramAuth = (req, res, next) => {
  try {
    const { state } = req.query;
    const redirectUri = buildCallbackUrl(req);
    const authorizationUrl = buildAuthorizationUrl({ state, redirectUri });
    res.redirect(authorizationUrl);
  } catch (error) {
    logger.error('Failed to initiate Instagram auth', error);
    next(error);
  }
};

const handleInstagramCallback = async (req, res, next) => {
  try {
    const { code, state, error: igError, error_description: errorDescription } = req.query;
    const redirectUri = buildCallbackUrl(req);

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
      id: profile.id,
      username: profile.username,
      accountType: profile.account_type,
      shortLivedToken: {
        accessToken: tokenResponse.access_token,
        userId: tokenResponse.user_id,
        expiresIn: tokenResponse.expires_in
      },
      longLivedToken: {
        accessToken: longLivedToken.access_token,
        tokenType: longLivedToken.token_type,
        expiresIn: longLivedToken.expires_in
      }
    });

    res.json({
      profile,
      user: {
        instagramId: storedUser.instagramId,
        username: storedUser.username,
        accountType: storedUser.accountType,
        lastLoginAt: storedUser.lastLoginAt
      },
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

module.exports = {
  startInstagramAuth,
  handleInstagramCallback
};
