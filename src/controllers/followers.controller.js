const { parse } = require('csv-parse/sync');
const logger = require('../utils/logger');
const {
  bulkUpsertFollowers,
  countFollowersByOwner,
  findFollowersForEnrichment,
  updateFollowerEnrichment,
  markFollowerEnrichmentError
} = require('../services/followers.service');
const { fetchInstagramBioByUsername } = require('../services/instagram.service');

const FILENAME_PATTERN = /followers_(\d+)/i;
const ADMIN_TOKEN_HEADER = 'x-admin-token';

const deriveInstagramId = ({ filename, provided }) => {
  if (provided && String(provided).trim()) {
    return String(provided).trim();
  }

  if (!filename) {
    return null;
  }

  const match = filename.match(FILENAME_PATTERN);
  return match?.[1] || null;
};

const parseCsvBuffer = (buffer) => {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return [];
  }

  const text = buffer.toString('utf8');
  if (!text.trim()) {
    return [];
  }

  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
};

const importFollowersCsv = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'CSV file is required.' });
    }

    const ownerInstagramId = deriveInstagramId({
      filename: req.file.originalname,
      provided: req.body?.ownerInstagramId
    });

    if (!ownerInstagramId) {
      return res.status(400).json({
        message:
          'Unable to determine owner Instagram ID. Include it in the filename (followers_<ig_user_id>.csv) or provide ownerInstagramId in the form.'
      });
    }

    const rows = parseCsvBuffer(req.file.buffer);

    if (!rows.length) {
      return res.status(400).json({ message: 'CSV file did not contain any rows.' });
    }

    const result = await bulkUpsertFollowers({ ownerInstagramId, rows });
    const total = await countFollowersByOwner(ownerInstagramId);

    return res.json({
      ownerInstagramId,
      processed: result.processed,
      upserts: result.upserts,
      modified: result.modified,
      totalStored: total,
      filename: req.file.originalname
    });
  } catch (error) {
    logger.error('Failed to import followers CSV', {
      error: error.message,
      stack: error.stack
    });
    return next(error);
  }
};

const enrichFollowers = async (req, res, next) => {
  try {
    const sessionInstagramId = req.user?.instagramId ? String(req.user.instagramId) : null;
    const ownerInstagramIdInput =
      req.params?.ownerInstagramId || req.body?.ownerInstagramId || sessionInstagramId;
    if (!ownerInstagramIdInput) {
      return res.status(400).json({ message: 'ownerInstagramId is required.' });
    }
    const ownerInstagramId = String(ownerInstagramIdInput);

    const limitInput = Number(req.body?.limit ?? req.query?.limit ?? 25);
    const limit = Number.isFinite(limitInput) ? Math.min(100, Math.max(1, limitInput)) : 25;
    const force = req.body?.force === true || req.query?.force === 'true';

    const adminToken = req.get(ADMIN_TOKEN_HEADER);
    if (!adminToken) {
      logger.warn('Enrichment called without admin token header');
    }

    if (sessionInstagramId && sessionInstagramId !== ownerInstagramId) {
      logger.info('Enriching followers for different owner', {
        actingInstagramId: sessionInstagramId,
        ownerInstagramId
      });
    }

    const followers = await findFollowersForEnrichment({ ownerInstagramId, limit, force });

    if (!followers.length) {
      return res.json({
        ownerInstagramId,
        requested: 0,
        updated: 0,
        failed: 0,
        message: 'No followers available for enrichment.'
      });
    }

    const successes = [];
    const failures = [];

    for (const follower of followers) {
      const followerInstagramId = String(follower.followerInstagramId);
      const username = follower.username ? String(follower.username).trim() : '';

      if (!username) {
        const message = 'Username missing for follower; cannot fetch biography.';
        logger.warn('Follower enrichment skipped due to missing username', {
          ownerInstagramId,
          followerInstagramId
        });
        await markFollowerEnrichmentError({
          ownerInstagramId,
          followerInstagramId,
          error: { message, details: null }
        });
        failures.push({ followerInstagramId, error: message, details: null });
        continue;
      }

      try {
        const profile = await fetchInstagramBioByUsername(username);

        await updateFollowerEnrichment({
          ownerInstagramId,
          followerInstagramId,
          enrichment: {
            biography: profile?.biography || null,
            status: profile?.biography ? 'success' : 'no_bio',
            fetchedAt: new Date()
          }
        });

        successes.push(followerInstagramId);
      } catch (error) {
        logger.warn('Follower enrichment failed', {
          ownerInstagramId,
          followerInstagramId,
          username,
          error: error.message
        });
        await markFollowerEnrichmentError({
          ownerInstagramId,
          followerInstagramId,
          error: {
            message: error.message,
            details: error.details || null
          }
        });
        failures.push({
          followerInstagramId,
          error: error.message,
          details: error.details || null
        });
      }
    }

    return res.json({
      ownerInstagramId,
      requested: followers.length,
      updated: successes.length,
      failed: failures.length,
      failures
    });
  } catch (error) {
    logger.error('Failed to enrich followers', { error: error.message });
    return next(error);
  }
};

module.exports = {
  importFollowersCsv,
  enrichFollowers
};
