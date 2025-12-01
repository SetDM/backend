const config = require('../config/environment');
const logger = require('../utils/logger');

let fetchImpl;
const fetch = async (...args) => {
  if (!fetchImpl) {
    const mod = await import('node-fetch');
    fetchImpl = mod.default;
  }

  return fetchImpl(...args);
};

const TEXT_BYTE_LIMIT = 1000;

const buildMessagesEndpoint = (instagramBusinessId) => {
  const baseUrl = (config.metaGraphApiBase || 'https://graph.instagram.com/v24.0').replace(/\/$/, '');
  return `${baseUrl}/${instagramBusinessId}/messages`;
};

const ensureValidText = (text) => {
  const byteLength = Buffer.byteLength(text || '', 'utf8');
  if (byteLength === 0) {
    const error = new Error('Message text is required.');
    error.statusCode = 400;
    throw error;
  }

  if (byteLength > TEXT_BYTE_LIMIT) {
    const error = new Error(`Message text must be less than ${TEXT_BYTE_LIMIT} bytes.`);
    error.statusCode = 400;
    throw error;
  }
};

const sendInstagramTextMessage = async ({
  instagramBusinessId,
  recipientUserId,
  text,
  accessToken
}) => {
  if (!instagramBusinessId || !recipientUserId || !text || !accessToken) {
    const error = new Error('Missing parameters to send Instagram message.');
    error.statusCode = 400;
    throw error;
  }

  ensureValidText(text);

  const endpoint = buildMessagesEndpoint(instagramBusinessId);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      recipient: { id: recipientUserId },
      message: { text: text }
    })
  });

  if (!response.ok) {
    const payload = await response.text();
    logger.error('Failed to send Instagram message', {
      status: response.status,
      payload
    });
    const error = new Error(`Failed to send Instagram message: ${payload}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
};

module.exports = {
  sendInstagramTextMessage
};
