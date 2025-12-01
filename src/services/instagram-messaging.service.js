const axios = require('axios');

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

  axios.request(endpoint, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    data: JSON.stringify({
      recipient: { id: recipientUserId },
      message: { text }
    })
  })
  .then((response) => {
    console.log('Instagram message sent successfully:', response.data);
  })
  .catch((error) => {
    console.error('Error sending Instagram message:', error.response ? error.response.data : error.message);
    throw error;
  });
};

module.exports = {
  sendInstagramTextMessage
};
