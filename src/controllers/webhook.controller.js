const config = require("../config/environment");
const logger = require("../utils/logger");
const { getInstagramUserById } = require("../services/instagram-user.service");
const { sendInstagramTextMessage } = require("../services/instagram-messaging.service");
const {
    storeMessage,
    conversationExists,
    seedConversationHistory,
    getConversationFlagStatus,
    getConversationAutopilotStatus,
    updateConversationStageTag,
    setConversationAutopilotStatus,
} = require("../services/conversation.service");
const { getConversationIdForUser, getConversationMessages } = require("../services/instagram.service");
const { ensureInstagramUserProfile } = require("../services/user.service");
const { processPendingMessagesWithAI } = require("../services/ai-response.service");
const { analyzeImage } = require("../services/chatgpt.service");
const { cancelPendingFollowups, isFollowupQueueAvailable, scheduleKeywordFollowups } = require("../services/followup-scheduler.service");
const { getPromptByWorkspace } = require("../services/prompt.service");

const parseInstagramTimestamp = (value) => {
    if (!value) {
        return new Date();
    }

    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) {
        if (asNumber < 1e12) {
            return new Date(asNumber * 1000);
        }
        return new Date(asNumber);
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const mapInstagramMessagesToHistoryEntries = ({ messages = [], senderId, conversationId }) =>
    messages
        .map((msg) => {
            const text = msg?.text || msg?.message || msg?.messages?.text;

            if (!text) {
                return null;
            }

            const role = msg?.from?.id === senderId ? "user" : "assistant";

            return {
                role,
                content: text,
                timestamp: parseInstagramTimestamp(msg?.created_time),
                metadata: {
                    mid: msg?.id,
                    instagramMessageId: msg?.id,
                    instagramConversationId: conversationId,
                },
            };
        })
        .filter(Boolean);

const ensureConversationHistorySeeded = async ({ senderId, businessAccountId, accessToken }) => {
    const exists = await conversationExists(senderId, businessAccountId);
    if (exists) {
        return;
    }

    try {
        const conversationId = await getConversationIdForUser({
            instagramBusinessId: businessAccountId,
            userId: senderId,
            accessToken,
        });

        if (!conversationId) {
            logger.info("No existing Instagram conversation found for user; starting fresh", {
                senderId,
                businessAccountId,
            });
            return;
        }

        const remoteMessages = await getConversationMessages({
            conversationId,
            accessToken,
        });

        const formattedMessages = mapInstagramMessagesToHistoryEntries({
            messages: remoteMessages,
            senderId,
            conversationId,
        });

        if (!formattedMessages.length) {
            logger.info("Remote conversation contained no textual messages to backfill", {
                senderId,
                businessAccountId,
                conversationId,
            });
            return;
        }

        await seedConversationHistory(senderId, businessAccountId, formattedMessages);
    } catch (error) {
        logger.error("Failed to backfill Instagram conversation history", {
            senderId,
            businessAccountId,
            error: error.message,
        });
    }
};

const verifyInstagramWebhook = (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const verifyToken = config.instagram.webhookVerifyToken || process.env.TOKEN || "token";

    if (mode === "subscribe" && token === verifyToken) {
        return res.status(200).send(challenge);
    }

    return res.sendStatus(400);
};

const extractMessagePayloads = (payload) => {
    if (!payload || !Array.isArray(payload.entry) || payload.entry.length === 0) {
        return [];
    }

    const events = [];

    payload.entry.forEach((entry) => {
        const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];

        messagingEvents.forEach((event) => {
            if (event && !event.read) {
                events.push(event);
            }
        });
    });

    return events;
};

const processMessagePayload = async (messagePayload) => {
    const isEcho = Boolean(messagePayload?.message?.is_echo);
    const instagramUserId = isEcho ? messagePayload?.recipient?.id : messagePayload?.sender?.id;
    const businessAccountId = isEcho ? messagePayload?.sender?.id : messagePayload?.recipient?.id;
    const messageText = messagePayload?.message?.text;
    const messageMid = messagePayload?.message?.mid;
    const attachments = messagePayload?.message?.attachments || [];

    // Check for image attachments (only process regular images, not view_once or replay)
    const imageAttachment = attachments.find((att) => {
        // Instagram sends type: "image" for regular photos
        // view_once and replay messages have different properties
        if (att.type !== "image") {
            return false;
        }
        // Skip if it's a view_once or replay message (these have specific flags)
        // Instagram typically marks these differently - we only want permanent photos
        if (att.payload?.is_view_once || att.payload?.is_replay) {
            logger.debug("Ignoring view_once or replay image", { instagramUserId, businessAccountId });
            return false;
        }
        return true;
    });

    // Only process text messages or image attachments
    if (!messageText && !imageAttachment) {
        logger.debug("Ignoring non-text/non-image message", { instagramUserId, businessAccountId, isEcho, attachmentTypes: attachments.map((a) => a.type) });
        return;
    }

    if (!instagramUserId || !businessAccountId) {
        logger.warn("Invalid message payload: missing sender or recipient ID");
        return;
    }

    if (instagramUserId === businessAccountId) {
        logger.debug("Ignoring message from self", { instagramUserId });
        return;
    }

    const businessAccount = await getInstagramUserById(businessAccountId);
    const calendlyLink = businessAccount?.settings?.profile?.calendarLink || businessAccount?.settings?.calendlyLink || businessAccount?.calendlyLink || null;

    let isFlagged = false;
    try {
        isFlagged = await getConversationFlagStatus(instagramUserId, businessAccountId);
        if (isFlagged) {
            logger.info("Conversation flagged; inbound message will be stored but not processed further", {
                instagramUserId,
                businessAccountId,
            });
        }
    } catch (stageLookupError) {
        logger.error("Failed to check conversation stage tag before processing", {
            instagramUserId,
            businessAccountId,
            error: stageLookupError.message,
        });
    }

    if (!businessAccount || !businessAccount.tokens?.longLived?.accessToken) {
        logger.warn("No stored long-lived token for Instagram account", { businessAccountId });
        return;
    }

    try {
        await ensureInstagramUserProfile({
            instagramId: instagramUserId,
            accessToken: businessAccount.tokens.longLived.accessToken,
        });
    } catch (profileError) {
        logger.error("Failed to sync Instagram user profile", {
            instagramUserId,
            error: profileError.message,
        });
    }

    try {
        await ensureConversationHistorySeeded({
            senderId: instagramUserId,
            businessAccountId,
            accessToken: businessAccount.tokens.longLived.accessToken,
        });

        const messageMetadata = {
            mid: messageMid,
        };

        if (isEcho) {
            messageMetadata.source = "instagram_echo";
        }

        // Store the message (user vs assistant depending on direction)
        const workspaceAutopilotEnabled = (businessAccount?.settings?.autopilot?.mode || "full") !== "off";

        // Determine message content - use text if available, otherwise note it's an image
        const messageContent = messageText || (imageAttachment ? "[User sent an image]" : "");

        if (messageContent) {
            await storeMessage(instagramUserId, businessAccountId, messageContent, isEcho ? "assistant" : "user", messageMetadata, {
                isAiGenerated: false,
                defaultAutopilotOn: workspaceAutopilotEnabled,
            });
        }

        if (isEcho) {
            logger.debug("Stored outbound Instagram message echo and skipped AI processing", {
                instagramUserId,
                businessAccountId,
            });
            return;
        }

        // User replied - cancel any pending followups
        if (isFollowupQueueAvailable()) {
            try {
                await cancelPendingFollowups(instagramUserId, businessAccountId);
                logger.debug("Cancelled pending followups due to user reply", {
                    instagramUserId,
                    businessAccountId,
                });
            } catch (followupCancelError) {
                logger.error("Failed to cancel pending followups on user reply", {
                    instagramUserId,
                    businessAccountId,
                    error: followupCancelError.message,
                });
            }
        }

        // Process image attachment if present (only for incoming messages, not echoes)
        if (imageAttachment && !isEcho) {
            const imageUrl = imageAttachment.payload?.url;

            if (imageUrl) {
                logger.info("Processing image attachment from user", {
                    instagramUserId,
                    businessAccountId,
                    imageUrl: imageUrl.substring(0, 100),
                });

                try {
                    const analysisResult = await analyzeImage(imageUrl);

                    logger.info("Image analysis result", {
                        instagramUserId,
                        businessAccountId,
                        result: analysisResult,
                    });

                    if (analysisResult.type === "inappropriate" && analysisResult.confidence >= 0.7) {
                        // Flag the conversation for inappropriate content
                        logger.warn("Flagging conversation due to inappropriate image content", {
                            instagramUserId,
                            businessAccountId,
                            reason: analysisResult.reason,
                        });

                        await updateConversationStageTag(instagramUserId, businessAccountId, "flagged");

                        // Send a warning message
                        await sendInstagramTextMessage({
                            instagramBusinessId: businessAccountId,
                            recipientUserId: instagramUserId,
                            text: "This conversation has been flagged for review. A team member will follow up with you.",
                            accessToken: businessAccount.tokens.longLived.accessToken,
                        });

                        return; // Stop processing
                    }

                    if (analysisResult.type === "meeting_confirmation" && analysisResult.confidence >= 0.7) {
                        // Update stage to call-booked
                        logger.info("Updating conversation to call-booked based on meeting confirmation image", {
                            instagramUserId,
                            businessAccountId,
                            reason: analysisResult.reason,
                            meetingDate: analysisResult.meetingDate,
                            meetingTime: analysisResult.meetingTime,
                        });

                        await updateConversationStageTag(instagramUserId, businessAccountId, "call-booked");

                        // Build confirmation message with date/time if available
                        let confirmationMessage = "Thanks for confirming! I can see you've booked the call.";
                        if (analysisResult.meetingDate && analysisResult.meetingTime) {
                            confirmationMessage = `Thanks for confirming! I can see you've booked the call for ${analysisResult.meetingDate} at ${analysisResult.meetingTime}.`;
                        } else if (analysisResult.meetingDate) {
                            confirmationMessage = `Thanks for confirming! I can see you've booked the call for ${analysisResult.meetingDate}.`;
                        } else if (analysisResult.meetingTime) {
                            confirmationMessage = `Thanks for confirming! I can see you've booked the call at ${analysisResult.meetingTime}.`;
                        }
                        confirmationMessage += " Looking forward to speaking with you! 🎉";

                        // Send a confirmation message
                        await sendInstagramTextMessage({
                            instagramBusinessId: businessAccountId,
                            recipientUserId: instagramUserId,
                            text: confirmationMessage,
                            accessToken: businessAccount.tokens.longLived.accessToken,
                        });

                        // Disable autopilot for call-booked conversations
                        try {
                            await setConversationAutopilotStatus(instagramUserId, businessAccountId, false);
                            logger.info("Autopilot disabled for call-booked conversation (image detection)", {
                                instagramUserId,
                                businessAccountId,
                            });
                        } catch (autopilotError) {
                            logger.error("Failed to disable autopilot for call-booked conversation", {
                                instagramUserId,
                                businessAccountId,
                                error: autopilotError.message,
                            });
                        }

                        return; // Stop further AI processing
                    }

                    // For other images, continue with normal processing if there's also text
                    if (!messageText) {
                        logger.debug("Image received but not a meeting confirmation or inappropriate; no text to process", {
                            instagramUserId,
                            businessAccountId,
                        });
                        return;
                    }
                } catch (imageError) {
                    logger.error("Failed to analyze image; continuing with normal processing", {
                        instagramUserId,
                        businessAccountId,
                        error: imageError.message,
                    });
                    // Continue with normal processing if image analysis fails
                }
            }
        }

        // If no text message, skip AI processing
        if (!messageText) {
            return;
        }

        const incomingMessageMid = messageMid || null;

        if (!workspaceAutopilotEnabled) {
            logger.info("Workspace-level autopilot disabled; stored user message only", {
                instagramUserId,
                businessAccountId,
            });
            return;
        }

        // Check for KEYWORD/PHRASE triggers FIRST - these work even if autopilot is off
        // Priority: Keywords → Keyword Phrases → Activation Phrases
        try {
            const promptDoc = await getPromptByWorkspace(businessAccountId);
            const keywordConfig = promptDoc?.config?.keywordSequence;
            const activationPhrases = promptDoc?.config?.activationPhrases || "";
            const normalizedMessage = messageText.trim().toUpperCase();

            // 1. Check KEYWORDS (comma-separated, exact match) → keyword sequence → tag: lead
            const keywordsStr = keywordConfig?.keywords || keywordConfig?.keyword || "";
            const keywordsList = keywordsStr
                .split(",")
                .map((k) => k.trim().toUpperCase())
                .filter(Boolean);

            let matchedKeyword = null;
            for (const kw of keywordsList) {
                if (normalizedMessage === kw || normalizedMessage.startsWith(kw + " ")) {
                    matchedKeyword = kw;
                    break;
                }
            }

            // 2. Check KEYWORD PHRASES (one per line) → keyword sequence → tag: lead
            if (!matchedKeyword && keywordConfig?.keywordPhrases) {
                const phrasesList = keywordConfig.keywordPhrases
                    .split("\n")
                    .map((p) => p.trim().toUpperCase())
                    .filter(Boolean);

                for (const phrase of phrasesList) {
                    // Check if message contains/matches the phrase
                    if (normalizedMessage === phrase || normalizedMessage.includes(phrase)) {
                        matchedKeyword = phrase;
                        break;
                    }
                }
            }

            // If we matched a keyword or phrase, run keyword sequence
            if (matchedKeyword && keywordConfig?.initialMessage) {
                logger.info("Keyword/phrase trigger matched", {
                    instagramUserId,
                    businessAccountId,
                    matched: matchedKeyword,
                    message: messageText,
                });

                // Enable autopilot for this conversation
                try {
                    await setConversationAutopilotStatus(instagramUserId, businessAccountId, true);
                    logger.info("Autopilot enabled for keyword-triggered conversation", {
                        instagramUserId,
                        businessAccountId,
                    });
                } catch (autopilotEnableError) {
                    logger.error("Failed to enable autopilot for keyword conversation", {
                        instagramUserId,
                        businessAccountId,
                        error: autopilotEnableError.message,
                    });
                }

                // Send the keyword's initial message
                const sendResult = await sendInstagramTextMessage({
                    instagramBusinessId: businessAccountId,
                    recipientUserId: instagramUserId,
                    text: keywordConfig.initialMessage,
                    accessToken: businessAccount.tokens.longLived.accessToken,
                });

                // Store the response in conversation history
                await storeMessage(
                    instagramUserId,
                    businessAccountId,
                    keywordConfig.initialMessage,
                    "assistant",
                    {
                        source: "keyword_trigger",
                        keyword: matchedKeyword,
                        mid: sendResult?.message_id || null,
                    },
                    {
                        isAiGenerated: true,
                    }
                );

                // Update stage to LEAD (keyword sequence = qualification path)
                await updateConversationStageTag(instagramUserId, businessAccountId, "lead");

                // Schedule keyword followups if any
                if (keywordConfig.followups?.length > 0 && isFollowupQueueAvailable()) {
                    await scheduleKeywordFollowups({
                        senderId: instagramUserId,
                        businessAccountId,
                        followups: keywordConfig.followups,
                        accessToken: businessAccount.tokens.longLived.accessToken,
                        instagramBusinessId: businessAccountId,
                    });
                }

                logger.info("Keyword sequence initiated", {
                    instagramUserId,
                    businessAccountId,
                    matched: matchedKeyword,
                    hasFollowups: keywordConfig.followups?.length > 0,
                });

                return; // Skip normal AI processing
            }

            // 3. Check ACTIVATION PHRASES (one per line) → responded sequence → tag: responded
            // This activates AI even if autopilot is off
            if (activationPhrases) {
                const activationList = activationPhrases
                    .split("\n")
                    .map((p) => p.trim().toUpperCase())
                    .filter(Boolean);

                let matchedActivation = null;
                for (const phrase of activationList) {
                    if (normalizedMessage.includes(phrase)) {
                        matchedActivation = phrase;
                        break;
                    }
                }

                if (matchedActivation) {
                    logger.info("Activation phrase matched - enabling autopilot", {
                        instagramUserId,
                        businessAccountId,
                        matched: matchedActivation,
                        message: messageText,
                    });

                    // Enable autopilot for this conversation
                    try {
                        await setConversationAutopilotStatus(instagramUserId, businessAccountId, true);
                    } catch (autopilotEnableError) {
                        logger.error("Failed to enable autopilot for activation phrase", {
                            instagramUserId,
                            businessAccountId,
                            error: autopilotEnableError.message,
                        });
                    }

                    // Update stage to responded
                    await updateConversationStageTag(instagramUserId, businessAccountId, "responded");

                    // Continue to normal AI processing (don't return) - AI will handle the response
                }
            }
        } catch (keywordError) {
            logger.error("Failed to check keyword/activation triggers", {
                instagramUserId,
                businessAccountId,
                error: keywordError.message,
            });
            // Continue with normal AI processing if check fails
        }

        let autopilotEnabled = workspaceAutopilotEnabled;
        try {
            autopilotEnabled = await getConversationAutopilotStatus(instagramUserId, businessAccountId);
        } catch (autopilotError) {
            logger.error("Failed to determine autopilot status; defaulting to enabled", {
                instagramUserId,
                businessAccountId,
                error: autopilotError.message,
            });
        }

        if (!autopilotEnabled) {
            logger.info("Autopilot disabled for conversation; stored user message only", {
                instagramUserId,
                businessAccountId,
            });
            return;
        }

        if (isFlagged) {
            logger.info("Skipping AI processing because conversation is flagged", {
                instagramUserId,
                businessAccountId,
            });
            return;
        }

        await processPendingMessagesWithAI({
            senderId: instagramUserId,
            businessAccountId,
            businessAccount,
            incomingMessageMid,
            calendlyLink,
            workspaceSettings: businessAccount?.settings || null,
        });
    } catch (error) {
        logger.error("Failed to process message with AI", {
            senderId: instagramUserId,
            error: error.message,
        });

        // Send a fallback message in case of error
        try {
            await sendInstagramTextMessage({
                instagramBusinessId: businessAccount.instagramId,
                recipientUserId: instagramUserId,
                text: "Sorry, I encountered an issue processing your message. Please try again later.",
                accessToken: businessAccount.tokens.longLived.accessToken,
            });
        } catch (fallbackError) {
            logger.error("Failed to send fallback error message", {
                senderId: instagramUserId,
                error: fallbackError.message,
            });
        }
    }
};

const handleInstagramWebhook = (req, res) => {
    logger.info("Instagram request body:", req.body);
    res.sendStatus(200);

    const messagePayloads = extractMessagePayloads(req.body);
    if (!messagePayloads.length) {
        logger.debug("No message payloads found in webhook body.");
        return;
    }

    messagePayloads.forEach((payload) => {
        processMessagePayload(payload).catch((error) => {
            logger.error("Error processing Instagram message payload", { error: error.message });
        });
    });
};

module.exports = {
    verifyInstagramWebhook,
    handleInstagramWebhook,
};
