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

const buildMessagesEndpoint = (instagramBusinessId) => {
  const baseUrl = ('https://graph.instagram.com/v24.0')
  return `${baseUrl}/${instagramBusinessId}/messages`;
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

  const endpoint = buildMessagesEndpoint(instagramBusinessId);

  console.log('Invoking request:', endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      recipient: { id: recipientUserId },
      message: { text }
    })
  })

  fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      recipient: { id: recipientUserId },
      message: { text }
    })
  })
  .then((res) => {
    console.log(res)
    if (!res.ok) {
      throw new Error(`Failed to send Instagram message: ${res.status} ${res.statusText}`);
    }
    return res;
  })
  .then((response) => response.json())
  .then((data) => {
    console.log('Instagram message sent successfully:', data);
  })
  .catch((error) => {
    console.error('Error sending Instagram message:', error);
  });
};

module.exports = {
  sendInstagramTextMessage
};
