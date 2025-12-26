const logger = require("../utils/logger");
const {
    getPromptByName,
    getPromptByWorkspace,
    upsertPrompt,
    upsertPromptSections,
    upsertPromptConfig,
    DEFAULT_PROMPT_NAME,
    USER_PROMPT_NAME,
    extractPromptSections,
    mergeSectionsWithDefaults,
    mergeConfigWithDefaults,
    buildPromptFromSections,
    buildPromptFromConfig,
    sanitizeSections,
    sanitizeConfig,
} = require("../services/prompt.service");
const { resetSystemPromptCache, resetUserPromptCache, clearWorkspacePromptCache, generateResponse, analyzeChatsForSequences } = require("../services/chatgpt.service");
const { stripTrailingStageTag } = require("../utils/message-utils");

const normalizeHistory = (historyInput = []) => {
    if (!Array.isArray(historyInput)) {
        return [];
    }

    return historyInput
        .map((entry) => {
            if (!entry || typeof entry !== "object") {
                return null;
            }

            const role = entry.role === "assistant" ? "assistant" : entry.role === "user" ? "user" : null;
            const content = typeof entry.content === "string" ? entry.content.trim() : "";

            if (!role || !content) {
                return null;
            }

            return { role, content };
        })
        .filter(Boolean);
};

/**
 * Extract workspace ID from authenticated request
 */
const getWorkspaceId = (req) => {
    // The workspace ID is the Instagram ID from the authenticated user
    return req.user?.instagramId || req.auth?.instagramId || null;
};

const getSystemPrompt = async (req, res, next) => {
    try {
        const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

        if (!promptDoc?.content) {
            return res.status(404).json({ message: "Prompt not found" });
        }

        return res.json({
            name: promptDoc.name,
            content: promptDoc.content,
            sections: extractPromptSections(promptDoc.content),
            updatedAt: promptDoc.updatedAt,
            createdAt: promptDoc.createdAt,
        });
    } catch (error) {
        logger.error("Failed to fetch system prompt", { error: error.message });
        return next(error);
    }
};

const updateSystemPrompt = async (req, res, next) => {
    try {
        const { content } = req.body || {};

        if (!content || typeof content !== "string" || !content.trim()) {
            return res.status(400).json({ message: "content is required and must be a string" });
        }

        await upsertPrompt({ name: DEFAULT_PROMPT_NAME, content });
        resetSystemPromptCache();
        await resetUserPromptCache();

        return res.json({ message: "Prompt updated successfully" });
    } catch (error) {
        logger.error("Failed to update system prompt", { error: error.message });
        return next(error);
    }
};

const getUserPrompt = async (req, res, next) => {
    try {
        const workspaceId = getWorkspaceId(req);

        if (!workspaceId) {
            return res.status(400).json({ message: "Workspace ID is required" });
        }

        // Get workspace-specific prompt
        const userPromptDoc = await getPromptByWorkspace(workspaceId);

        // Check if we have the new config structure
        if (userPromptDoc?.config) {
            const mergedConfig = mergeConfigWithDefaults(userPromptDoc.config);
            return res.json({
                workspaceId,
                config: mergedConfig,
                content: buildPromptFromConfig(mergedConfig),
                updatedAt: userPromptDoc.updatedAt,
                createdAt: userPromptDoc.createdAt,
            });
        }

        // No existing config - return defaults
        const defaultConfig = mergeConfigWithDefaults({});

        return res.json({
            workspaceId,
            config: defaultConfig,
            content: buildPromptFromConfig(defaultConfig),
            updatedAt: null,
            createdAt: null,
        });
    } catch (error) {
        logger.error("Failed to fetch user prompt", { error: error.message });
        return next(error);
    }
};

const updateUserPrompt = async (req, res, next) => {
    try {
        const workspaceId = getWorkspaceId(req);

        if (!workspaceId) {
            return res.status(400).json({ message: "Workspace ID is required" });
        }

        const { config, sections } = req.body || {};

        // Handle new config structure (from frontend)
        if (config && typeof config === "object") {
            const sanitizedConfig = sanitizeConfig(config);
            const savedConfig = await upsertPromptConfig({
                workspaceId,
                config: sanitizedConfig,
            });

            // Clear cache for this specific workspace
            await clearWorkspacePromptCache(workspaceId);

            const mergedConfig = mergeConfigWithDefaults(savedConfig);

            logger.info("User prompt config updated", { workspaceId });

            return res.json({
                message: "Prompt configuration updated successfully",
                workspaceId,
                config: mergedConfig,
                content: buildPromptFromConfig(mergedConfig),
            });
        }

        // Legacy fallback: handle sections structure
        if (!sections || typeof sections !== "object") {
            return res.status(400).json({ message: "config or sections object is required." });
        }

        const sanitizedSections = sanitizeSections(sections);

        if (!Object.keys(sanitizedSections).length) {
            return res.status(400).json({ message: "Provide at least one section to update." });
        }

        const savedSections = await upsertPromptSections({
            name: USER_PROMPT_NAME,
            sections: sanitizedSections,
        });

        await resetUserPromptCache();

        const mergedSections = mergeSectionsWithDefaults({ overrides: savedSections });

        return res.json({
            message: "User prompt updated successfully",
            sections: mergedSections,
            overrides: savedSections,
            content: buildPromptFromSections(mergedSections),
        });
    } catch (error) {
        logger.error("Failed to update user prompt", { error: error.message });
        return next(error);
    }
};

/**
 * Extract stage tag from AI response text (e.g., "[tag: qualified]")
 */
const extractStageTag = (text) => {
    if (typeof text !== "string") {
        return null;
    }
    const tagMatch = text.match(/\[tag:\s*([^\]]+)\]/i);
    return tagMatch ? tagMatch[1].trim().toLowerCase().replace(/\s+/g, "_") : null;
};

/**
 * Apply template variables (like booking links) to response text
 */
const applyTemplateVariables = (text, replacements = {}) => {
    if (!text || typeof text !== "string") {
        return text;
    }

    return Object.entries(replacements).reduce((acc, [key, value]) => {
        const templateTokens = [`{{${key}}}`];

        // Support multiple formats for booking/calendly links
        if (key === "CALENDLY_LINK") {
            templateTokens.push("[calendly link]", "[booking_link]", "[calendly_link]", "[booking link]");
        }

        return templateTokens.reduce((textAcc, token) => {
            if (!textAcc.toLowerCase().includes(token.toLowerCase())) {
                return textAcc;
            }
            // Case-insensitive replacement
            const tokenRegex = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
            return value ? textAcc.replace(tokenRegex, value) : textAcc.replace(tokenRegex, "[booking link not configured]");
        }, acc);
    }, text);
};

const testUserPrompt = async (req, res, next) => {
    try {
        const { message, history, config, sections, stageTag, workspaceSettings } = req.body || {};

        if (!message || typeof message !== "string" || !message.trim()) {
            return res.status(400).json({ message: "message field is required for testing." });
        }

        const sanitizedHistory = normalizeHistory(history);
        const trimmedMessage = message.trim();
        const normalizedMessage = trimmedMessage.toUpperCase();
        const calendarLink = workspaceSettings?.profile?.calendarLink || workspaceSettings?.calendarLink || null;

        // Check for keyword matches FIRST (exact match like production)
        const keywordConfig = config?.keywordSequence;
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

        // If keyword matched, return keyword sequence initial message
        if (matchedKeyword && keywordConfig?.initialMessage) {
            const initialMessage = applyTemplateVariables(keywordConfig.initialMessage, {
                CALENDLY_LINK: calendarLink,
            });

            // Get followups for this sequence
            const followups = (keywordConfig.followups || []).map((f, idx) => ({
                index: idx,
                content: applyTemplateVariables(f.content, { CALENDLY_LINK: calendarLink }),
                delayValue: f.delayValue,
                delayUnit: f.delayUnit,
            }));

            return res.json({
                reply: initialMessage,
                stageTag: "lead",
                triggerType: "keyword",
                matchedTrigger: matchedKeyword,
                followups,
            });
        }

        // Check for keyword phrase matches (fuzzy, one per line)
        const keywordPhrasesStr = keywordConfig?.keywordPhrases || "";
        const keywordPhrasesList = keywordPhrasesStr
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean);

        // Check for activation phrase matches
        const activationPhrasesStr = config?.activationPhrases || "";
        const activationPhrasesList = activationPhrasesStr
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean);

        // Simple fuzzy matching for phrases (case-insensitive contains)
        let matchedKeywordPhrase = null;
        let matchedActivationPhrase = null;
        const lowerMessage = trimmedMessage.toLowerCase();

        for (const phrase of keywordPhrasesList) {
            if (lowerMessage.includes(phrase.toLowerCase())) {
                matchedKeywordPhrase = phrase;
                break;
            }
        }

        if (!matchedKeywordPhrase) {
            for (const phrase of activationPhrasesList) {
                if (lowerMessage.includes(phrase.toLowerCase())) {
                    matchedActivationPhrase = phrase;
                    break;
                }
            }
        }

        // If keyword phrase matched, return keyword sequence
        if (matchedKeywordPhrase && keywordConfig?.initialMessage) {
            const initialMessage = applyTemplateVariables(keywordConfig.initialMessage, {
                CALENDLY_LINK: calendarLink,
            });

            const followups = (keywordConfig.followups || []).map((f, idx) => ({
                index: idx,
                content: applyTemplateVariables(f.content, { CALENDLY_LINK: calendarLink }),
                delayValue: f.delayValue,
                delayUnit: f.delayUnit,
            }));

            return res.json({
                reply: initialMessage,
                stageTag: "lead",
                triggerType: "keyword_phrase",
                matchedTrigger: matchedKeywordPhrase,
                followups,
            });
        }

        // If activation phrase matched, set stage to responded and continue to AI
        let currentStageTag = stageTag;
        if (matchedActivationPhrase && !currentStageTag) {
            currentStageTag = "responded";
        }

        // Generate AI response
        const options = {};

        if (typeof currentStageTag === "string" && currentStageTag.trim().length) {
            options.stageTag = currentStageTag.trim();
        }

        if (config && typeof config === "object") {
            options.userPromptText = buildPromptFromConfig(config) || "";
            options.promptMode = config.promptMode || "combined";
        } else if (sections && typeof sections === "object") {
            options.userPromptText = buildPromptFromSections(sections) || "";
        }

        const rawReply = await generateResponse(trimmedMessage, sanitizedHistory, options);

        // Extract stage tag before stripping it
        const extractedStageTag = extractStageTag(rawReply);
        const newStageTag = extractedStageTag || currentStageTag;

        // Apply template variables
        let processedReply = applyTemplateVariables(rawReply, {
            CALENDLY_LINK: calendarLink,
        });

        // Strip the stage tag from the display reply
        const reply = stripTrailingStageTag(processedReply);

        // Get followups for the current stage sequence
        let followups = [];
        const sequenceKey = newStageTag ? getSequenceKeyForStage(newStageTag) : null;
        if (sequenceKey && config?.sequences?.[sequenceKey]?.followups) {
            followups = config.sequences[sequenceKey].followups.map((f, idx) => ({
                index: idx,
                content: applyTemplateVariables(f.content, { CALENDLY_LINK: calendarLink }),
                delayValue: f.delayValue,
                delayUnit: f.delayUnit,
            }));
        }

        return res.json({
            reply,
            stageTag: newStageTag,
            triggerType: matchedActivationPhrase ? "activation_phrase" : "ai_response",
            matchedTrigger: matchedActivationPhrase || null,
            followups,
        });
    } catch (error) {
        logger.error("Failed to execute prompt test", { error: error.message });
        return next(error);
    }
};

/**
 * Map stage tag to sequence key
 */
const getSequenceKeyForStage = (stageTag) => {
    const mapping = {
        "responded": "lead",
        "lead": "lead",
        "qualified": "qualification",
        "booking_sent": "booking",
        "booking-sent": "booking",
        "call_booked": "callBooked",
        "call-booked": "callBooked",
    };
    return mapping[stageTag?.toLowerCase()] || null;
};

/**
 * POST /prompt/analyze-chats
 * Analyze pasted chat conversations and generate structured sequences.
 */
const analyzeChats = async (req, res, next) => {
    try {
        const { chatText, coachName, businessDescription } = req.body;

        if (!chatText || typeof chatText !== "string" || chatText.trim().length < 50) {
            return res.status(400).json({
                error: "Please paste at least a few messages from your conversations",
            });
        }

        logger.info("Analyzing chats for sequence generation", {
            coachName,
            chatTextLength: chatText.length,
        });

        const result = await analyzeChatsForSequences({
            chatText,
            coachName: coachName || "Coach",
            businessDescription: businessDescription || "",
        });

        return res.json({
            success: true,
            data: result,
        });
    } catch (error) {
        logger.error("Failed to analyze chats", { error: error.message });
        return next(error);
    }
};

module.exports = {
    getSystemPrompt,
    updateSystemPrompt,
    getUserPrompt,
    updateUserPrompt,
    testUserPrompt,
    analyzeChats,
};
