const config = require('../config/environment');

let fetchImpl;
const fetch = async (...args) => {
  if (!fetchImpl) {
    const mod = await import('node-fetch');
    fetchImpl = mod.default;
  }

  return fetchImpl(...args);
};

const ensureConfigured = () => {
  if (!config.instagram.appId || !config.instagram.appSecret) {
    const error = new Error('Instagram OAuth is not configured.');
    error.statusCode = 500;
    throw error;
  }
};

const getMetaGraphBaseUrl = () => (config.metaGraphApiBase || 'https://graph.instagram.com/v24.0').replace(/\/$/, '');

const resolveRedirectUri = (overrideRedirectUri) => {
  return overrideRedirectUri || config.instagram.redirectUri;
};

const buildAuthorizationUrl = ({ state, redirectUri } = {}) => {
  ensureConfigured();

  const resolvedRedirectUri = resolveRedirectUri(redirectUri);

  if (!resolvedRedirectUri) {
    const error = new Error('Instagram redirect URI is not configured.');
    error.statusCode = 500;
    throw error;
  }

  const params = new URLSearchParams({
    client_id: config.instagram.appId,
    redirect_uri: resolvedRedirectUri,
    scope: config.instagram.scopes.join(','),
    response_type: 'code'
  });

  if (state) {
    params.append('state', state);
  }

  return `${config.instagram.oauthUrl}?${params.toString()}`;
};

const exchangeCodeForToken = async ({ code, redirectUri } = {}) => {
  ensureConfigured();

  const resolvedRedirectUri = resolveRedirectUri(redirectUri);

  if (!resolvedRedirectUri) {
    const error = new Error('Instagram redirect URI is not configured.');
    error.statusCode = 500;
    throw error;
  }

  const body = new URLSearchParams({
    client_id: config.instagram.appId,
    client_secret: config.instagram.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: resolvedRedirectUri,
    code
  });

  const response = await fetch(config.instagram.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    const error = new Error(`Instagram token exchange failed: ${errorPayload}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
};

const exchangeForLongLivedToken = async (shortLivedToken) => {
  ensureConfigured();

  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: config.instagram.appSecret,
    access_token: shortLivedToken
  });

  const response = await fetch(`${config.instagram.graphApiBase}/access_token?${params.toString()}`);

  if (!response.ok) {
    const errorPayload = await response.text();
    const error = new Error(`Instagram long-lived token exchange failed: ${errorPayload}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
};

const fetchUserProfile = async (accessToken) => {
  const params = new URLSearchParams({
    fields: 'user_id,username,account_type',
    access_token: accessToken
  });

  const response = await fetch(`${config.instagram.graphApiBase}/me?${params.toString()}`);

  if (!response.ok) {
    const errorPayload = await response.text();
    const error = new Error(`Instagram profile lookup failed: ${errorPayload}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
};

const getConversationIdForUser = async ({ instagramBusinessId, userId, accessToken }) => {
  if (!instagramBusinessId || !userId || !accessToken) {
    throw new Error('Missing parameters for conversation lookup.');
  }

  const params = new URLSearchParams({
    user_id: userId,
    access_token: accessToken
  });

  const url = `${getMetaGraphBaseUrl()}/${instagramBusinessId}/conversations?${params.toString()}`;
  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error('Failed to fetch Instagram conversation list.');
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return payload?.data?.[0]?.id || null;
};

const getConversationMessages = async ({ conversationId, accessToken }) => {
  if (!conversationId || !accessToken) {
    throw new Error('Missing parameters for conversation messages lookup.');
  }

  const params = new URLSearchParams({
    fields: 'messages{from,to,text,created_time,id}',
    access_token: accessToken
  });

  const url = `${getMetaGraphBaseUrl()}/${conversationId}?${params.toString()}`;
  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error('Failed to fetch Instagram conversation messages.');
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return payload?.messages?.data || [];
};

const subscribeAppToUser = async ({ instagramBusinessId, accessToken, fields = ['comments', 'messages'] }) => {
  if (!instagramBusinessId || !accessToken) {
    throw new Error('Missing parameters for Instagram subscription.');
  }

  const params = new URLSearchParams({
    subscribed_fields: fields.join(','),
    access_token: accessToken
  });

  const url = `${getMetaGraphBaseUrl()}/${instagramBusinessId}/subscribed_apps?${params.toString()}`;
  const response = await fetch(url, { method: 'POST' });
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error('Failed to subscribe Instagram app to user events.');
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return payload;
};

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchUserProfile,
  getConversationIdForUser,
  getConversationMessages,
  subscribeAppToUser
};
