const jwt = require('jsonwebtoken');
const config = require('../config/environment');
const { getInstagramUserById } = require('../services/instagram-user.service');
const teamService = require('../services/team.service');

const buildCookieOptions = (overrides = {}) => ({
  httpOnly: true,
  sameSite: config.session.sameSite,
  secure: config.session.secure,
  maxAge: config.session.maxAgeMs,
  path: '/',
  ...(config.session.domain ? { domain: config.session.domain } : {}),
  ...overrides
});

const clearAuthCookie = (res) => {
  res.cookie(
    config.session.cookieName,
    '',
    buildCookieOptions({ maxAge: 0, expires: new Date(0) })
  );
};

const extractToken = (req) => {
  const cookieToken = req.cookies?.[config.session.cookieName];
  if (cookieToken) {
    return cookieToken;
  }

  const headerToken = req.headers.authorization;
  if (typeof headerToken === 'string' && headerToken.startsWith('Bearer ')) {
    return headerToken.slice('Bearer '.length).trim();
  }

  const legacyHeaderToken = req.headers['x-session-token'];
  if (legacyHeaderToken) {
    return legacyHeaderToken;
  }

  return null;
};

const verifyJwt = (token) => {
  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch {
    return null;
  }
};

const attachSession = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      return next();
    }

    const payload = verifyJwt(token);

    if (!payload) {
      clearAuthCookie(res);
      return next();
    }

    // Handle team member tokens
    if (payload.type === 'team_member' && payload.teamMemberId) {
      req.auth = {
        token,
        teamMemberId: payload.teamMemberId,
        workspaceId: payload.workspaceId,
        decoded: payload
      };

      // For team members, load the workspace owner as req.user
      // This allows them to access workspace data
      if (payload.workspaceId) {
        req.user = await getInstagramUserById(payload.workspaceId);
        req.teamMember = await teamService.getTeamMemberById(payload.teamMemberId);
      }

      return next();
    }

    // Handle Instagram user tokens
    if (!payload.instagramId) {
      clearAuthCookie(res);
      return next();
    }

    req.auth = {
      token,
      instagramId: payload.instagramId,
      decoded: payload
    };

    if (!req.user) {
      req.user = await getInstagramUserById(payload.instagramId);
    }

    if (!req.user) {
      clearAuthCookie(res);
    }

    return next();
  } catch {
    clearAuthCookie(res);
    return next();
  }
};

const requireSession = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  return next();
};

module.exports = {
  attachSession,
  requireSession,
  clearAuthCookie,
  buildCookieOptions
};
