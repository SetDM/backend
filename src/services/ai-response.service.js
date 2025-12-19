const config = require("../config/environment");
const logger = require("../utils/logger");
const { generateResponse } = require("./chatgpt.service");
const { sendInstagramTextMessage } = require("./instagram-messaging.service");
const {
    getConversationHistory,
    formatForChatGPT,
    updateConversationStageTag,
    enqueueConversationMessage,
    removeQueuedConversationMessage,
    getConversationAutopilotStatus,
    clearQueuedConversationMessages,
    getConversationStageTag,
    storeMessage,
} = require("./conversation.service");
const { splitMessageByGaps } = require("../utils/message-utils");
const { addDelayedMessage, clearDelayedMessagesForConversation, isQueueAvailable } = require("./message-queue.service");

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomIntInclusive = (min, max) => {
    const normalizedMin = Math.ceil(min);
    const normalizedMax = Math.floor(Math.max(normalizedMin, max));

    if (normalizedMax <= normalizedMin) {
        return normalizedMin;
    }

    return normalizedMin + Math.floor(Math.random() * (normalizedMax - normalizedMin + 1));
};

const computeChunkScheduleDelays = (initialDelayMs, chunkCount) => {
    const safeInitialDelay = Math.max(0, Number(initialDelayMs) || 0);
    if (!Number.isFinite(chunkCount) || chunkCount <= 0) {
        return [];
    }

    const spacingConfig = config.responses?.chunkSpacingMs || {};
    const configuredMin = Number(spacingConfig.minMs);
    const configuredMax = Number(spacingConfig.maxMs);

    const minSpacing = Number.isFinite(configuredMin) ? Math.max(250, Math.floor(configuredMin)) : 900;
    const maxSpacing = Number.isFinite(configuredMax) ? Math.max(minSpacing, Math.floor(configuredMax)) : 2200;

    const schedule = [];
    let cumulativeDelay = safeInitialDelay;

    for (let index = 0; index < chunkCount; index += 1) {
        if (index === 0) {
            schedule.push(cumulativeDelay);
            continue;
        }

        const gap = randomIntInclusive(minSpacing, maxSpacing);
        cumulativeDelay += gap;
        schedule.push(cumulativeDelay);
    }

    return schedule;
};

const getLastAssistantTimestamp = (messages = []) => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role === "assistant" && message.timestamp) {
            return new Date(message.timestamp);
        }
    }
    return null;
};

const computeReplyDelayMs = (lastAssistantTimestamp) => {
    const delayConfig = config.responses?.replyDelay;
    if (!delayConfig) {
        return 0;
    }

    const { minMs, maxMs, skipIfLastReplyOlderThanMs } = delayConfig;
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= 0) {
        return 0;
    }

    if (lastAssistantTimestamp) {
        const elapsedMs = Date.now() - new Date(lastAssistantTimestamp).getTime();
        if (Number.isFinite(skipIfLastReplyOlderThanMs) && elapsedMs > skipIfLastReplyOlderThanMs) {
            return 0;
        }
    }

    if (!lastAssistantTimestamp) {
        // Always delay on first assistant reply to mimic natural behavior
    }

    const span = Math.max(0, maxMs - minMs);
    return span === 0 ? maxMs : minMs + Math.floor(Math.random() * (span + 1));
};

const partitionConversationHistory = (messages = []) => {
    let lastAssistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === "assistant") {
            lastAssistantIndex = i;
            break;
        }
    }

    const historyForModel = lastAssistantIndex >= 0 ? messages.slice(0, lastAssistantIndex + 1) : [];
    const pendingMessages = messages.slice(lastAssistantIndex + 1);

    return { historyForModel, pendingMessages };
};

const combinePendingUserMessages = (messages = []) =>
    messages
        .filter((msg) => msg.role === "user" && typeof msg.content === "string")
        .map((msg) => msg.content.trim())
        .filter(Boolean)
        .join("\n\n");

const normalizeAssistantResponse = (text) => {
    if (typeof text !== "string") {
        return text;
    }

    return text.replace(/—/g, ".").replace(/\s-\s/g, ".");
};

const extractStageTag = (text) => {
    if (typeof text !== "string") {
        return null;
    }

    const tagMatch = text.match(/\[tag:\s*([^\]]+)\]/i);
    return tagMatch ? tagMatch[1].trim() : null;
};

const stripStageTagFromResponse = (text) => {
    if (typeof text !== "string") {
        return text;
    }

    return text.replace(/\s*\[tag:[^\]]+\]\s*$/i, "").trim();
};

const isFlagStage = (stageTag) => typeof stageTag === "string" && stageTag.trim().toLowerCase() === "flag";

const applyTemplateVariables = (text, replacements = {}, context = {}) => {
    if (!text || typeof text !== "string") {
        return text;
    }

    return Object.entries(replacements).reduce((acc, [key, value]) => {
        const templateTokens = [`{{${key}}}`];

        if (key === "CALENDLY_LINK") {
            templateTokens.push("[calendly link]", "[booking_link]");
        }

        return templateTokens.reduce((textAcc, token) => {
            if (!textAcc.includes(token)) {
                return textAcc;
            }

            const tokenRegex = new RegExp(escapeRegExp(token), "g");

            if (!value) {
                logger.warn("Missing template variable replacement", {
                    key,
                    token,
                    ...context,
                });
                return textAcc.replace(tokenRegex, "").trim();
            }

            return textAcc.replace(tokenRegex, value);
        }, acc);
    }, text);
};

const isLatestPendingMessage = (pendingMessages, incomingMid) => {
    if (!pendingMessages.length) {
        return false;
    }

    const latestPendingMessage = pendingMessages[pendingMessages.length - 1];

    if (!incomingMid || !latestPendingMessage?.metadata?.mid) {
        return pendingMessages.length === 1;
    }

    return latestPendingMessage.metadata.mid === incomingMid;
};

const confirmLatestPendingMessage = async ({ senderId, businessAccountId, incomingMid }) => {
    const conversationHistory = await getConversationHistory(senderId, businessAccountId);
    const { pendingMessages } = partitionConversationHistory(conversationHistory);
    return isLatestPendingMessage(pendingMessages, incomingMid);
};

const processPendingMessagesWithAI = async ({
    senderId,
    businessAccountId,
    businessAccount,
    incomingMessageMid = null,
    forceProcessPending = false,
    calendlyLink = null,
    forceQueuePreview = false,
    workspaceSettings = null,
}) => {
    if (!senderId || !businessAccountId) {
        throw new Error("senderId and businessAccountId are required to process AI responses.");
    }

    if (!businessAccount?.tokens?.longLived?.accessToken) {
        throw new Error("Missing Instagram long-lived token for business account.");
    }

    const accessToken = businessAccount.tokens.longLived.accessToken;
    const conversationHistory = await getConversationHistory(senderId, businessAccountId);
    const lastAssistantTimestamp = getLastAssistantTimestamp(conversationHistory);
    const { historyForModel, pendingMessages } = partitionConversationHistory(conversationHistory);

    if (!pendingMessages.length) {
        logger.info("No pending user messages to process with AI", {
            senderId,
            businessAccountId,
        });
        return false;
    }

    const latestPendingMid = pendingMessages[pendingMessages.length - 1]?.metadata?.mid || null;
    const referenceMid = incomingMessageMid || latestPendingMid;

    if (!forceProcessPending && !isLatestPendingMessage(pendingMessages, referenceMid)) {
        logger.info("Skipping AI response for earlier user payload; newer message pending", {
            senderId,
            businessAccountId,
            incomingMessageMid: referenceMid,
            latestPendingMid,
        });
        return false;
    }

    const combinedPendingUserMessage = combinePendingUserMessages(pendingMessages) || pendingMessages[pendingMessages.length - 1]?.content;

    if (!combinedPendingUserMessage) {
        logger.info("Pending user messages lacked text content; skipping AI response", {
            senderId,
            businessAccountId,
        });
        return false;
    }

    try {
        await clearQueuedConversationMessages(senderId, businessAccountId);
        // Also clear any pending BullMQ jobs for this conversation
        if (isQueueAvailable()) {
            await clearDelayedMessagesForConversation(senderId, businessAccountId);
        }
    } catch (clearQueueError) {
        logger.error("Failed to clear existing queued AI responses before processing new reply", {
            senderId,
            businessAccountId,
            error: clearQueueError.message,
        });
    }

    const formattedHistory = formatForChatGPT(historyForModel);

    logger.info("Generating ChatGPT response", {
        senderId,
        pendingMessages: pendingMessages.length,
        combinedMessageLength: combinedPendingUserMessage.length,
    });
    let currentStageTag = null;
    try {
        currentStageTag = await getConversationStageTag(senderId, businessAccountId);
    } catch (stageLookupError) {
        logger.error("Failed to fetch current stage tag before generating AI response", {
            senderId,
            businessAccountId,
            error: stageLookupError.message,
        });
    }

    const rawAiResponse = await generateResponse(combinedPendingUserMessage, formattedHistory, {
        stageTag: currentStageTag,
        workspaceId: businessAccountId,
        workspaceSettings,
    });
    const aiResponseWithTag = normalizeAssistantResponse(
        applyTemplateVariables(
            rawAiResponse,
            {
                CALENDLY_LINK: calendlyLink,
            },
            { businessAccountId }
        )
    );

    const stageTag = extractStageTag(aiResponseWithTag);
    logger.info("Stage tag extraction result", {
        senderId,
        businessAccountId,
        extractedTag: stageTag,
        responseEnding: aiResponseWithTag.slice(-100), // Last 100 chars to see the tag
    });
    
    if (stageTag) {
        try {
            await updateConversationStageTag(senderId, businessAccountId, stageTag);
            logger.info("Stage tag updated successfully", {
                senderId,
                businessAccountId,
                stageTag,
            });
        } catch (stageError) {
            logger.error("Failed to update conversation stage tag", {
                senderId,
                stageTag,
                error: stageError.message,
            });
        }
    }

    if (isFlagStage(stageTag)) {
        logger.info("Conversation flagged by AI response; suppressing outbound reply", {
            senderId,
            businessAccountId,
        });
        return false;
    }

    const displayResponse = stripStageTagFromResponse(aiResponseWithTag) || aiResponseWithTag;

    const rawMessageParts = splitMessageByGaps(displayResponse);
    let partsToSend = rawMessageParts.length ? rawMessageParts : [displayResponse];

    const maxMessageParts = Math.max(1, Number(config.responses?.maxMessageParts) || 3);
    if (partsToSend.length > maxMessageParts) {
        const preserved = partsToSend.slice(0, maxMessageParts - 1);
        const mergedRemainder = partsToSend
            .slice(maxMessageParts - 1)
            .join("\n\n")
            .trim();
        partsToSend = mergedRemainder ? [...preserved, mergedRemainder] : preserved;
    }

    let primaryDelayMs = Math.max(0, Number(computeReplyDelayMs(lastAssistantTimestamp)) || 0);

    if (forceQueuePreview && primaryDelayMs === 0) {
        const configuredFallback = Number(config.responses?.forcedQueueDelayMs);
        const fallbackDelay = Number.isFinite(configuredFallback) ? Math.max(500, configuredFallback) : 1500;
        primaryDelayMs = fallbackDelay;
        logger.info("Forcing queued preview with fallback delay after autopilot enable", {
            senderId,
            businessAccountId,
            fallbackDelay,
        });
    }
    const chunkScheduleDelays = primaryDelayMs > 0 ? computeChunkScheduleDelays(primaryDelayMs, partsToSend.length) : [];
    const queuedChunkEntries = new Array(partsToSend.length).fill(null);

    // Use BullMQ for reliable delayed message processing if available
    const useBullMQ = isQueueAvailable() && chunkScheduleDelays.length > 0;

    if (chunkScheduleDelays.length) {
        for (let index = 0; index < partsToSend.length; index += 1) {
            const scheduledDelayMs = chunkScheduleDelays[index];
            const chunkContent = partsToSend[index] || displayResponse;

            try {
                const entry = await enqueueConversationMessage({
                    senderId,
                    recipientId: businessAccountId,
                    content: chunkContent,
                    delayMs: scheduledDelayMs,
                    metadata: {
                        chunkIndex: index,
                        chunkTotal: partsToSend.length,
                    },
                });

                if (entry) {
                    queuedChunkEntries[index] = entry;

                    // If BullMQ is available, add the job to process later
                    if (useBullMQ) {
                        await addDelayedMessage({
                            senderId,
                            businessAccountId,
                            instagramBusinessId: businessAccount.instagramId,
                            accessToken,
                            queuedMessageId: entry.id,
                            content: chunkContent,
                            delayMs: scheduledDelayMs,
                            chunkIndex: index,
                            chunkTotal: partsToSend.length,
                        });
                    }
                }
            } catch (queueError) {
                logger.error("Failed to enqueue AI response chunk; proceeding without queue record", {
                    senderId,
                    businessAccountId,
                    chunkIndex: index,
                    error: queueError.message,
                });
            }
        }

        if (queuedChunkEntries.some(Boolean)) {
            logger.info("Queued AI response chunks for delayed delivery", {
                senderId,
                businessAccountId,
                chunksQueued: queuedChunkEntries.filter(Boolean).length,
                firstDelayMs: chunkScheduleDelays[0],
                lastDelayMs: chunkScheduleDelays[chunkScheduleDelays.length - 1],
                usingBullMQ: useBullMQ,
            });
        }
    }

    // If using BullMQ, we can return immediately - the worker handles sending
    if (useBullMQ) {
        logger.info("AI response chunks queued with BullMQ for reliable delayed delivery", {
            senderId,
            businessAccountId,
            responseLength: displayResponse.length,
            partsQueued: partsToSend.length,
        });
        return true;
    }

    // Fallback: in-memory wait() for sending (less reliable but works without Redis)
    const needsLatestConfirmation = !forceProcessPending && Boolean(referenceMid);
    let hasConfirmedLatestPending = !needsLatestConfirmation;
    let previousScheduledDelay = 0;

    for (let index = 0; index < partsToSend.length; index += 1) {
        const scheduledDelayMsRaw = chunkScheduleDelays[index];
        const scheduledDelayMs = Number.isFinite(scheduledDelayMsRaw) || scheduledDelayMsRaw === 0 ? scheduledDelayMsRaw : index === 0 ? primaryDelayMs : previousScheduledDelay;
        const waitMs = Math.max(0, scheduledDelayMs - previousScheduledDelay);

        if (waitMs > 0) {
            logger.info("Delaying AI chunk delivery to simulate natural chat timing (in-memory fallback)", {
                senderId,
                businessAccountId,
                chunkIndex: index,
                waitMs,
            });
            await wait(waitMs);
        }

        previousScheduledDelay = Math.max(previousScheduledDelay, scheduledDelayMs);

        const queueEntry = queuedChunkEntries[index];
        if (queueEntry) {
            const removed = await removeQueuedConversationMessage({
                senderId,
                recipientId: businessAccountId,
                queuedMessageId: queueEntry.id,
            });

            if (!removed) {
                // Message was already sent by user or removed - skip this chunk and continue with remaining
                logger.info("Queued AI chunk already sent/removed; skipping to next chunk", {
                    senderId,
                    businessAccountId,
                    chunkIndex: index,
                    queuedMessageId: queueEntry.id,
                });
                queuedChunkEntries[index] = null;
                // Continue to next chunk instead of aborting
                continue;
            }

            const autopilotStillEnabled = await getConversationAutopilotStatus(senderId, businessAccountId);

            if (!autopilotStillEnabled) {
                // Autopilot disabled - abort but DON'T clean up remaining chunks
                // User disabled autopilot so they want manual control
                logger.info("Autopilot disabled before queued AI chunk delivery; stopping auto-send", {
                    senderId,
                    businessAccountId,
                    chunkIndex: index,
                });
                queuedChunkEntries[index] = null;
                // Don't call cleanupQueuedChunkEntries - leave remaining messages for user
                return false;
            }

            queuedChunkEntries[index] = null;
        } else if (primaryDelayMs > 0 && chunkScheduleDelays.length) {
            const autopilotStillEnabled = await getConversationAutopilotStatus(senderId, businessAccountId);

            if (!autopilotStillEnabled) {
                logger.info("Autopilot disabled before delivering AI chunk; stopping auto-send", {
                    senderId,
                    businessAccountId,
                    chunkIndex: index,
                });
                // Don't clean up - leave remaining messages for user to manage
                return false;
            }
        }

        if (!hasConfirmedLatestPending) {
            const stillLatest = await confirmLatestPendingMessage({
                senderId,
                businessAccountId,
                incomingMid: referenceMid,
            });

            if (!stillLatest) {
                logger.info("Aborting AI response; newer user message detected during delay window", {
                    senderId,
                    businessAccountId,
                    incomingMessageMid: referenceMid,
                });
                // Don't clean up - a new AI response will be generated which will handle the queue
                return false;
            }

            hasConfirmedLatestPending = true;
        }

        const sendResult = await sendInstagramTextMessage({
            instagramBusinessId: businessAccount.instagramId,
            recipientUserId: senderId,
            text: partsToSend[index],
            accessToken,
        });

        // Store the AI message immediately with the Instagram message_id to prevent echo duplicates
        const instagramMessageId = sendResult?.message_id || null;
        const messageMetadata = {
            source: "ai",
            chunkIndex: index,
            chunkTotal: partsToSend.length,
        };
        if (instagramMessageId) {
            messageMetadata.mid = instagramMessageId;
            messageMetadata.instagramMessageId = instagramMessageId;
        }

        try {
            await storeMessage(senderId, businessAccountId, partsToSend[index], "assistant", messageMetadata, {
                isAiGenerated: true,
            });
        } catch (storeError) {
            logger.error("Failed to store AI response message after sending", {
                senderId,
                businessAccountId,
                chunkIndex: index,
                error: storeError.message,
            });
        }
    }

    logger.info("AI response sent to Instagram user (in-memory fallback)", {
        senderId,
        businessAccountId,
        responseLength: displayResponse.length,
        partsSent: partsToSend.length,
    });

    return true;
};

module.exports = {
    processPendingMessagesWithAI,
    isFlagStage,
    partitionConversationHistory,
    combinePendingUserMessages,
};
