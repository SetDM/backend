const { Queue, Worker } = require("bullmq");
const config = require("../config/environment");
const logger = require("../utils/logger");
const { sendInstagramTextMessage } = require("./instagram-messaging.service");
const { removeQueuedConversationMessage, getConversationAutopilotStatus, storeMessage } = require("./conversation.service");

const QUEUE_NAME = "delayed-messages";

let messageQueue = null;
let messageWorker = null;

/**
 * Get Redis connection options for BullMQ
 */
const getRedisConnection = () => {
    if (!config.redis?.url) {
        return null;
    }

    try {
        const url = new URL(config.redis.url);
        const isTLS = url.protocol === "rediss:";

        const connection = {
            host: url.hostname,
            port: parseInt(url.port, 10) || 6379,
            password: url.password || undefined,
            username: url.username || undefined,
            // Required for BullMQ
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            // Render-friendly connection settings
            connectTimeout: 10000,
            keepAlive: 30000,
            retryStrategy: (times) => {
                if (times > 10) {
                    logger.warn("BullMQ Redis connection failed after 10 retries, disabling queue");
                    return null;
                }
                const delay = Math.min(times * 500, 3000);
                return delay;
            },
        };

        // Handle TLS for Render Redis (rediss:// URLs)
        if (isTLS) {
            connection.tls = { rejectUnauthorized: false };
        }

        return connection;
    } catch (error) {
        logger.error("Failed to parse Redis URL for BullMQ", { error: error.message });
        return null;
    }
};

/**
 * Initialize the BullMQ queue
 */
const initializeMessageQueue = async () => {
    const connection = getRedisConnection();

    if (!connection) {
        logger.info("Redis not configured; delayed message queue disabled (using in-memory fallback)");
        return null;
    }

    try {
        messageQueue = new Queue(QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 1000,
                },
                removeOnComplete: {
                    age: 3600, // Keep completed jobs for 1 hour
                    count: 1000, // Keep last 1000 completed jobs
                },
                removeOnFail: {
                    age: 86400, // Keep failed jobs for 24 hours
                },
            },
        });

        await messageQueue.waitUntilReady();
        logger.info("BullMQ message queue initialized");
        return messageQueue;
    } catch (error) {
        logger.error("Failed to initialize BullMQ queue", { error: error.message });
        messageQueue = null;
        return null;
    }
};

/**
 * Initialize the worker that processes delayed messages
 */
const initializeMessageWorker = async () => {
    const connection = getRedisConnection();

    if (!connection) {
        return null;
    }

    try {
        messageWorker = new Worker(
            QUEUE_NAME,
            async (job) => {
                const { senderId, businessAccountId, instagramBusinessId, accessToken, queuedMessageId, content, chunkIndex, chunkTotal } = job.data;

                const logContext = {
                    jobId: job.id,
                    senderId,
                    businessAccountId,
                    queuedMessageId,
                    chunkIndex,
                };

                logger.info("Processing delayed message job", logContext);

                // Check if autopilot is still enabled
                const autopilotEnabled = await getConversationAutopilotStatus(senderId, businessAccountId);
                if (!autopilotEnabled) {
                    logger.info("Autopilot disabled; skipping delayed message send", logContext);
                    return { skipped: true, reason: "autopilot_disabled" };
                }

                // Remove from MongoDB queue - if already removed (user sent manually), skip
                const removed = await removeQueuedConversationMessage({
                    senderId,
                    recipientId: businessAccountId,
                    queuedMessageId,
                });

                if (!removed) {
                    logger.info("Message already sent/removed from queue; skipping", logContext);
                    return { skipped: true, reason: "already_removed" };
                }

                // Send the message via Instagram
                const sendResult = await sendInstagramTextMessage({
                    instagramBusinessId,
                    recipientUserId: senderId,
                    text: content,
                    accessToken,
                });

                const instagramMessageId = sendResult?.message_id || null;

                // Store the message in conversation history
                const messageMetadata = {
                    source: "ai",
                    chunkIndex,
                    chunkTotal,
                };

                if (instagramMessageId) {
                    messageMetadata.mid = instagramMessageId;
                    messageMetadata.instagramMessageId = instagramMessageId;
                }

                try {
                    await storeMessage(senderId, businessAccountId, content, "assistant", messageMetadata, {
                        isAiGenerated: true,
                    });
                } catch (storeError) {
                    logger.error("Failed to store AI response after delayed send", {
                        ...logContext,
                        error: storeError.message,
                    });
                }

                logger.info("Delayed message sent successfully", {
                    ...logContext,
                    instagramMessageId,
                });

                return { sent: true, instagramMessageId };
            },
            {
                connection,
                concurrency: 5, // Process up to 5 messages concurrently
            }
        );

        messageWorker.on("completed", (job, result) => {
            if (result?.sent) {
                logger.debug("Delayed message job completed", { jobId: job.id });
            }
        });

        messageWorker.on("failed", (job, err) => {
            logger.error("Delayed message job failed", {
                jobId: job?.id,
                error: err.message,
                data: job?.data,
            });
        });

        messageWorker.on("error", (err) => {
            logger.error("Message worker error", { error: err.message });
        });

        logger.info("BullMQ message worker initialized");
        return messageWorker;
    } catch (error) {
        logger.error("Failed to initialize BullMQ worker", { error: error.message });
        messageWorker = null;
        return null;
    }
};

/**
 * Add a delayed message to the queue
 * @param {Object} options
 * @param {string} options.senderId - Instagram user ID (recipient)
 * @param {string} options.businessAccountId - Business account ID
 * @param {string} options.instagramBusinessId - Instagram business ID for sending
 * @param {string} options.accessToken - Instagram access token
 * @param {string} options.queuedMessageId - ID of the MongoDB queue entry
 * @param {string} options.content - Message content
 * @param {number} options.delayMs - Delay before sending (ms)
 * @param {number} options.chunkIndex - Index of this chunk
 * @param {number} options.chunkTotal - Total chunks
 * @returns {Promise<Object|null>} Job info or null if queue unavailable
 */
const addDelayedMessage = async ({ senderId, businessAccountId, instagramBusinessId, accessToken, queuedMessageId, content, delayMs, chunkIndex, chunkTotal }) => {
    if (!messageQueue) {
        return null;
    }

    try {
        const job = await messageQueue.add(
            "send-delayed-message",
            {
                senderId,
                businessAccountId,
                instagramBusinessId,
                accessToken,
                queuedMessageId,
                content,
                chunkIndex,
                chunkTotal,
            },
            {
                delay: delayMs,
                jobId: `${queuedMessageId}-${Date.now()}`, // Unique job ID
            }
        );

        logger.debug("Delayed message job added", {
            jobId: job.id,
            senderId,
            businessAccountId,
            queuedMessageId,
            delayMs,
        });

        return { jobId: job.id };
    } catch (error) {
        logger.error("Failed to add delayed message job", {
            senderId,
            businessAccountId,
            queuedMessageId,
            error: error.message,
        });
        return null;
    }
};

/**
 * Remove a pending delayed message job (e.g., when user sends manually)
 * @param {string} queuedMessageId - The MongoDB queue entry ID
 */
const removeDelayedMessage = async (queuedMessageId) => {
    if (!messageQueue) {
        return false;
    }

    try {
        // Get all delayed jobs and find matching ones
        const delayedJobs = await messageQueue.getDelayed();
        const matchingJobs = delayedJobs.filter((job) => job.data?.queuedMessageId === queuedMessageId);

        for (const job of matchingJobs) {
            await job.remove();
            logger.debug("Removed delayed message job", { jobId: job.id, queuedMessageId });
        }

        return matchingJobs.length > 0;
    } catch (error) {
        logger.error("Failed to remove delayed message job", {
            queuedMessageId,
            error: error.message,
        });
        return false;
    }
};

/**
 * Remove all delayed message jobs for a conversation
 * @param {string} senderId
 * @param {string} businessAccountId
 */
const clearDelayedMessagesForConversation = async (senderId, businessAccountId) => {
    if (!messageQueue) {
        return false;
    }

    try {
        const delayedJobs = await messageQueue.getDelayed();
        const matchingJobs = delayedJobs.filter((job) => job.data?.senderId === senderId && job.data?.businessAccountId === businessAccountId);

        for (const job of matchingJobs) {
            await job.remove();
        }

        if (matchingJobs.length > 0) {
            logger.info("Cleared delayed message jobs for conversation", {
                senderId,
                businessAccountId,
                jobsRemoved: matchingJobs.length,
            });
        }

        return true;
    } catch (error) {
        logger.error("Failed to clear delayed messages for conversation", {
            senderId,
            businessAccountId,
            error: error.message,
        });
        return false;
    }
};

/**
 * Check if BullMQ queue is available
 */
const isQueueAvailable = () => Boolean(messageQueue);

/**
 * Gracefully shutdown the queue and worker
 */
const shutdownMessageQueue = async () => {
    const shutdownPromises = [];

    if (messageWorker) {
        shutdownPromises.push(
            messageWorker.close().catch((err) => {
                logger.warn("Error closing message worker", { error: err.message });
            })
        );
    }

    if (messageQueue) {
        shutdownPromises.push(
            messageQueue.close().catch((err) => {
                logger.warn("Error closing message queue", { error: err.message });
            })
        );
    }

    await Promise.all(shutdownPromises);

    messageWorker = null;
    messageQueue = null;

    logger.info("Message queue shutdown complete");
};

module.exports = {
    initializeMessageQueue,
    initializeMessageWorker,
    addDelayedMessage,
    removeDelayedMessage,
    clearDelayedMessagesForConversation,
    isQueueAvailable,
    shutdownMessageQueue,
};
