const path = require('path');
const dotenv = require('dotenv');

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const parseList = (value = '') =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const parseScopes = (value = '') => parseList(value);

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  logFormat: process.env.LOG_FORMAT || 'dev',
  mongo: {
    uri: process.env.MONGO_URI || '',
    dbName: process.env.MONGO_DB_NAME || 'setdm'
  },
  metaGraphApiBase: process.env.META_GRAPH_API_BASE || 'https://graph.instagram.com/v24.0',
  instagram: {
    appId: process.env.INSTAGRAM_APP_ID || '',
    appSecret: process.env.INSTAGRAM_APP_SECRET || '',
    redirectUri:
      process.env.INSTAGRAM_REDIRECT_URI || 'http://localhost:3000/api/auth/instagram/callback',
    scopes: parseScopes(process.env.INSTAGRAM_SCOPES || 'user_profile'),
    oauthUrl: process.env.INSTAGRAM_OAUTH_URL || 'https://api.instagram.com/oauth/authorize',
    tokenUrl: process.env.INSTAGRAM_TOKEN_URL || 'https://api.instagram.com/oauth/access_token',
    graphApiBase: process.env.INSTAGRAM_GRAPH_API_BASE || 'https://graph.instagram.com',
    webhookVerifyToken: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || ''
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature:
      process.env.OPENAI_TEMPERATURE && !Number.isNaN(Number(process.env.OPENAI_TEMPERATURE))
        ? Number(process.env.OPENAI_TEMPERATURE)
        : undefined
  },
  responses: {
    maxMessageParts:
      process.env.AI_MAX_MESSAGE_PARTS && !Number.isNaN(Number(process.env.AI_MAX_MESSAGE_PARTS))
        ? Number(process.env.AI_MAX_MESSAGE_PARTS)
        : 3,
    replyDelay: (() => {
      const parseNumber = (value) => (value && !Number.isNaN(Number(value)) ? Number(value) : null);

      const minSeconds = parseNumber(process.env.AI_REPLY_DELAY_MIN_SECONDS) ?? 60;
      const maxSeconds = parseNumber(process.env.AI_REPLY_DELAY_MAX_SECONDS) ?? 240;
      const skipMinutes = parseNumber(process.env.AI_REPLY_DELAY_SKIP_IF_OLDER_MINUTES) ?? 4;

      const minMs = Math.max(0, minSeconds) * 1000;
      const maxMs = Math.max(minMs, Math.max(0, maxSeconds) * 1000);
      const skipIfOlderMs = Math.max(maxMs, Math.max(0, skipMinutes) * 60 * 1000);

      return {
        minMs,
        maxMs,
        skipIfLastReplyOlderThanMs: skipIfOlderMs
      };
    })()
  },
  session: (() => {
    const days = Number(process.env.SESSION_MAX_AGE_DAYS);
    const maxAgeMs = Number.isFinite(days) ? Math.max(1, days) * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;

    return {
      cookieName: process.env.SESSION_COOKIE_NAME || 'setdm_session',
      maxAgeMs,
      sameSite: (process.env.SESSION_COOKIE_SAMESITE || 'lax').toLowerCase(),
      secure:
        typeof process.env.SESSION_COOKIE_SECURE === 'string'
          ? process.env.SESSION_COOKIE_SECURE === 'true'
          : (process.env.NODE_ENV || 'development') === 'production',
      domain: process.env.SESSION_COOKIE_DOMAIN || undefined
    };
  })(),
  auth: {
    frontendAppUrl: process.env.FRONTEND_APP_URL || 'http://localhost:8080',
    successRedirectUrl:
      process.env.AUTH_SUCCESS_REDIRECT_URL || process.env.FRONTEND_APP_URL || 'http://localhost:8080',
    failureRedirectUrl:
      process.env.AUTH_FAILURE_REDIRECT_URL || process.env.FRONTEND_APP_URL || 'http://localhost:8080/login?error=auth'
  },
  cors: {
    allowedOrigins: (() => {
      const envList = parseList(process.env.CORS_ALLOWED_ORIGINS || '');
      const defaults = parseList(
        [process.env.FRONTEND_APP_URL, 'http://localhost:8080']
          .filter(Boolean)
          .join(',')
      );

      if (envList.length) {
        return envList;
      }
      return Array.from(new Set(defaults));
    })()
  },
  promptAdminToken: process.env.PROMPT_ADMIN_TOKEN || ''
};

module.exports = config;
