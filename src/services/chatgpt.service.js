const OpenAI = require("openai");
const config = require("../config/environment");
const logger = require("../utils/logger");
const {
    getPromptByName,
    getPromptByWorkspace,
    getSystemPromptByType,
    DEFAULT_PROMPT_NAME,
    USER_PROMPT_NAME,
    extractPromptSections,
    mergeSectionsWithDefaults,
    mergeConfigWithDefaults,
    buildPromptFromSections,
    buildPromptFromConfig,
} = require("./prompt.service");
const { getCached, setCached, deleteCached, deleteCachedPattern } = require("../database/redis");

const DEFAULT_PROMPT_TEXT = "You are a helpful assistant for Instagram Direct Messages. Respond professionally and courteously.";
const SUMMARY_SYSTEM_PROMPT =
    'You are an assistant that reviews Instagram DM transcripts and writes concise CRM notes. Return JSON with a "notes" array containing up to {{maxNotes}} action-oriented bullet points (12 words max each). Focus on intent, objections, commitments, and next steps. Do not include any other text.';

// Cache TTL for prompts (5 minutes)
const PROMPT_CACHE_TTL = 300;

let systemPrompt = null;
let systemPromptVersion = 0;
let openaiClient = null;

// In-memory fallback cache for workspace prompts (used when Redis not available)
const workspacePromptCache = new Map();

const getOpenAIClient = () => {
    if (openaiClient) {
        return openaiClient;
    }

    if (!config.openai?.apiKey) {
        throw new Error("OpenAI API key not configured");
    }

    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
    return openaiClient;
};

/**
 * Load system prompt from MongoDB (cached in-memory once loaded).
 * Returns the full prompt content for backward compatibility,
 * or builds from structured data if available.
 * Note: Stage tagging and scenarios are loaded separately.
 */
const loadSystemPrompt = async () => {
    try {
        const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

        if (promptDoc) {
            // If structured data exists, build prompt from it
            if (promptDoc.structured) {
                const structured = promptDoc.structured;
                const parts = [];

                if (structured.baseInstructions) {
                    parts.push(structured.baseInstructions);
                }

                // Don't include stageTagging or scenarios here - they're loaded separately

                if (structured.sequences) {
                    if (structured.sequences.lead) {
                        parts.push(`This is the variable [lead sequence] {\n${structured.sequences.lead}\n}`);
                    }
                    if (structured.sequences.qualification) {
                        parts.push(`This is variable [qualification sequence] {\n${structured.sequences.qualification}\n}`);
                    }
                    if (structured.sequences.booking) {
                        parts.push(`This is the variable [booking sequence] {\n${structured.sequences.booking}\n}`);
                    }
                }

                const builtPrompt = parts.join("\n\n");
                if (builtPrompt !== systemPrompt) {
                    systemPrompt = builtPrompt;
                    systemPromptVersion += 1;
                    logger.info("System prompt built from structured data", {
                        name: promptDoc.name,
                        version: systemPromptVersion,
                    });
                }
                return systemPrompt;
            }

            // Fallback to content field
            if (promptDoc.content) {
                if (systemPrompt !== promptDoc.content) {
                    systemPrompt = promptDoc.content;
                    systemPromptVersion += 1;
                    logger.info("System prompt refreshed from database", {
                        name: promptDoc.name,
                        version: systemPromptVersion,
                    });
                }
                return systemPrompt;
            }
        }

        logger.warn("Prompt document missing or empty, using fallback prompt", {
            name: DEFAULT_PROMPT_NAME,
        });
    } catch (error) {
        logger.error("Failed to load system prompt from database", {
            error: error.message,
        });
    }

    if (!systemPrompt) {
        systemPrompt = DEFAULT_PROMPT_TEXT;
    }

    return systemPrompt;
};

/**
 * Load only the base instructions from the system prompt (without sequences, stage tagging, or scenarios).
 * Used when user has their own sequences and addToExisting is true.
 * Stage tagging and scenarios are loaded separately and always included.
 */
const loadSystemBaseInstructions = async () => {
    try {
        const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

        if (promptDoc?.structured) {
            const structured = promptDoc.structured;

            // Only return base instructions - stageTagging and scenarios are loaded separately
            if (structured.baseInstructions) {
                return structured.baseInstructions;
            }
        }

        // Fallback: return full content if no structured data
        return promptDoc?.content || DEFAULT_PROMPT_TEXT;
    } catch (error) {
        logger.error("Failed to load system base instructions", {
            error: error.message,
        });
        return DEFAULT_PROMPT_TEXT;
    }
};

/**
 * Load stage tagging instructions from the system prompt.
 * Returns the custom stage tagging if available, or null to use defaults.
 */
const loadStageTaggingInstructions = async () => {
    try {
        const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

        if (promptDoc?.structured?.stageTagging) {
            return promptDoc.structured.stageTagging;
        }

        // Return null to use the default STAGE_TAGGING_INSTRUCTIONS constant
        return null;
    } catch (error) {
        logger.error("Failed to load stage tagging instructions", {
            error: error.message,
        });
        return null;
    }
};

/**
 * Load scenarios and objection handlers from the system prompt.
 * These are always included regardless of custom prompt settings.
 */
const loadScenariosInstructions = async () => {
    try {
        const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

        if (promptDoc?.structured) {
            const structured = promptDoc.structured;
            const parts = [];

            if (structured.scenarios) {
                parts.push(`Different scenarios:\n\n${structured.scenarios}`);
            }

            if (Array.isArray(structured.objectionHandlers) && structured.objectionHandlers.length > 0) {
                parts.push("Some additional scenarios that might occur:\n");
                structured.objectionHandlers.forEach((h) => {
                    parts.push(`${h.objection}\nResponse: ${h.response}`);
                });
            }

            return parts.length > 0 ? parts.join("\n\n") : null;
        }

        return null;
    } catch (error) {
        logger.error("Failed to load scenarios instructions", {
            error: error.message,
        });
        return null;
    }
};

/**
 * Generate a response using ChatGPT
 * @param {string} userMessage - The user's message
 * @param {Array} conversationHistory - Previous messages in format [{role, content}, ...]
 */
const buildSettingsInstructions = (settings) => {
    if (!settings || typeof settings !== "object") {
        return null;
    }

    const instructions = [];

    // Entry points - trigger examples
    const triggerExamples = settings.entryPoints?.triggerExamples;
    if (Array.isArray(triggerExamples) && triggerExamples.length > 0) {
        instructions.push("ENTRY POINT TRIGGERS:");
        instructions.push("Only engage proactively with prospects whose messages match these themes or intentions:");
        triggerExamples.forEach((example) => {
            instructions.push(`  - "${example}"`);
        });
        instructions.push(
            "If this is a NEW conversation and the user's first message doesn't relate to any of these topics, respond with [tag:flag] to indicate this conversation should not be handled by AI."
        );
        instructions.push("");
    }

    // Ignore patterns
    const ignorePatterns = settings.ignoreRules?.ignorePatterns;
    if (Array.isArray(ignorePatterns) && ignorePatterns.length > 0) {
        instructions.push("IGNORE PATTERNS:");
        instructions.push("If the prospect's message matches any of these patterns (they are likely spam, solicitors, or salespeople), respond with [tag:flag] to hand off the conversation:");
        ignorePatterns.forEach((pattern) => {
            instructions.push(`  - "${pattern}"`);
        });
        instructions.push("");
    }

    // Filters / Qualification criteria
    const filters = settings.filters;
    if (filters && typeof filters === "object") {
        const filterRules = [];

        if (filters.minAge && filters.minAge > 0) {
            filterRules.push(
                `Minimum age requirement: ${filters.minAge} years old. Before qualifying a prospect, naturally ask about their age if not mentioned. If they are under ${filters.minAge}, politely explain you can only work with people ${filters.minAge}+ and use [tag:flag].`
            );
        }

        if (Array.isArray(filters.blockedCountries) && filters.blockedCountries.length > 0) {
            filterRules.push(
                `Blocked regions: ${filters.blockedCountries.join(
                    ", "
                )}. If prospect indicates they're from these areas, politely explain your services aren't available in their region and use [tag:flag].`
            );
        }

        if (Array.isArray(filters.allowedLanguages) && filters.allowedLanguages.length > 0) {
            filterRules.push(
                `Preferred languages: ${filters.allowedLanguages.join(", ")}. Respond in these languages when possible. If prospect writes in a different language, try to respond in English.`
            );
        }

        if (filterRules.length > 0) {
            instructions.push("QUALIFICATION FILTERS:");
            filterRules.forEach((rule) => {
                instructions.push(`  - ${rule}`);
            });
            instructions.push("");
        }
    }

    return instructions.length > 0 ? instructions.join("\n") : null;
};

// Minimal fallback - actual instructions should be in database
const DEFAULT_STAGE_TAGGING = `End each reply with a stage tag on a new line: [tag: stagename]
Valid stages: responded, lead, qualified, booking-sent, call-booked, sales, flag

IMPORTANT - When to NOT respond:
Sometimes the best response is NO response. Output ONLY "[NO_RESPONSE]" (nothing else) when:
- User says "bye", "goodbye", "thanks bye", "take care" etc. after conversation has concluded
- User says "not interested", "no thanks", "stop messaging me" and you've already acknowledged
- User sends a simple "thanks", "ok", "cool", "👍" after you've finished helping them
- Conversation has naturally ended and user is just being polite
- User has already declined/rejected your offer and sends another dismissive message

Do NOT keep conversations going just to be polite. Leave them on read. It's more natural.`;

const buildChatMessages = ({ systemPromptText, userPromptText, stageTaggingText, scenariosText, conversationHistory, userMessage, stageTag, workspaceSettings }) => {
    const messages = [];

    if (systemPromptText) {
        messages.push({ role: "system", content: systemPromptText });
    }

    if (userPromptText) {
        messages.push({ role: "system", content: userPromptText });
    }

    // Always include stage tagging instructions (use provided or fallback to default)
    const stageTaggingInstructions = stageTaggingText || DEFAULT_STAGE_TAGGING;
    messages.push({ role: "system", content: stageTaggingInstructions });

    // Always include scenarios if available
    if (scenariosText) {
        messages.push({ role: "system", content: scenariosText });
    }

    // Add settings-based filtering instructions
    const settingsInstructions = buildSettingsInstructions(workspaceSettings);
    if (settingsInstructions) {
        messages.push({ role: "system", content: settingsInstructions });
    }

    if (stageTag && typeof stageTag === "string" && stageTag.trim().length > 0) {
        messages.push({
            role: "system",
            content: `Context: The prospect's current stage tag is "${stageTag.trim()}". Use this to maintain continuity and avoid repeating previously completed steps.`,
        });
    }

    conversationHistory.forEach((msg) => {
        messages.push({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: msg.content,
        });
    });

    messages.push({ role: "user", content: userMessage });
    return messages;
};

const generateResponse = async (userMessage, conversationHistory = [], options = {}) => {
    try {
        const hasUserPromptOverride = Object.prototype.hasOwnProperty.call(options || {}, "userPromptText");

        // If workspaceId is provided, load workspace-specific prompt
        const workspaceId = options?.workspaceId || null;
        const workspaceSettings = options?.workspaceSettings || null;

        let userPromptResult;
        if (hasUserPromptOverride) {
            // Use promptMode from options if provided, otherwise default to "custom"
            const overridePromptMode = options?.promptMode === "system" ? "system" : "custom";
            userPromptResult = { promptText: typeof options.userPromptText === "string" ? options.userPromptText : "", promptMode: overridePromptMode };
        } else if (workspaceId) {
            userPromptResult = await loadWorkspacePrompt(workspaceId);
        } else {
            const legacyPrompt = await loadUserPrompt();
            userPromptResult = { promptText: legacyPrompt, promptMode: "custom" };
        }

        const { promptText: customPrompt, promptMode } = userPromptResult;

        // Determine which prompts to use based on promptMode:
        // - "system": Use full system prompt with sequences, NO custom prompt
        // - "custom": Use only custom prompt
        // Stage tagging and scenarios are ALWAYS included regardless of mode
        let systemPromptText = null;
        let stageTaggingText = null;
        let scenariosText = null;
        let userPromptText = null;

        if (promptMode === "system") {
            // System only - use full system prompt with sequences, no custom prompt
            systemPromptText = await loadSystemPrompt();
            stageTaggingText = await loadStageTaggingInstructions();
            scenariosText = await loadScenariosInstructions();
            userPromptText = null;
        } else {
            // Custom only - no system prompt, just user's custom prompt
            stageTaggingText = await loadStageTaggingInstructions();
            scenariosText = await loadScenariosInstructions();
            userPromptText = customPrompt;
        }

        const client = getOpenAIClient();
        const stageTag = typeof options?.stageTag === "string" ? options.stageTag : null;

        const messages = buildChatMessages({
            systemPromptText,
            userPromptText,
            stageTaggingText,
            scenariosText,
            conversationHistory,
            userMessage,
            stageTag,
            workspaceSettings,
        });

        logger.info("Sending request to OpenAI Chat Completions API", {
            messageCount: messages.length,
            userMessageLength: userMessage.length,
            workspaceId: workspaceId || "default",
            promptMode,
            hasSystemPrompt: Boolean(systemPromptText),
            hasUserPrompt: Boolean(userPromptText),
        });

        const requestPayload = {
            model: config.openai.model || "gpt-4o-mini",
            messages,
        };

        if (Number.isFinite(config.openai.temperature)) {
            requestPayload.temperature = Number(config.openai.temperature);
        }

        const response = await client.chat.completions.create(requestPayload);

        const assistantMessage = response.choices?.[0]?.message?.content?.trim();

        if (!assistantMessage) {
            throw new Error("No message content in Chat Completions response");
        }

        logger.info("OpenAI chat completion generated", {
            responseLength: assistantMessage.length,
            tokensUsed: response.usage?.total_tokens,
        });

        return assistantMessage;
    } catch (error) {
        logger.error("OpenAI Chat Completions API error", {
            error: error.message,
            status: error.status,
            data: error.response?.data || error.stack,
        });
        throw error;
    }
};

const resetSystemPromptCache = () => {
    systemPrompt = null;
    systemPromptVersion = 0;
};

/**
 * Load workspace-specific prompt from MongoDB.
 * Uses Redis cache if available, falls back to in-memory cache.
 * @param {string} workspaceId - The Instagram ID of the workspace
 * @returns {Object} { promptText, promptMode } - promptMode: "system" | "combined" | "custom"
 */
const loadWorkspacePrompt = async (workspaceId) => {
    if (!workspaceId) {
        const legacyPrompt = await loadUserPrompt();
        return { promptText: legacyPrompt, promptMode: "custom" };
    }

    const cacheKey = `prompt:workspace:${workspaceId}`;
    const modeCacheKey = `prompt:workspace:mode:${workspaceId}`;

    // Try Redis cache first
    const redisCached = await getCached(cacheKey);
    const modeCached = await getCached(modeCacheKey);
    if (redisCached !== null && modeCached !== null) {
        // Treat cached "combined" as "custom" for backward compat
        const normalizedMode = modeCached === "system" ? "system" : "custom";
        logger.debug("Workspace prompt loaded from Redis cache", { workspaceId, promptMode: normalizedMode });
        return { promptText: redisCached || null, promptMode: normalizedMode };
    }

    // Fallback to in-memory cache
    const memoryCached = workspacePromptCache.get(workspaceId);
    if (memoryCached && typeof memoryCached === "object" && memoryCached.promptMode) {
        // Normalize cached mode
        const normalizedMode = memoryCached.promptMode === "system" ? "system" : "custom";
        return { promptText: memoryCached.promptText, promptMode: normalizedMode };
    }

    try {
        const userPromptDoc = await getPromptByWorkspace(workspaceId);

        if (userPromptDoc?.config) {
            const mergedConfig = mergeConfigWithDefaults(userPromptDoc.config);
            const renderedPrompt = buildPromptFromConfig(mergedConfig);

            // promptMode is already normalized by mergeConfigWithDefaults
            const promptMode = mergedConfig.promptMode;

            // Cache in both Redis and memory
            const cachePrompt = promptMode === "system" ? "" : renderedPrompt || "";
            await setCached(cacheKey, cachePrompt, PROMPT_CACHE_TTL);
            await setCached(modeCacheKey, promptMode, PROMPT_CACHE_TTL);
            workspacePromptCache.set(workspaceId, { promptText: cachePrompt || null, promptMode });
            logger.info("Workspace prompt loaded from database and cached", { workspaceId, promptMode });
            return { promptText: promptMode === "system" ? null : cachePrompt, promptMode };
        }

        logger.debug("No workspace-specific prompt found, using defaults", { workspaceId });
    } catch (error) {
        logger.error("Failed to load workspace prompt from database", {
            workspaceId,
            error: error.message,
        });
    }

    return { promptText: null, promptMode: "system" };
};

/**
 * Load legacy user prompt (global, not workspace-specific).
 * Kept for backward compatibility.
 */
const loadUserPrompt = async () => {
    try {
        const userPromptDoc = await getPromptByName(USER_PROMPT_NAME);

        // Check for new config structure first
        if (userPromptDoc?.config) {
            const mergedConfig = mergeConfigWithDefaults(userPromptDoc.config);
            const renderedPrompt = buildPromptFromConfig(mergedConfig);

            if (renderedPrompt && renderedPrompt.trim()) {
                logger.info("User prompt refreshed from config (legacy global)");
                return renderedPrompt;
            }
        }

        // Legacy fallback: use sections structure
        const systemPromptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);
        const baseSections = extractPromptSections(systemPromptDoc?.content || "");
        const overrideSections = userPromptDoc?.sections || {};
        const mergedSections = mergeSectionsWithDefaults({
            base: baseSections,
            overrides: overrideSections,
        });

        const renderedPrompt = buildPromptFromSections(mergedSections);

        if (renderedPrompt && renderedPrompt.trim()) {
            logger.info("User prompt refreshed from sections (legacy)");
            return renderedPrompt;
        }
    } catch (error) {
        logger.error("Failed to load user prompt from database", {
            error: error.message,
        });
    }

    return null;
};

/**
 * Reset user prompt cache (both global and workspace-specific)
 * Clears both Redis and in-memory caches
 */
const resetUserPromptCache = async () => {
    workspacePromptCache.clear();
    await deleteCachedPattern("prompt:workspace:*");
    logger.info("User prompt cache cleared (memory + Redis)");
};

/**
 * Clear cache for a specific workspace
 * Clears both Redis and in-memory caches
 * @param {string} workspaceId - The workspace ID to clear cache for
 */
const clearWorkspacePromptCache = async (workspaceId) => {
    if (workspaceId) {
        workspacePromptCache.delete(workspaceId);
        await deleteCached(`prompt:workspace:${workspaceId}`);
        logger.debug("Workspace prompt cache cleared", { workspaceId });
    }
};

const sanitizeNote = (value) => {
    if (!value) {
        return null;
    }

    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length ? text : null;
};

const parseNotesFromContent = (content, maxNotes) => {
    if (!content || typeof content !== "string") {
        return [];
    }

    const trimmed = content.trim();

    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed.map(sanitizeNote).filter(Boolean).slice(0, maxNotes);
        }

        if (parsed && Array.isArray(parsed.notes)) {
            return parsed.notes.map(sanitizeNote).filter(Boolean).slice(0, maxNotes);
        }
    } catch (error) {
        logger.debug("Failed to parse JSON notes from OpenAI summary response, falling back to text parsing", {
            error: error.message,
        });
    }

    const lines = trimmed
        .split(/\n+/)
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter(Boolean);

    return lines.slice(0, maxNotes);
};

const generateConversationNotes = async ({ transcript, maxNotes = 5 }) => {
    if (!transcript || typeof transcript !== "string") {
        return [];
    }

    const client = getOpenAIClient();
    const resolvedMaxNotes = Math.max(1, Math.min(10, Number(maxNotes) || 5));
    const systemPromptText = SUMMARY_SYSTEM_PROMPT.replace("{{maxNotes}}", String(resolvedMaxNotes));
    const messages = [
        {
            role: "system",
            content: systemPromptText,
        },
        {
            role: "user",
            content: ["Conversation transcript:", transcript, "", `Return up to ${resolvedMaxNotes} bullet notes as JSON.`].join("\n"),
        },
    ];

    const requestPayload = {
        model: config.openai?.summaryModel || config.openai?.model || "gpt-4o-mini",
        messages,
        temperature: 0.2,
    };

    try {
        const response = await client.chat.completions.create(requestPayload);
        const content = response.choices?.[0]?.message?.content?.trim();
        const notes = parseNotesFromContent(content, resolvedMaxNotes);

        logger.info("Generated AI notes for conversation", {
            noteCount: notes.length,
        });

        return notes;
    } catch (error) {
        logger.error("Failed to generate conversation notes via OpenAI", {
            error: error.message,
            status: error.status,
            data: error.response?.data || error.stack,
        });
        throw error;
    }
};

/**
 * Upload image to Cloudinary and get a converted JPEG URL.
 * Cloudinary handles all formats including HEIC/HEIF.
 *
 * @param {string} imageUrl - URL of the image to upload
 * @returns {Promise<string>} Public URL of the converted image
 */
const uploadToCloudinary = async (imageUrl) => {
    const cloudinary = require("cloudinary").v2;

    // Configure from CLOUDINARY_URL (format: cloudinary://API_KEY:API_SECRET@CLOUD_NAME)
    cloudinary.config(true);

    // Upload from URL and convert to JPEG
    const result = await cloudinary.uploader.upload(imageUrl, {
        folder: "setdm-images",
        format: "jpg",
        resource_type: "image",
    });

    return result.secure_url;
};

/**
 * Analyze an image to determine if it's a meeting confirmation screenshot or contains inappropriate content.
 * Uses Cloudinary for format conversion and GPT-4 Vision for analysis.
 *
 * @param {string} imageUrl - URL of the image to analyze
 * @returns {Promise<{type: 'meeting_confirmation' | 'inappropriate' | 'other', confidence: number, reason: string}>}
 */
const analyzeImage = async (imageUrl) => {
    if (!imageUrl) {
        throw new Error("Image URL is required for analysis");
    }

    // Check if Cloudinary is configured
    if (!config.cloudinaryUrl) {
        logger.warn("Cloudinary not configured, skipping image analysis");
        return {
            type: "other",
            confidence: 0,
            reason: "Image analysis not configured",
        };
    }

    const client = getOpenAIClient();

    // Upload to Cloudinary and get a public JPEG URL
    let publicImageUrl;
    try {
        publicImageUrl = await uploadToCloudinary(imageUrl);
        logger.debug("Uploaded image to Cloudinary", { publicImageUrl });
    } catch (uploadError) {
        logger.error("Failed to upload image to Cloudinary", {
            error: uploadError.message,
            imageUrl: imageUrl?.substring(0, 100),
        });
        throw uploadError;
    }

    const systemPromptText = `You are an image analysis assistant. Analyze the provided image and determine:

1. Is this a MEETING CONFIRMATION screenshot? Look for:
   - Calendar booking confirmations (Calendly, Cal.com, Google Calendar, etc.)
   - Meeting scheduled confirmations with date/time
   - Booking success messages
   - Calendar invites

2. Does this image contain INAPPROPRIATE/OBSCENE content? Look for:
   - Nudity or sexual content
   - Graphic violence
   - Hate symbols or offensive imagery
   - Drug-related content

If it's a meeting confirmation, extract the meeting date and time if visible.

Respond with a JSON object only, no other text:
{
  "type": "meeting_confirmation" | "inappropriate" | "other",
  "confidence": 0.0-1.0,
  "reason": "brief explanation",
  "meetingDate": "day and date if visible (e.g., 'Monday, December 23rd')" or null,
  "meetingTime": "time if visible (e.g., '2:00 PM EST')" or null
}`;

    try {
        const response = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: systemPromptText,
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: publicImageUrl,
                                detail: "low",
                            },
                        },
                        {
                            type: "text",
                            text: "Analyze this image and respond with the JSON object.",
                        },
                    ],
                },
            ],
            max_tokens: 200,
            temperature: 0.1,
        });

        const content = response.choices?.[0]?.message?.content || "";

        // Try to parse the JSON response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                type: parsed.type || "other",
                confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
                reason: parsed.reason || "No reason provided",
            };
        }

        // Fallback if no valid JSON
        logger.warn("Could not parse image analysis response as JSON", { content });
        return {
            type: "other",
            confidence: 0.5,
            reason: "Could not parse analysis result",
        };
    } catch (error) {
        logger.error("Failed to analyze image with GPT-4 Vision", {
            error: error.message,
            imageUrl: imageUrl?.substring(0, 100),
        });
        throw error;
    }
};

/**
 * Check if a message matches any keyword phrases or activation phrases using AI.
 * This is a lightweight call to determine intent before full AI processing.
 *
 * @param {Object} params
 * @param {string} params.message - The user's message to check
 * @param {string[]} params.keywordPhrases - Array of keyword phrases (trigger keyword sequence)
 * @param {string[]} params.activationPhrases - Array of activation phrases (trigger responded sequence)
 * @returns {Promise<{matchType: 'keyword_phrase'|'activation'|'none', matchedPhrase: string|null, confidence: number}>}
 */
const checkMessageIntent = async ({ message, keywordPhrases = [], activationPhrases = [] }) => {
    // If no phrases configured, skip AI call
    if (keywordPhrases.length === 0 && activationPhrases.length === 0) {
        return { matchType: "none", matchedPhrase: null, confidence: 0 };
    }

    try {
        // Load the intent matching prompt from DB
        const systemPromptContent = await getSystemPromptByType("intentMatching");

        if (!systemPromptContent) {
            logger.error("Intent matching prompt not found in DB - please add prompts.intentMatching to system document");
            return { matchType: "none", matchedPhrase: null, confidence: 0 };
        }

        // Build the user prompt with the phrases
        const userPrompt = `KEYWORD_PHRASES (triggers qualification sequence):
${keywordPhrases.length > 0 ? keywordPhrases.map((p) => `- ${p}`).join("\n") : "- (none configured)"}

ACTIVATION_PHRASES (turns on AI conversation):
${activationPhrases.length > 0 ? activationPhrases.map((p) => `- ${p}`).join("\n") : "- (none configured)"}

USER MESSAGE: "${message}"`;

        const client = getOpenAIClient();
        const intentModel = config.openai?.intentModel || "gpt-4o-mini";
        const response = await client.chat.completions.create({
            model: intentModel,
            messages: [
                { role: "system", content: systemPromptContent },
                { role: "user", content: userPrompt },
            ],
            temperature: 0.1,
            response_format: { type: "json_object" },
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            logger.warn("Empty response from intent matching AI");
            return { matchType: "none", matchedPhrase: null, confidence: 0 };
        }

        const result = JSON.parse(content);
        logger.info("Intent matching result", {
            message: message.substring(0, 50),
            result,
        });

        return {
            matchType: result.matchType || "none",
            matchedPhrase: result.matchedPhrase || null,
            confidence: result.confidence || 0,
        };
    } catch (error) {
        logger.error("Failed to check message intent", {
            error: error.message,
            message: message.substring(0, 50),
        });
        return { matchType: "none", matchedPhrase: null, confidence: 0 };
    }
};

/**
 * Analyze pasted chat conversations and generate structured sequences.
 * This helps users who don't know prompting to create effective sequences.
 *
 * @param {Object} params
 * @param {string} params.chatText - Raw chat text pasted by user
 * @param {string} params.coachName - Name of the coach
 * @param {string} params.businessDescription - Brief description of what they do
 * @returns {Promise<Object>} Structured sequences in our format
 */
const analyzeChatsForSequences = async ({ chatText, coachName = "Coach", businessDescription = "" }) => {
    if (!chatText || chatText.trim().length < 50) {
        throw new Error("Please paste at least a few messages from your conversations");
    }

    try {
        // Load the chat analysis prompt from DB
        const systemPromptContent = await getSystemPromptByType("chatAnalysis");

        if (!systemPromptContent) {
            throw new Error("Chat analysis prompt not configured. Run the seed script first.");
        }

        const userPrompt = `COACH NAME: ${coachName}
BUSINESS DESCRIPTION: ${businessDescription || "Coaching/consulting business"}

CHAT CONVERSATIONS TO ANALYZE:
${chatText}`;

        const client = getOpenAIClient();
        const model = config.openai?.model || "gpt-4o-mini";
        const response = await client.chat.completions.create({
            model,
            messages: [
                { role: "system", content: systemPromptContent },
                { role: "user", content: userPrompt },
            ],
            temperature: 0.3,
            response_format: { type: "json_object" },
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error("No response from AI");
        }

        const result = JSON.parse(content);
        logger.info("Chat analysis completed", {
            coachName,
            hasLead: Boolean(result.sequences?.lead?.script),
            hasQualification: Boolean(result.sequences?.qualification?.script),
            hasBooking: Boolean(result.sequences?.booking?.script),
        });

        return {
            coachName: result.coachName || coachName,
            coachingDetails: result.coachingDetails || "",
            styleNotes: result.styleNotes || "",
            sequences: {
                lead: { script: result.sequences?.lead?.script || "", followups: [] },
                qualification: { script: result.sequences?.qualification?.script || "", followups: [] },
                booking: { script: result.sequences?.booking?.script || "", followups: [] },
                callBooked: { script: result.sequences?.callBooked?.script || "", followups: [] },
                vslLink: "",
            },
            objectionHandlers: result.objectionHandlers || [],
        };
    } catch (error) {
        logger.error("Failed to analyze chats for sequences", {
            error: error.message,
        });
        throw error;
    }
};

module.exports = {
    generateResponse,
    loadSystemPrompt,
    resetSystemPromptCache,
    resetUserPromptCache,
    clearWorkspacePromptCache,
    generateConversationNotes,
    analyzeImage,
    checkMessageIntent,
    analyzeChatsForSequences,
};
