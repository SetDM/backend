const config = require('../config/environment');
const {
  getSessionByToken,
  deleteSessionByToken
} = require('../services/session.service');
const { getInstagramUserById } = require('../services/instagram-user.service');

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

const attachSession = async (req, res, next) => {
  try {
    const token = req.cookies?.[config.session.cookieName] || req.headers['x-session-token'];

    if (!token) {
      return next();
    }

    const session = await getSessionByToken(token);

    if (!session || (session.expiresAt && new Date(session.expiresAt) < new Date())) {
      await deleteSessionByToken(token);
      clearAuthCookie(res);
      return next();
    }

    req.session = {
      token,
      expiresAt: session.expiresAt,
      instagramId: session.instagramId
    };

    if (!req.user && session.instagramId) {
      req.user = await getInstagramUserById(session.instagramId);
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

const requireSession = (req, res, next) => {
  if (!req.user || !req.session) {
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
