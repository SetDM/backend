const http = require("http");

const createApp = require("./app");
const config = require("./config/environment");
const logger = require("./utils/logger");
const { connectToDatabase, disconnectFromDatabase } = require("./database/mongo");
const { connectToRedis, disconnectFromRedis } = require("./database/redis");
const { initializeSocketServer, shutdownSocketServer } = require("./realtime/socket-server");
const { initializeMessageQueue, initializeMessageWorker, shutdownMessageQueue } = require("./services/message-queue.service");
const { initializeFollowupQueue, initializeFollowupWorker, shutdownFollowupQueue } = require("./services/followup-scheduler.service");

const app = createApp();
const server = http.createServer(app);

const startServer = async () => {
    try {
        await connectToDatabase();
        await connectToRedis(); // Optional - continues if Redis not configured
        await initializeSocketServer(server);

        // Initialize BullMQ for reliable delayed message processing (optional - falls back to in-memory)
        try {
            await initializeMessageQueue();
            await initializeMessageWorker();
        } catch (bullmqError) {
            logger.warn("BullMQ initialization failed, using in-memory fallback", { error: bullmqError.message });
        }

        // Initialize followup queue for scheduled followup messages
        try {
            await initializeFollowupQueue();
            await initializeFollowupWorker();
        } catch (followupError) {
            logger.warn("Followup queue initialization failed, followups will be disabled", { error: followupError.message });
        }

        server.listen(config.port, () => {
            logger.info(`Server listening on port ${config.port} (${config.nodeEnv})`);
        });
    } catch (error) {
        logger.error("Server startup failed", error);
        process.exit(1);
    }
};

startServer();

const shutdown = (signal) => {
    logger.info(`Received ${signal}. Closing server...`);
    server.close(async () => {
        try {
            await shutdownFollowupQueue(); // Shutdown followup queue before Redis
            await shutdownMessageQueue(); // Shutdown BullMQ before Redis
            await shutdownSocketServer();
            await disconnectFromRedis();
            await disconnectFromDatabase();
        } catch (error) {
            logger.error("Error during graceful shutdown", error);
        }
        logger.info("Server closed gracefully");
        process.exit(0);
    });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error);
    process.exit(1);
});
