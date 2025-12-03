const path = require('path');
const dotenv = require('dotenv');

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const parseScopes = (value = '') =>
  value
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);

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
    model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
    temperature: Number(process.env.OPENAI_TEMPERATURE) || 0.7,
    maxTokens: Number(process.env.OPENAI_MAX_TOKENS) || 500
  },
  promptAdminToken: process.env.PROMPT_ADMIN_TOKEN || ''
};

module.exports = config;
