const http = require('http');

const createApp = require('./app');
const config = require('./config/environment');
const logger = require('./utils/logger');
const { connectToDatabase, disconnectFromDatabase } = require('./database/mongo');

const app = createApp();
const server = http.createServer(app);

const startServer = async () => {
  try {
    await connectToDatabase();
    server.listen(config.port, () => {
      logger.info(`Server listening on port ${config.port} (${config.nodeEnv})`);
    });
  } catch (error) {
    logger.error('Server startup failed', error);
    process.exit(1);
  }
};

startServer();

const shutdown = (signal) => {
  logger.info(`Received ${signal}. Closing server...`);
  server.close(async () => {
    try {
      await disconnectFromDatabase();
    } catch (error) {
      logger.error('Error while closing MongoDB connection', error);
    }
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
