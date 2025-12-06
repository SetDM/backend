const splitMessageByGaps = (message = '') => {
  if (!message) {
    return [];
  }

  return message
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
};

const stripTrailingStageTag = (text = '') => {
  if (!text) {
    return '';
  }

  return text.replace(/\s*\[tag:[^\]]+\]\s*$/i, '').trim();
};

module.exports = {
  splitMessageByGaps,
  stripTrailingStageTag
};
