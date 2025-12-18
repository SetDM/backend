const jwt = require('jsonwebtoken');
const crypto = require('crypto');
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
  getInstagramUserById,
  unlinkInstagramUser
} = require('../services/instagram-user.service');
const teamService = require('../services/team.service');
const { buildCookieOptions, clearAuthCookie } = require('../middleware/session-auth');

const allowedLoginOrigins = () => new Set((config.cors?.allowedOrigins || []).map((origin) => {
  if (typeof origin !== 'string') {
    return null;
  }

  try {
    const normalized = new URL(origin);
    return normalized.origin;
  } catch {
    return origin.replace(/\/$/, '');
  }
}).filter(Boolean));

const extractRequestOrigin = (req) => {
  const originHeader = req.get('origin');
  if (originHeader) {
    try {
      return new URL(originHeader).origin;
    } catch {
      return null;
    }
  }

  const refererHeader = req.get('referer');
  if (refererHeader) {
    try {
      return new URL(refererHeader).origin;
    } catch {
      return null;
    }
  }

  return null;
};

const assertLoginRequestOriginAllowed = (req) => {
  const requestOrigin = extractRequestOrigin(req);
  const allowedOrigins = allowedLoginOrigins();

  if (allowedOrigins.size === 0) {
    return requestOrigin;
  }

  if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
    const error = new Error('Instagram authentication must be initiated from the SetDM app.');
    error.statusCode = 403;
    throw error;
  }

  return requestOrigin;
};

const createStateToken = (metadata = {}) => {
  if (!config.auth.jwtSecret) {
    throw new Error('AUTH_JWT_SECRET is not configured');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = {
    nonce,
    issuedAt: Date.now(),
    ...metadata
  };

  return jwt.sign(payload, config.auth.jwtSecret, { expiresIn: '10m' });
};

const decodeStateToken = (token) => {
  if (!token || !config.auth.jwtSecret) {
    return null;
  }

  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch (error) {
    logger.warn('Invalid or expired Instagram auth state token', { error: error.message });
    return null;
  }
};

const startInstagramAuth = (req, res, next) => {
  try {
    const requestOrigin = assertLoginRequestOriginAllowed(req);
    const redirectUri = config.instagram.redirectUri;

    if (!redirectUri) {
      const error = new Error('Instagram redirect URI is not configured.');
      error.statusCode = 500;
      throw error;
    }

    const stateToken = createStateToken({ origin: requestOrigin });
    const authorizationUrl = buildAuthorizationUrl({ state: stateToken, redirectUri });
    res.redirect(authorizationUrl);
  } catch (error) {
    logger.error('Failed to initiate Instagram auth', error);
    next(error);
  }
};

const issueAuthToken = ({ instagramId, teamMemberId, workspaceId }) => {
  if (!instagramId && !teamMemberId) {
    throw new Error('instagramId or teamMemberId is required to sign an auth token');
  }

  if (!config.auth.jwtSecret) {
    throw new Error('AUTH_JWT_SECRET is not configured');
  }

  // Team member token
  if (teamMemberId) {
    const payload = {
      sub: teamMemberId,
      teamMemberId,
      workspaceId,
      type: 'team_member'
    };
    return jwt.sign(payload, config.auth.jwtSecret, {
      expiresIn: config.auth.jwtExpiresIn
    });
  }

  // Instagram user token
  const payload = {
    sub: instagramId,
    instagramId,
    type: 'instagram_user'
  };

  return jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn
  });
};

const issueTeamMemberToken = ({ teamMemberId, workspaceId }) => {
  return issueAuthToken({ teamMemberId, workspaceId });
};

const setAuthCookie = (res, token) => {
  res.cookie(config.session.cookieName, token, buildCookieOptions());
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

const appendTokenToUrl = (url, token) => {
  if (!token) {
    return url;
  }

  try {
    const parsedUrl = new URL(url);
    parsedUrl.searchParams.set('token', token);
    return parsedUrl.toString();
  } catch (error) {
    logger.warn('Failed to append token to redirect URL, falling back to naive concatenation', {
      url,
      error: error.message
    });
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }
};

const redirectOrRespond = (res, url, payload, { token } = {}) => {
  if (url) {
    return res.redirect(token ? appendTokenToUrl(url, token) : url);
  }

  return res.json(token ? { ...payload, token } : payload);
};

const handleInstagramCallback = async (req, res, next) => {
  try {
    const { code, error: igError, error_description: errorDescription, state } = req.query;
    const redirectUri = config.instagram.redirectUri;

    if (!redirectUri) {
      const error = new Error('Instagram redirect URI is not configured.');
      error.statusCode = 500;
      throw error;
    }

    if (!state) {
      const error = new Error('Missing OAuth state parameter.');
      error.statusCode = 400;
      throw error;
    }

    const decodedState = decodeStateToken(state);
    if (!decodedState) {
      const error = new Error('Invalid or expired OAuth state parameter.');
      error.statusCode = 400;
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
    const token = issueAuthToken({ instagramId: userRecord.instagramId });
    setAuthCookie(res, token);

    return redirectOrRespond(
      res,
      config.auth.successRedirectUrl,
      {
        message: 'Instagram authentication successful.',
        user: getSafeUserPayload(userRecord)
      },
      { token }
    );
  } catch (error) {
    logger.error('Failed to complete Instagram auth', error);
    if (config.auth.failureRedirectUrl) {
      return res.redirect(config.auth.failureRedirectUrl);
    }
    next(error);
  }
};

const getCurrentUser = async (req, res) => {
  // Check if this is a team member token
  if (req.auth?.decoded?.type === 'team_member' && req.auth?.decoded?.teamMemberId) {
    try {
      const member = await teamService.getTeamMemberById(req.auth.decoded.teamMemberId);
      if (!member) {
        return res.status(401).json({ message: 'Team member not found.' });
      }

      // Get the workspace owner info for context
      const workspace = await getInstagramUserById(member.workspaceId);

      return res.json({
        user: {
          id: member._id.toString(),
          email: member.email,
          name: member.name,
          role: member.role,
          isTeamMember: true,
          workspaceId: member.workspaceId,
          workspaceUsername: workspace?.username || null,
          lastLoginAt: member.lastLoginAt?.toISOString() || null,
        },
        token: req.auth?.token || null
      });
    } catch (error) {
      logger.error('Failed to get team member', { error: error.message });
      return res.status(500).json({ message: 'Failed to get user info.' });
    }
  }

  // Regular Instagram user
  return res.json({
    user: getSafeUserPayload(req.user),
    token: req.auth?.token || null
  });
};

const logout = (req, res, next) => {
  try {
    clearAuthCookie(res);
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
};

const unlinkInstagramAccount = async (req, res, next) => {
  try {
    const instagramId = req.user?.instagramId;

    if (!instagramId) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    await unlinkInstagramUser(instagramId);
    clearAuthCookie(res);

    return res.status(204).send();
  } catch (error) {
    logger.error('Failed to unlink Instagram account', {
      instagramId: req.user?.instagramId,
      error: error.message
    });
    return next(error);
  }
};

module.exports = {
  startInstagramAuth,
  handleInstagramCallback,
  getCurrentUser,
  logout,
  unlinkInstagramAccount,
  issueTeamMemberToken,
  setAuthCookie
};
