const config = require('../config/environment');

let fetchImpl;
const fetch = async (...args) => {
  if (!fetchImpl) {
    const mod = await import('node-fetch');
    fetchImpl = mod.default;
  }

  return fetchImpl(...args);
};

const DEFAULT_WEB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36';

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

const fetchInstagramProfileById = async ({ instagramId, accessToken, fields }) => {
  if (!instagramId || !accessToken) {
    throw new Error('Missing parameters for Instagram profile lookup.');
  }

  const resolvedFields = Array.isArray(fields) && fields.length > 0
    ? fields.join(',')
    : 'name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user';

  const params = new URLSearchParams({
    fields: resolvedFields,
    access_token: accessToken
  });

  const url = `${getMetaGraphBaseUrl()}/${instagramId}?${params.toString()}`;
  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error('Failed to fetch Instagram user profile.');
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return payload;
};

const safeJsonParse = (value) => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

const decodeJsonString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const normalized = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return JSON.parse(`"${normalized}"`);
  } catch (error) {
    return value;
  }
};

const extractBioFromNextData = (html) => {
  const match = html.match(/<script type="application\/json" id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    return null;
  }

  const payload = safeJsonParse(match[1]);
  if (!payload) {
    return null;
  }

  const candidates = [
    payload?.props?.pageProps?.profileGridData?.userInfo?.biography,
    payload?.props?.pageProps?.userInfo?.biography,
    payload?.props?.pageProps?.user?.biography
  ];

  return candidates.find((bio) => typeof bio === 'string' && bio.length) || null;
};

const extractBioFromSharedData = (html) => {
  const match = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (!match) {
    return null;
  }

  const payload = safeJsonParse(match[1]);
  if (!payload) {
    return null;
  }

  return (
    payload?.entry_data?.ProfilePage?.[0]?.graphql?.user?.biography ||
    payload?.entry_data?.ProfilePage?.[0]?.user?.biography ||
    null
  );
};

const extractBioFallback = (html) => {
  const match = html.match(/"biography":"(.*?)"/);
  if (!match) {
    return null;
  }

  return decodeJsonString(match[1]);
};

const extractInstagramBioFromHtml = (html) => {
  if (typeof html !== 'string' || !html.trim()) {
    return null;
  }

  return (
    extractBioFromNextData(html) || extractBioFromSharedData(html) || extractBioFallback(html)
  );
};

const fetchInstagramBioByUsername = async (username) => {
  const normalizedUsername = String(username || '')
    .trim()
    .replace(/^@+/, '');

  if (!normalizedUsername) {
    const error = new Error('username is required to fetch Instagram bio.');
    error.statusCode = 400;
    throw error;
  }

  const url = `https://www.instagram.com/${encodeURIComponent(normalizedUsername)}/`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_WEB_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml'
    }
  });

  if (response.status === 404) {
    const error = new Error('Instagram profile not found.');
    error.statusCode = 404;
    throw error;
  }

  if (!response.ok) {
    const error = new Error('Failed to load Instagram profile page.');
    error.statusCode = response.status;
    throw error;
  }

  const html = await response.text();
  const biography = extractInstagramBioFromHtml(html);

  if (typeof biography !== 'string') {
    const error = new Error('Unable to extract biography from Instagram profile page.');
    error.statusCode = 502;
    throw error;
  }

  return {
    username: normalizedUsername,
    biography
  };
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
  fetchInstagramProfileById,
  fetchInstagramBioByUsername,
  getConversationIdForUser,
  getConversationMessages,
  subscribeAppToUser
};
