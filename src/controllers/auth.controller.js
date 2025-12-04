const config = require('../config/environment');
const logger = require('../utils/logger');
const {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchUserProfile,
  subscribeAppToUser
} = require('../services/instagram.service');
const {
  upsertInstagramUser,
  getInstagramUserById
} = require('../services/instagram-user.service');
const {
  createSession,
  deleteSessionByToken
} = require('../services/session.service');
const { buildCookieOptions, clearAuthCookie } = require('../middleware/session-auth');

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

const setSessionCookie = (res, token, expiresAt) => {
  res.cookie(
    config.session.cookieName,
    token,
    buildCookieOptions(expiresAt ? { expires: expiresAt } : undefined)
  );
};

const getSafeUserPayload = (userDoc) => {
  if (!userDoc) {
    return null;
  }

  return {
    instagramId: userDoc.instagramId,
    username: userDoc.username,
    accountType: userDoc.accountType,
    lastLoginAt: userDoc.lastLoginAt,
    settings: userDoc.settings || null
  };
};

const redirectOrRespond = (res, url, payload) => {
  if (url) {
    return res.redirect(url);
  }

  return res.json(payload);
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
    await upsertInstagramUser({
      id: profile.user_id,
      username: profile.username,
      accountType: profile.account_type,
      longLivedToken: {
        accessToken: longLivedToken.access_token,
        tokenType: longLivedToken.token_type,
        expiresIn: longLivedToken.expires_in
      }
    });

    try {
      await subscribeAppToUser({
        instagramBusinessId: profile.user_id,
        accessToken: longLivedToken.access_token,
        fields: ['comments', 'messages']
      });
      logger.info('Subscribed Instagram user to comments/messages webhooks', {
        instagramId: profile.user_id
      });
    } catch (subscriptionError) {
      logger.error('Failed to subscribe Instagram user to app events', {
        instagramId: profile.user_id,
        error: subscriptionError.message,
        details: subscriptionError.details
      });
    }

    const userRecord = await getInstagramUserById(profile.user_id);
    const session = await createSession({ instagramId: userRecord.instagramId });
    setSessionCookie(res, session.token, session.expiresAt);

    return redirectOrRespond(res, config.auth.successRedirectUrl, {
      message: 'Instagram authentication successful.',
      user: getSafeUserPayload(userRecord)
    });
  } catch (error) {
    logger.error('Failed to complete Instagram auth', error);
    if (config.auth.failureRedirectUrl) {
      return res.redirect(config.auth.failureRedirectUrl);
    }
    next(error);
  }
};

const getCurrentUser = (req, res) => {
  return res.json({ user: getSafeUserPayload(req.user) });
};

const logout = async (req, res, next) => {
  try {
    const token = req.session?.token || req.cookies?.[config.session.cookieName];

    if (token) {
      await deleteSessionByToken(token);
    }

    clearAuthCookie(res);

    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  startInstagramAuth,
  handleInstagramCallback,
  getCurrentUser,
  logout
};
