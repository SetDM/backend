const config = require('../config/environment');
const logger = require('../utils/logger');
const { generateResponse } = require('./chatgpt.service');
const { sendInstagramTextMessage } = require('./instagram-messaging.service');
const {
  getConversationHistory,
  formatForChatGPT,
  updateConversationStageTag,
  storeMessage,
  enqueueConversationMessage,
  removeQueuedConversationMessage,
  getConversationAutopilotStatus,
  clearQueuedConversationMessages
} = require('./conversation.service');
const { splitMessageByGaps, stripTrailingStageTag } = require('../utils/message-utils');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const maxSpacing = Number.isFinite(configuredMax)
    ? Math.max(minSpacing, Math.floor(configuredMax))
    : 2200;

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
    if (message.role === 'assistant' && message.timestamp) {
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
    if (messages[i].role === 'assistant') {
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
    .filter((msg) => msg.role === 'user' && typeof msg.content === 'string')
    .map((msg) => msg.content.trim())
    .filter(Boolean)
    .join('\n\n');

const normalizeAssistantResponse = (text) => {
  if (typeof text !== 'string') {
    return text;
  }

  return text
    .replace(/—/g, '.')
    .replace(/\s-\s/g, '.');
};

const extractStageTag = (text) => {
  if (typeof text !== 'string') {
    return null;
  }

  const tagMatch = text.match(/\[tag:\s*([^\]]+)\]/i);
  return tagMatch ? tagMatch[1].trim() : null;
};

const stripStageTagFromResponse = (text) => {
  if (typeof text !== 'string') {
    return text;
  }

  return text.replace(/\s*\[tag:[^\]]+\]\s*$/i, '').trim();
};

const isFlagStage = (stageTag) =>
  typeof stageTag === 'string' && stageTag.trim().toLowerCase() === 'flag';

const applyTemplateVariables = (text, replacements = {}, context = {}) => {
  if (!text || typeof text !== 'string') {
    return text;
  }

  return Object.entries(replacements).reduce((acc, [key, value]) => {
    const templateTokens = [`{{${key}}}`];

    if (key === 'CALENDLY_LINK') {
      templateTokens.push('[calendly link]', '[booking_link]');
    }

    return templateTokens.reduce((textAcc, token) => {
      if (!textAcc.includes(token)) {
        return textAcc;
      }

      const tokenRegex = new RegExp(escapeRegExp(token), 'g');

      if (!value) {
        logger.warn('Missing template variable replacement', {
          key,
          token,
          ...context
        });
        return textAcc.replace(tokenRegex, '').trim();
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
  calendlyLink = null
}) => {
  if (!senderId || !businessAccountId) {
    throw new Error('senderId and businessAccountId are required to process AI responses.');
  }

  if (!businessAccount?.tokens?.longLived?.accessToken) {
    throw new Error('Missing Instagram long-lived token for business account.');
  }

  const accessToken = businessAccount.tokens.longLived.accessToken;
  const conversationHistory = await getConversationHistory(senderId, businessAccountId);
  const lastAssistantTimestamp = getLastAssistantTimestamp(conversationHistory);
  const { historyForModel, pendingMessages } = partitionConversationHistory(conversationHistory);

  if (!pendingMessages.length) {
    logger.info('No pending user messages to process with AI', {
      senderId,
      businessAccountId
    });
    return false;
  }

  const latestPendingMid = pendingMessages[pendingMessages.length - 1]?.metadata?.mid || null;
  const referenceMid = incomingMessageMid || latestPendingMid;

  if (!forceProcessPending && !isLatestPendingMessage(pendingMessages, referenceMid)) {
    logger.info('Skipping AI response for earlier user payload; newer message pending', {
      senderId,
      businessAccountId,
      incomingMessageMid: referenceMid,
      latestPendingMid
    });
    return false;
  }

  const combinedPendingUserMessage =
    combinePendingUserMessages(pendingMessages) ||
    pendingMessages[pendingMessages.length - 1]?.content;

  if (!combinedPendingUserMessage) {
    logger.info('Pending user messages lacked text content; skipping AI response', {
      senderId,
      businessAccountId
    });
    return false;
  }

  try {
    await clearQueuedConversationMessages(senderId, businessAccountId);
  } catch (clearQueueError) {
    logger.error('Failed to clear existing queued AI responses before processing new reply', {
      senderId,
      businessAccountId,
      error: clearQueueError.message
    });
  }

  const formattedHistory = formatForChatGPT(historyForModel);

  logger.info('Generating ChatGPT response', {
    senderId,
    pendingMessages: pendingMessages.length,
    combinedMessageLength: combinedPendingUserMessage.length
  });
  const rawAiResponse = await generateResponse(combinedPendingUserMessage, formattedHistory);
  const aiResponseWithTag = normalizeAssistantResponse(
    applyTemplateVariables(
      rawAiResponse,
      {
        CALENDLY_LINK: calendlyLink
      },
      { businessAccountId }
    )
  );

  const stageTag = extractStageTag(aiResponseWithTag);
  if (stageTag) {
    try {
      await updateConversationStageTag(senderId, businessAccountId, stageTag);
    } catch (stageError) {
      logger.error('Failed to update conversation stage tag', {
        senderId,
        stageTag,
        error: stageError.message
      });
    }
  }

  if (isFlagStage(stageTag)) {
    logger.info('Conversation flagged by AI response; suppressing outbound reply', {
      senderId,
      businessAccountId
    });
    return false;
  }

  const displayResponse = stripStageTagFromResponse(aiResponseWithTag) || aiResponseWithTag;

  const rawMessageParts = splitMessageByGaps(displayResponse);
  let partsToSend = rawMessageParts.length ? rawMessageParts : [displayResponse];

  const maxMessageParts = Math.max(1, Number(config.responses?.maxMessageParts) || 3);
  if (partsToSend.length > maxMessageParts) {
    const preserved = partsToSend.slice(0, maxMessageParts - 1);
    const mergedRemainder = partsToSend.slice(maxMessageParts - 1).join('\n\n').trim();
    partsToSend = mergedRemainder ? [...preserved, mergedRemainder] : preserved;
  }

  const primaryDelayMs = Math.max(0, Number(computeReplyDelayMs(lastAssistantTimestamp)) || 0);
  const chunkScheduleDelays =
    primaryDelayMs > 0 ? computeChunkScheduleDelays(primaryDelayMs, partsToSend.length) : [];
  const queuedChunkEntries = new Array(partsToSend.length).fill(null);

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
            chunkTotal: partsToSend.length
          }
        });

        if (entry) {
          queuedChunkEntries[index] = entry;
        }
      } catch (queueError) {
        logger.error('Failed to enqueue AI response chunk; proceeding without queue record', {
          senderId,
          businessAccountId,
          chunkIndex: index,
          error: queueError.message
        });
      }
    }

    if (queuedChunkEntries.some(Boolean)) {
      logger.info('Queued AI response chunks for delayed delivery', {
        senderId,
        businessAccountId,
        chunksQueued: queuedChunkEntries.filter(Boolean).length,
        firstDelayMs: chunkScheduleDelays[0],
        lastDelayMs: chunkScheduleDelays[chunkScheduleDelays.length - 1]
      });
    }
  }

  const needsLatestConfirmation = !forceProcessPending && Boolean(referenceMid);
  let hasConfirmedLatestPending = !needsLatestConfirmation;
  let previousScheduledDelay = 0;

  for (let index = 0; index < partsToSend.length; index += 1) {
    const scheduledDelayMsRaw = chunkScheduleDelays[index];
    const scheduledDelayMs =
      Number.isFinite(scheduledDelayMsRaw) || scheduledDelayMsRaw === 0
        ? scheduledDelayMsRaw
        : index === 0
          ? primaryDelayMs
          : previousScheduledDelay;
    const waitMs = Math.max(0, scheduledDelayMs - previousScheduledDelay);

    if (waitMs > 0) {
      logger.info('Delaying AI chunk delivery to simulate natural chat timing', {
        senderId,
        businessAccountId,
        chunkIndex: index,
        waitMs
      });
      await wait(waitMs);
    }

    previousScheduledDelay = Math.max(previousScheduledDelay, scheduledDelayMs);

    const queueEntry = queuedChunkEntries[index];
    if (queueEntry) {
      const removed = await removeQueuedConversationMessage({
        senderId,
        recipientId: businessAccountId,
        queuedMessageId: queueEntry.id
      });

      if (!removed) {
        logger.info('Queued AI chunk canceled before delivery; aborting response', {
          senderId,
          businessAccountId,
          chunkIndex: index,
          queuedMessageId: queueEntry.id
        });
        return false;
      }

      const autopilotStillEnabled = await getConversationAutopilotStatus(
        senderId,
        businessAccountId
      );

      if (!autopilotStillEnabled) {
        logger.info('Autopilot disabled before queued AI chunk delivery; aborting response', {
          senderId,
          businessAccountId,
          chunkIndex: index
        });
        return false;
      }
    } else if (primaryDelayMs > 0 && chunkScheduleDelays.length) {
      const autopilotStillEnabled = await getConversationAutopilotStatus(
        senderId,
        businessAccountId
      );

      if (!autopilotStillEnabled) {
        logger.info('Autopilot disabled before delivering AI chunk without queue entry; aborting response', {
          senderId,
          businessAccountId,
          chunkIndex: index
        });
        return false;
      }
    }

    if (!hasConfirmedLatestPending) {
      const stillLatest = await confirmLatestPendingMessage({
        senderId,
        businessAccountId,
        incomingMid: referenceMid
      });

      if (!stillLatest) {
        logger.info('Aborting AI response; newer user message detected during delay window', {
          senderId,
          businessAccountId,
          incomingMessageMid: referenceMid
        });
        return false;
      }

      hasConfirmedLatestPending = true;
    }

    await sendInstagramTextMessage({
      instagramBusinessId: businessAccount.instagramId,
      recipientUserId: senderId,
      text: partsToSend[index],
      accessToken
    });
  }

  const chunksToPersist = splitMessageByGaps(aiResponseWithTag);
  const filteredChunks =
    chunksToPersist.length > 1
      ? chunksToPersist.slice(0, -1)
      : [stripTrailingStageTag(aiResponseWithTag)].filter(Boolean);

  await Promise.all(
    filteredChunks.map((chunk, index) =>
      storeMessage(
        senderId,
        businessAccountId,
        chunk,
        'assistant',
        { chunkIndex: index },
        { isAiGenerated: true }
      )
    )
  );

  logger.info('AI response sent to Instagram user', {
    senderId,
    businessAccountId,
    responseLength: displayResponse.length,
    partsSent: partsToSend.length
  });

  return true;
};

module.exports = {
  processPendingMessagesWithAI,
  isFlagStage,
  partitionConversationHistory,
  combinePendingUserMessages
};
