const OpenAI = require("openai");
const config = require("../config/environment");
const logger = require("../utils/logger");
const {
    getPromptByName,
    getPromptByWorkspace,
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

                if (structured.stageTagging) {
                    parts.push(structured.stageTagging);
                }

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

                if (structured.scenarios) {
                    parts.push(`Different scenarios:\n\n${structured.scenarios}`);
                }

                if (Array.isArray(structured.objectionHandlers) && structured.objectionHandlers.length > 0) {
                    parts.push("Some additional scenarios that might occur:\n");
                    structured.objectionHandlers.forEach((h) => {
                        parts.push(`${h.objection}\nResponse: ${h.response}`);
                    });
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
 * Load only the base instructions from the system prompt (without sequences).
 * Used when user has their own sequences and addToExisting is true.
 */
const loadSystemBaseInstructions = async () => {
    try {
        const promptDoc = await getPromptByName(DEFAULT_PROMPT_NAME);

        if (promptDoc?.structured) {
            const structured = promptDoc.structured;
            const parts = [];

            if (structured.baseInstructions) {
                parts.push(structured.baseInstructions);
            }

            if (structured.stageTagging) {
                parts.push(structured.stageTagging);
            }

            // Include scenarios and objection handlers as they're general guidance
            if (structured.scenarios) {
                parts.push(`Different scenarios:\n\n${structured.scenarios}`);
            }

            if (Array.isArray(structured.objectionHandlers) && structured.objectionHandlers.length > 0) {
                parts.push("Some additional scenarios that might occur:\n");
                structured.objectionHandlers.forEach((h) => {
                    parts.push(`${h.objection}\nResponse: ${h.response}`);
                });
            }

            return parts.join("\n\n");
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

const buildChatMessages = ({ systemPromptText, userPromptText, conversationHistory, userMessage, stageTag, workspaceSettings }) => {
    const messages = [];

    if (systemPromptText) {
        messages.push({ role: "system", content: systemPromptText });
    }

    if (userPromptText) {
        messages.push({ role: "system", content: userPromptText });
    }

    // Add settings-based filtering instructions
    const settingsInstructions = buildSettingsInstructions(workspaceSettings);
    if (settingsInstructions) {
        messages.push({ role: "system", content: settingsInstructions });
    }

    if (stageTag && typeof stageTag === "string" && stageTag.trim().length > 0) {
        messages.push({
            role: "system",
            content: `Context: The prospect's current stage tag is "${stageTag.trim()}". Use this flag to maintain continuity and avoid repeating previously completed steps.`,
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
            userPromptResult = { promptText: typeof options.userPromptText === "string" ? options.userPromptText : "", addToExisting: true };
        } else if (workspaceId) {
            userPromptResult = await loadWorkspacePrompt(workspaceId);
        } else {
            const legacyPrompt = await loadUserPrompt();
            userPromptResult = { promptText: legacyPrompt, addToExisting: true };
        }

        const { promptText: customPrompt, addToExisting } = userPromptResult;

        // Determine which system prompt to use:
        // - If no custom prompt: use full system prompt
        // - If custom prompt AND addToExisting: use base instructions only (user provides their own sequences)
        // - If custom prompt AND NOT addToExisting: skip system prompt entirely
        let systemPromptText = null;
        if (!customPrompt) {
            // No custom prompt - use full system prompt with sequences
            systemPromptText = await loadSystemPrompt();
        } else if (addToExisting) {
            // User has custom sequences but wants to combine with system base instructions
            systemPromptText = await loadSystemBaseInstructions();
        }
        // else: addToExisting is false, systemPromptText stays null (only use user's prompt)

        const client = getOpenAIClient();
        const stageTag = typeof options?.stageTag === "string" ? options.stageTag : null;

        const messages = buildChatMessages({
            systemPromptText,
            userPromptText: customPrompt,
            conversationHistory,
            userMessage,
            stageTag,
            workspaceSettings,
        });

        logger.info("Sending request to OpenAI Chat Completions API", {
            messageCount: messages.length,
            userMessageLength: userMessage.length,
            workspaceId: workspaceId || "default",
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
 * @returns {Object} { promptText, addToExisting }
 */
const loadWorkspacePrompt = async (workspaceId) => {
    if (!workspaceId) {
        const legacyPrompt = await loadUserPrompt();
        return { promptText: legacyPrompt, addToExisting: true };
    }

    const cacheKey = `prompt:workspace:${workspaceId}`;
    const configCacheKey = `prompt:workspace:config:${workspaceId}`;

    // Try Redis cache first
    const redisCached = await getCached(cacheKey);
    const configCached = await getCached(configCacheKey);
    if (redisCached && configCached !== null) {
        logger.debug("Workspace prompt loaded from Redis cache", { workspaceId });
        return { promptText: redisCached, addToExisting: configCached !== "false" };
    }

    // Fallback to in-memory cache
    const memoryCached = workspacePromptCache.get(workspaceId);
    if (memoryCached && typeof memoryCached === "object" && memoryCached.promptText) {
        return memoryCached;
    }

    try {
        const userPromptDoc = await getPromptByWorkspace(workspaceId);

        if (userPromptDoc?.config) {
            const mergedConfig = mergeConfigWithDefaults(userPromptDoc.config);
            const renderedPrompt = buildPromptFromConfig(mergedConfig);
            const addToExisting = mergedConfig.addToExisting !== false;

            if (renderedPrompt && renderedPrompt.trim()) {
                // Cache in both Redis and memory
                await setCached(cacheKey, renderedPrompt, PROMPT_CACHE_TTL);
                await setCached(configCacheKey, String(addToExisting), PROMPT_CACHE_TTL);
                workspacePromptCache.set(workspaceId, { promptText: renderedPrompt, addToExisting });
                logger.info("Workspace prompt loaded from database and cached", { workspaceId, addToExisting });
                return { promptText: renderedPrompt, addToExisting };
            }
        }

        logger.debug("No workspace-specific prompt found, using defaults", { workspaceId });
    } catch (error) {
        logger.error("Failed to load workspace prompt from database", {
            workspaceId,
            error: error.message,
        });
    }

    return { promptText: null, addToExisting: true };
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

module.exports = {
    generateResponse,
    loadSystemPrompt,
    resetSystemPromptCache,
    resetUserPromptCache,
    clearWorkspacePromptCache,
    generateConversationNotes,
};
