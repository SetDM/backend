const logger = require('../utils/logger');

// Centralized error handler to ensure consistent responses
function errorHandler(err, req, res) {
  logger.error('Unhandled error', err);
  const statusCode = err.statusCode || 500;
  const response = {
    message: err.message || 'Something went wrong'
  };

  if (process.env.NODE_ENV !== 'production' && err.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
