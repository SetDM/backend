const config = require('../config/environment');
const logger = require('../utils/logger');

const HEADER_NAME = 'x-admin-token';

const requirePromptAdmin = (req, res, next) => {
  if (!config.promptAdminToken) {
    logger.warn('Prompt admin token is not configured.');
    return res.status(500).json({ message: 'Prompt admin token not configured on server' });
  }

  const providedToken = req.header(HEADER_NAME) || req.query.token;

  if (!providedToken || providedToken !== config.promptAdminToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  return next();
};

module.exports = requirePromptAdmin;
