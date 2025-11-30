const http = require('http');

const createApp = require('./app');
const config = require('./config/environment');
const logger = require('./utils/logger');

const app = createApp();
const server = http.createServer(app);

server.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port} (${config.nodeEnv})`);
});

const shutdown = (signal) => {
  logger.info(`Received ${signal}. Closing server...`);
  server.close(() => {
    logger.info('Server closed gracefully');
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});
