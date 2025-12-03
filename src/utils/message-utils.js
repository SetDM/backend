const splitMessageByGaps = (message = '') => {
  if (!message) {
    return [];
  }

  const parts = message
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return parts;
  }

  return parts;
};

module.exports = {
  splitMessageByGaps
};
