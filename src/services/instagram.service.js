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
  if (!config.instagram.appId || !config.instagram.appSecret || !config.instagram.redirectUri) {
    const error = new Error('Instagram OAuth is not configured.');
    error.statusCode = 500;
    throw error;
  }
};

const buildAuthorizationUrl = (state) => {
  if (!config.instagram.appId || !config.instagram.redirectUri) {
    const error = new Error('Instagram OAuth is not configured.');
    error.statusCode = 500;
    throw error;
  }

  const params = new URLSearchParams({
    client_id: config.instagram.appId,
    redirect_uri: config.instagram.redirectUri,
    scope: config.instagram.scopes.join(','),
    response_type: 'code'
  });

  if (state) {
    params.append('state', state);
  }

  return `${config.instagram.oauthUrl}?${params.toString()}`;
};

const exchangeCodeForToken = async (code) => {
  ensureConfigured();

  const body = new URLSearchParams({
    client_id: config.instagram.appId,
    client_secret: config.instagram.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: config.instagram.redirectUri,
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

const sendDirectMessage = async ({ recipientId, message, accessToken }) => {
  if (!config.instagram.businessAccountId) {
    const error = new Error('Instagram business account id is not configured.');
    error.statusCode = 500;
    throw error;
  }

  if (!recipientId || !message || !accessToken) {
    const error = new Error('recipientId, message, and accessToken are required to send a DM.');
    error.statusCode = 400;
    throw error;
  }

  const endpoint = `${config.instagram.metaGraphBase}/${config.instagram.graphApiVersion}/${config.instagram.businessAccountId}/messages`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_type: 'RESPONSE',
      recipient: { id: recipientId },
      message: { text: message },
      access_token: accessToken
    })
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    const error = new Error(`Instagram DM send failed: ${errorPayload}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
};

const fetchUserProfile = async (accessToken) => {
  const params = new URLSearchParams({
    fields: 'id,username,account_type',
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

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchUserProfile,
  sendDirectMessage
};
