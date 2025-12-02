const axios = require('axios');
const logger = require('../utils/logger');

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
  
  const payload = {
    recipient: { id: recipientUserId },
    message: { text }
  };

  try {
    const response = await axios.request({
      url: endpoint,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      data: payload
    });

    logger.info('Instagram message sent successfully', { recipientUserId });
    return response.data;
  } catch (error) {
    const errorPayload = error.response?.data || error.message;
    logger.error('Error sending Instagram message', {
      recipientUserId,
      status: error.response?.status,
      payload: errorPayload
    });
    throw error;
  }
};

module.exports = {
  sendInstagramTextMessage
};
