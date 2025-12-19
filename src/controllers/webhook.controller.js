const config = require("../config/environment");
const logger = require("../utils/logger");
const { getInstagramUserById } = require("../services/instagram-user.service");
const { sendInstagramTextMessage } = require("../services/instagram-messaging.service");
const { storeMessage, conversationExists, seedConversationHistory, getConversationFlagStatus, getConversationAutopilotStatus, updateConversationStageTag } = require("../services/conversation.service");
const { getConversationIdForUser, getConversationMessages } = require("../services/instagram.service");
const { ensureInstagramUserProfile } = require("../services/user.service");
const { processPendingMessagesWithAI } = require("../services/ai-response.service");
const { analyzeImage } = require("../services/chatgpt.service");

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
        logger.debug("Ignoring non-text/non-image message", { instagramUserId, businessAccountId, isEcho, attachmentTypes: attachments.map(a => a.type) });
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
                        });

                        await updateConversationStageTag(instagramUserId, businessAccountId, "call-booked");
                        
                        // Send a confirmation message
                        await sendInstagramTextMessage({
                            instagramBusinessId: businessAccountId,
                            recipientUserId: instagramUserId,
                            text: "Thanks for confirming! I can see you've booked the call. Looking forward to speaking with you! 🎉",
                            accessToken: businessAccount.tokens.longLived.accessToken,
                        });
                        
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
