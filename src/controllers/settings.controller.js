const logger = require('../utils/logger');
const {
  getInstagramUserById,
  updateInstagramUserSettings
} = require('../services/instagram-user.service');
const { disableAutopilotForRecipient } = require('../services/conversation.service');

const DEFAULT_WORKSPACE_SETTINGS = Object.freeze({
  profile: {
    coachName: '',
    brandName: '',
    calendarLink: ''
  },
  autopilot: {
    mode: 'full',
    replyWindowStart: '07:00',
    replyWindowEnd: '22:00',
    handleStoryReplies: true,
    handleCTAReplies: true,
    handleColdDMs: false,
    handoffInjuries: true,
    handoffAngry: true,
    handoffQualified: true
  },
  filters: {
    minAge: 18,
    minFollowers: null,
    hidePrivateAccounts: false,
    allowedCountries: ['USA', 'UK', 'Canada', 'Australia'],
    allowedLanguages: ['English']
  },
  notifications: {
    notifyQualified: true,
    notifyCallBooked: true,
    notifyNeedsReview: true,
    digestFrequency: 'realtime'
  }
});

const mergeWithDefaults = (settings = {}) => ({
  profile: {
    ...DEFAULT_WORKSPACE_SETTINGS.profile,
    ...(settings.profile || {})
  },
  autopilot: {
    ...DEFAULT_WORKSPACE_SETTINGS.autopilot,
    ...(settings.autopilot || {})
  },
  filters: {
    ...DEFAULT_WORKSPACE_SETTINGS.filters,
    ...(settings.filters || {})
  },
  notifications: {
    ...DEFAULT_WORKSPACE_SETTINGS.notifications,
    ...(settings.notifications || {})
  }
});

const normalizeString = (value, fallback = '') => {
  if (typeof value === 'string') {
    return value.trim();
  }
  return typeof fallback === 'string' ? fallback : '';
};

const normalizeTime = (value, fallback) => {
  if (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
    return value.trim();
  }
  return fallback;
};

const normalizeBoolean = (value, fallback) => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const normalizeSelection = (value, allowedValues = [], fallback) => {
  if (typeof value === 'string' && allowedValues.includes(value)) {
    return value;
  }
  return fallback;
};

const normalizeInteger = (value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) => {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  if (Number.isFinite(numericValue)) {
    const rounded = Math.round(numericValue);
    return Math.max(min, Math.min(max, rounded));
  }

  return fallback;
};

const normalizeNullableInteger = (value, fallback, options = {}) => {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.length) {
      return null;
    }
    return normalizeInteger(trimmed, fallback ?? null, options);
  }

  if (typeof value === 'number') {
    return normalizeInteger(value, fallback ?? null, options);
  }

  return fallback ?? null;
};

const normalizeStringArray = (value, fallback = []) => {
  const buildArray = (input) =>
    input
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => Boolean(entry));

  if (Array.isArray(value)) {
    return buildArray(value);
  }

  if (typeof value === 'string') {
    const items = value.split(/[,\n]/);
    return buildArray(items);
  }

  return Array.isArray(fallback) ? [...fallback] : [];
};

const sanitizeSettingsPayload = (payload = {}, existingSettings = {}) => {
  const base = mergeWithDefaults(existingSettings);

  const profilePayload =
    payload && typeof payload.profile === 'object' && payload.profile !== null
      ? payload.profile
      : {};
  const autopilotPayload =
    payload && typeof payload.autopilot === 'object' && payload.autopilot !== null
      ? payload.autopilot
      : {};
  const filtersPayload =
    payload && typeof payload.filters === 'object' && payload.filters !== null
      ? payload.filters
      : {};
  const notificationsPayload =
    payload && typeof payload.notifications === 'object' && payload.notifications !== null
      ? payload.notifications
      : {};

  const profile = {
    coachName: normalizeString(profilePayload.coachName, base.profile.coachName),
    brandName: normalizeString(profilePayload.brandName, base.profile.brandName),
    calendarLink: normalizeString(profilePayload.calendarLink, base.profile.calendarLink)
  };

  const autopilot = {
    mode: normalizeSelection(
      autopilotPayload.mode,
      ['off', 'lead-capture', 'full'],
      base.autopilot.mode
    ),
    replyWindowStart: normalizeTime(
      autopilotPayload.replyWindowStart,
      base.autopilot.replyWindowStart
    ),
    replyWindowEnd: normalizeTime(
      autopilotPayload.replyWindowEnd,
      base.autopilot.replyWindowEnd
    ),
    handleStoryReplies: normalizeBoolean(
      autopilotPayload.handleStoryReplies,
      base.autopilot.handleStoryReplies
    ),
    handleCTAReplies: normalizeBoolean(
      autopilotPayload.handleCTAReplies,
      base.autopilot.handleCTAReplies
    ),
    handleColdDMs: normalizeBoolean(
      autopilotPayload.handleColdDMs,
      base.autopilot.handleColdDMs
    ),
    handoffInjuries: normalizeBoolean(
      autopilotPayload.handoffInjuries,
      base.autopilot.handoffInjuries
    ),
    handoffAngry: normalizeBoolean(
      autopilotPayload.handoffAngry,
      base.autopilot.handoffAngry
    ),
    handoffQualified: normalizeBoolean(
      autopilotPayload.handoffQualified,
      base.autopilot.handoffQualified
    )
  };

  const filters = {
    minAge: normalizeInteger(filtersPayload.minAge, base.filters.minAge, { min: 0, max: 120 }),
    minFollowers: normalizeNullableInteger(filtersPayload.minFollowers, base.filters.minFollowers, {
      min: 0
    }),
    hidePrivateAccounts: normalizeBoolean(
      filtersPayload.hidePrivateAccounts,
      base.filters.hidePrivateAccounts
    ),
    allowedCountries: normalizeStringArray(filtersPayload.allowedCountries, base.filters.allowedCountries),
    allowedLanguages: normalizeStringArray(filtersPayload.allowedLanguages, base.filters.allowedLanguages)
  };

  const notifications = {
    notifyQualified: normalizeBoolean(
      notificationsPayload.notifyQualified,
      base.notifications.notifyQualified
    ),
    notifyCallBooked: normalizeBoolean(
      notificationsPayload.notifyCallBooked,
      base.notifications.notifyCallBooked
    ),
    notifyNeedsReview: normalizeBoolean(
      notificationsPayload.notifyNeedsReview,
      base.notifications.notifyNeedsReview
    ),
    digestFrequency: normalizeSelection(
      notificationsPayload.digestFrequency,
      ['realtime', 'hourly', 'daily'],
      base.notifications.digestFrequency
    )
  };

  return {
    profile,
    autopilot,
    filters,
    notifications
  };
};

const ensureAuthenticatedInstagramId = (req, res) => {
  const instagramId = req.user?.instagramId;

  if (!instagramId) {
    res.status(401).json({ message: 'Authentication required.' });
    return null;
  }

  return instagramId;
};

const getWorkspaceSettings = async (req, res, next) => {
  const instagramId = ensureAuthenticatedInstagramId(req, res);
  if (!instagramId) {
    return undefined;
  }

  try {
    const userDoc = await getInstagramUserById(instagramId);
    const merged = mergeWithDefaults(userDoc?.settings || {});
    return res.json({ data: merged });
  } catch (error) {
    logger.error('Failed to load workspace settings', {
      instagramId,
      error: error.message
    });
    return next(error);
  }
};

const updateWorkspaceSettings = async (req, res, next) => {
  const instagramId = ensureAuthenticatedInstagramId(req, res);
  if (!instagramId) {
    return undefined;
  }

  try {
    const userDoc = await getInstagramUserById(instagramId);
    const previousMode =
      userDoc?.settings?.autopilot?.mode || DEFAULT_WORKSPACE_SETTINGS.autopilot.mode;
    const sanitized = sanitizeSettingsPayload(req.body || {}, userDoc?.settings || {});

    await updateInstagramUserSettings(instagramId, sanitized);

    if (previousMode !== 'off' && sanitized?.autopilot?.mode === 'off') {
      try {
        await disableAutopilotForRecipient(instagramId);
      } catch (bulkDisableError) {
        logger.error('Failed to bulk disable autopilot after workspace update', {
          instagramId,
          error: bulkDisableError.message
        });
      }
    }

    return res.json({ data: mergeWithDefaults(sanitized) });
  } catch (error) {
    logger.error('Failed to update workspace settings', {
      instagramId,
      error: error.message
    });
    return next(error);
  }
};

module.exports = {
  getWorkspaceSettings,
  updateWorkspaceSettings,
  DEFAULT_WORKSPACE_SETTINGS
};
