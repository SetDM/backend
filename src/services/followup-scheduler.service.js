/**
 * Followup Scheduler Service
 *
 * Handles scheduling, cancelling, and tracking of followup messages.
 * Followups are triggered when a user doesn't reply after AI sends a message.
 *
 * Flow:
 * 1. AI sends message → scheduleFollowupSequence() schedules first followup
 * 2. User doesn't reply → followup job fires → sendFollowup() sends message
 * 3. After sending → schedule next followup if exists
 * 4. User replies → cancelPendingFollowups() cancels all scheduled followups
 */

const { Queue, Worker } = require("bullmq");
const config = require("../config/environment");
const logger = require("../utils/logger");
const { sendInstagramTextMessage } = require("./instagram-messaging.service");
const { getConversationAutopilotStatus, storeMessage, getConversationStageTag, getFollowupState, updateFollowupState, clearFollowupState } = require("./conversation.service");
const { getPromptByWorkspace } = require("./prompt.service");
const { getInstagramUserById } = require("./instagram-user.service");

const FOLLOWUP_QUEUE_NAME = "followup-messages";

// Maximum delay for followups (Instagram 24-hour messaging window)
const MAX_FOLLOWUP_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

let followupQueue = null;
let followupWorker = null;

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
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            connectTimeout: 10000,
            keepAlive: 60000, // Reduced from 30s to save Redis commands
            retryStrategy: (times) => {
                if (times > 10) {
                    logger.warn("Followup queue Redis connection failed after 10 retries");
                    return null;
                }
                return Math.min(times * 500, 3000);
            },
        };

        if (isTLS) {
            connection.tls = { rejectUnauthorized: false };
        }

        return connection;
    } catch (error) {
        logger.error("Failed to parse Redis URL for followup queue", { error: error.message });
        return null;
    }
};

/**
 * Initialize the followup queue
 */
const initializeFollowupQueue = async () => {
    const connection = getRedisConnection();

    if (!connection) {
        logger.info("Redis not configured; followup scheduling disabled");
        return null;
    }

    try {
        followupQueue = new Queue(FOLLOWUP_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 2000,
                },
                removeOnComplete: {
                    age: 3600,
                    count: 500,
                },
                removeOnFail: {
                    age: 86400,
                },
            },
        });

        await followupQueue.waitUntilReady();
        logger.info("Followup queue initialized");
        return followupQueue;
    } catch (error) {
        logger.error("Failed to initialize followup queue", { error: error.message });
        followupQueue = null;
        return null;
    }
};

/**
 * Map stage tag to sequence key used in prompt config
 */
const stageToSequenceKey = (stageTag) => {
    const normalized = (stageTag || "").toLowerCase().replace(/[-_\s]+/g, "-");

    switch (normalized) {
        case "lead":
            return "lead";
        case "qualified":
            return "qualification";
        case "booking-sent":
            return "booking";
        case "call-booked":
            return "callBooked";
        default:
            // For "responded" or unknown stages, use lead sequence
            return "lead";
    }
};

/**
 * Get followup configuration for a workspace and stage
 */
const getFollowupsForStage = async (workspaceId, stageTag) => {
    try {
        const promptDoc = await getPromptByWorkspace(workspaceId);

        if (!promptDoc?.config?.sequences) {
            return [];
        }

        const sequenceKey = stageToSequenceKey(stageTag);
        const sequence = promptDoc.config.sequences[sequenceKey];

        if (!sequence?.followups || !Array.isArray(sequence.followups)) {
            return [];
        }

        return sequence.followups.filter((f) => f && f.content && f.content.trim());
    } catch (error) {
        logger.error("Failed to get followups for stage", {
            workspaceId,
            stageTag,
            error: error.message,
        });
        return [];
    }
};

/**
 * Calculate delay in milliseconds from followup config
 */
const calculateDelayMs = (followup) => {
    const value = parseInt(followup.delayValue, 10) || 1;
    const unit = followup.delayUnit || "hours";

    let delayMs;
    if (unit === "minutes") {
        delayMs = value * 60 * 1000;
    } else {
        delayMs = value * 60 * 60 * 1000;
    }

    // Cap at 24 hours (Instagram messaging window)
    return Math.min(delayMs, MAX_FOLLOWUP_DELAY_MS);
};

/**
 * Schedule the next followup in a sequence
 *
 * @param {Object} options
 * @param {string} options.senderId - Instagram user ID (recipient of followup)
 * @param {string} options.businessAccountId - Business account ID
 * @param {string} options.workspaceId - Workspace ID (usually same as businessAccountId)
 * @param {string} options.stageTag - Current conversation stage
 * @param {number} options.followupIndex - Which followup in sequence (0-based)
 * @param {string} options.accessToken - Instagram access token
 * @param {string} options.instagramBusinessId - Instagram business ID for sending
 */
const scheduleNextFollowup = async ({ senderId, businessAccountId, workspaceId, stageTag, followupIndex = 0, accessToken, instagramBusinessId }) => {
    if (!followupQueue) {
        logger.debug("Followup queue not available; skipping followup scheduling");
        return null;
    }

    const followups = await getFollowupsForStage(workspaceId, stageTag);

    if (!followups.length || followupIndex >= followups.length) {
        logger.debug("No more followups to schedule", {
            senderId,
            businessAccountId,
            stageTag,
            followupIndex,
            totalFollowups: followups.length,
        });

        // Clear followup state since sequence is complete
        await clearFollowupState(senderId, businessAccountId);
        return null;
    }

    const followup = followups[followupIndex];
    const delayMs = calculateDelayMs(followup);
    const sequenceKey = stageToSequenceKey(stageTag);

    const jobId = `followup-${businessAccountId}-${senderId}-${Date.now()}`;

    try {
        const job = await followupQueue.add(
            "send-followup",
            {
                senderId,
                businessAccountId,
                workspaceId,
                stageTag,
                sequenceKey,
                followupIndex,
                content: followup.content,
                accessToken,
                instagramBusinessId,
            },
            {
                delay: delayMs,
                jobId,
            }
        );

        // Update followup state in conversation
        await updateFollowupState(senderId, businessAccountId, {
            sequenceKey,
            followupIndex,
            pendingJobId: job.id,
            scheduledFor: new Date(Date.now() + delayMs),
            isActive: true,
        });

        logger.info("Scheduled followup message", {
            jobId: job.id,
            senderId,
            businessAccountId,
            stageTag,
            sequenceKey,
            followupIndex,
            delayMs,
            scheduledFor: new Date(Date.now() + delayMs).toISOString(),
        });

        return { jobId: job.id, delayMs };
    } catch (error) {
        logger.error("Failed to schedule followup", {
            senderId,
            businessAccountId,
            stageTag,
            followupIndex,
            error: error.message,
        });
        return null;
    }
};

/**
 * Start the followup sequence for a conversation after AI sends a message
 *
 * @param {Object} options
 * @param {string} options.senderId - Instagram user ID
 * @param {string} options.businessAccountId - Business account ID
 */
const scheduleFollowupSequence = async ({ senderId, businessAccountId }) => {
    if (!followupQueue) {
        return null;
    }

    try {
        // Get current stage tag
        const stageTag = await getConversationStageTag(senderId, businessAccountId);

        // Get business account for access token
        const businessAccount = await getInstagramUserById(businessAccountId);
        if (!businessAccount?.tokens?.longLived?.accessToken) {
            logger.warn("No access token available for followup scheduling", {
                senderId,
                businessAccountId,
            });
            return null;
        }

        // Cancel any existing pending followups first
        await cancelPendingFollowups(senderId, businessAccountId);

        // Schedule the first followup (index 0)
        return await scheduleNextFollowup({
            senderId,
            businessAccountId,
            workspaceId: businessAccountId,
            stageTag: stageTag || "responded",
            followupIndex: 0,
            accessToken: businessAccount.tokens.longLived.accessToken,
            instagramBusinessId: businessAccount.instagramId,
        });
    } catch (error) {
        logger.error("Failed to start followup sequence", {
            senderId,
            businessAccountId,
            error: error.message,
        });
        return null;
    }
};

/**
 * Cancel all pending followups for a conversation
 * Called when user replies or autopilot is disabled
 */
const cancelPendingFollowups = async (senderId, businessAccountId) => {
    if (!followupQueue) {
        return false;
    }

    try {
        // Get the pending job ID from conversation state
        const followupState = await getFollowupState(senderId, businessAccountId);

        if (followupState?.pendingJobId) {
            // Try to remove the specific job
            const job = await followupQueue.getJob(followupState.pendingJobId);
            if (job) {
                const state = await job.getState();
                if (state === "delayed" || state === "waiting") {
                    await job.remove();
                    logger.info("Cancelled pending followup job", {
                        jobId: followupState.pendingJobId,
                        senderId,
                        businessAccountId,
                    });
                }
            }
        }

        // Also search for any other jobs for this conversation (belt and suspenders)
        const delayedJobs = await followupQueue.getDelayed();
        const matchingJobs = delayedJobs.filter((job) => job.data?.senderId === senderId && job.data?.businessAccountId === businessAccountId);

        for (const job of matchingJobs) {
            await job.remove();
        }

        if (matchingJobs.length > 0) {
            logger.info("Cleared additional followup jobs for conversation", {
                senderId,
                businessAccountId,
                jobsRemoved: matchingJobs.length,
            });
        }

        // Clear the followup state
        await clearFollowupState(senderId, businessAccountId);

        return true;
    } catch (error) {
        logger.error("Failed to cancel pending followups", {
            senderId,
            businessAccountId,
            error: error.message,
        });
        return false;
    }
};

/**
 * Initialize the worker that processes followup jobs
 */
const initializeFollowupWorker = async () => {
    const connection = getRedisConnection();

    if (!connection) {
        return null;
    }

    try {
        followupWorker = new Worker(
            FOLLOWUP_QUEUE_NAME,
            async (job) => {
                const { senderId, businessAccountId, workspaceId, stageTag, sequenceKey, followupIndex, content, accessToken, instagramBusinessId } = job.data;

                const logContext = {
                    jobId: job.id,
                    senderId,
                    businessAccountId,
                    sequenceKey,
                    followupIndex,
                };

                logger.info("Processing followup job", logContext);

                // Check if autopilot is still enabled
                const autopilotEnabled = await getConversationAutopilotStatus(senderId, businessAccountId);
                if (!autopilotEnabled) {
                    logger.info("Autopilot disabled; skipping followup", logContext);
                    await clearFollowupState(senderId, businessAccountId);
                    return { skipped: true, reason: "autopilot_disabled" };
                }

                // Check if followup state is still active (user hasn't replied)
                const followupState = await getFollowupState(senderId, businessAccountId);
                if (!followupState?.isActive) {
                    logger.info("Followup state not active; user may have replied", logContext);
                    return { skipped: true, reason: "followup_inactive" };
                }

                // Verify this is still the expected job (in case of race conditions)
                if (followupState.pendingJobId && followupState.pendingJobId !== job.id) {
                    logger.info("Job ID mismatch; newer followup scheduled", {
                        ...logContext,
                        expectedJobId: followupState.pendingJobId,
                    });
                    return { skipped: true, reason: "job_superseded" };
                }

                // Check current stage - if it changed, we might need different followups
                const currentStage = await getConversationStageTag(senderId, businessAccountId);
                const currentSequenceKey = stageToSequenceKey(currentStage);

                // If stage changed, start new sequence for new stage
                if (currentSequenceKey !== sequenceKey) {
                    logger.info("Stage changed during followup delay; restarting sequence", {
                        ...logContext,
                        oldSequenceKey: sequenceKey,
                        newSequenceKey: currentSequenceKey,
                        newStageTag: currentStage,
                    });

                    // Get business account for fresh token
                    const businessAccount = await getInstagramUserById(businessAccountId);
                    if (businessAccount?.tokens?.longLived?.accessToken) {
                        await scheduleNextFollowup({
                            senderId,
                            businessAccountId,
                            workspaceId,
                            stageTag: currentStage,
                            followupIndex: 0,
                            accessToken: businessAccount.tokens.longLived.accessToken,
                            instagramBusinessId: businessAccount.instagramId,
                        });
                    }

                    return { skipped: true, reason: "stage_changed" };
                }

                // Send the followup message
                try {
                    const sendResult = await sendInstagramTextMessage({
                        instagramBusinessId,
                        recipientUserId: senderId,
                        text: content,
                        accessToken,
                    });

                    const instagramMessageId = sendResult?.message_id || null;

                    // Store the message in conversation history
                    const messageMetadata = {
                        source: "followup",
                        sequenceKey,
                        followupIndex,
                    };

                    if (instagramMessageId) {
                        messageMetadata.mid = instagramMessageId;
                        messageMetadata.instagramMessageId = instagramMessageId;
                    }

                    await storeMessage(senderId, businessAccountId, content, "assistant", messageMetadata, {
                        isAiGenerated: true,
                    });

                    logger.info("Followup message sent successfully", {
                        ...logContext,
                        instagramMessageId,
                    });

                    // Schedule the next followup in sequence
                    const businessAccount = await getInstagramUserById(businessAccountId);
                    if (businessAccount?.tokens?.longLived?.accessToken) {
                        await scheduleNextFollowup({
                            senderId,
                            businessAccountId,
                            workspaceId,
                            stageTag: currentStage || stageTag,
                            followupIndex: followupIndex + 1,
                            accessToken: businessAccount.tokens.longLived.accessToken,
                            instagramBusinessId,
                        });
                    }

                    return { sent: true, instagramMessageId };
                } catch (sendError) {
                    logger.error("Failed to send followup message", {
                        ...logContext,
                        error: sendError.message,
                    });
                    throw sendError;
                }
            },
            {
                connection,
                concurrency: 5,
                drainDelay: 30, // Wait 30 seconds between polls when queue is empty (reduces Redis commands)
                stalledInterval: 60000, // Check for stalled jobs every 60s instead of 30s
            }
        );

        followupWorker.on("completed", (job, result) => {
            if (result?.sent) {
                logger.debug("Followup job completed", { jobId: job.id });
            }
        });

        followupWorker.on("failed", (job, err) => {
            logger.error("Followup job failed", {
                jobId: job?.id,
                error: err.message,
                data: job?.data,
            });
        });

        followupWorker.on("error", (err) => {
            logger.error("Followup worker error", { error: err.message });
        });

        logger.info("Followup worker initialized");
        return followupWorker;
    } catch (error) {
        logger.error("Failed to initialize followup worker", { error: error.message });
        followupWorker = null;
        return null;
    }
};

/**
 * Check if followup queue is available
 */
const isFollowupQueueAvailable = () => Boolean(followupQueue);

/**
 * Gracefully shutdown the followup queue and worker
 */
const shutdownFollowupQueue = async () => {
    const shutdownPromises = [];

    if (followupWorker) {
        shutdownPromises.push(
            followupWorker.close().catch((err) => {
                logger.warn("Error closing followup worker", { error: err.message });
            })
        );
    }

    if (followupQueue) {
        shutdownPromises.push(
            followupQueue.close().catch((err) => {
                logger.warn("Error closing followup queue", { error: err.message });
            })
        );
    }

    await Promise.all(shutdownPromises);

    followupWorker = null;
    followupQueue = null;

    logger.info("Followup queue shutdown complete");
};

module.exports = {
    initializeFollowupQueue,
    initializeFollowupWorker,
    scheduleFollowupSequence,
    scheduleNextFollowup,
    cancelPendingFollowups,
    isFollowupQueueAvailable,
    shutdownFollowupQueue,
};
