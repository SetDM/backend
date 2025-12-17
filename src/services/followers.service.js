const { connectToDatabase, getDb } = require('../database/mongo');

const COLLECTION_NAME = 'instagram_followers';

const parseBoolean = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

const parseNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const extractFollowerInstagramId = (row = {}) =>
  row.fbid_v2 || row.pk_id || row.pk || row.id || row.instagram_id || null;

const normalizeFollowerDoc = ({ ownerInstagramId, row }) => {
  const followerInstagramId = extractFollowerInstagramId(row);
  if (!followerInstagramId) {
    return null;
  }

  return {
    ownerInstagramId,
    followerInstagramId: String(followerInstagramId),
    username: row.username || null,
    fullName: row.full_name || row.name || null,
    profilePicUrl: row.profile_pic_url || row.profile_pic_url_hd || null,
    isPrivate: parseBoolean(row.is_private),
    isVerified: parseBoolean(row.is_verified),
    followerCounts: {
      followers: parseNumber(row.followers || row.edge_followed_by?.count),
      following: parseNumber(row.following || row.edge_follow?.count)
    },
    importedAt: new Date(),
    updatedAt: new Date(),
    source: {
      type: 'csv',
      raw: row
    }
  };
};

const bulkUpsertFollowers = async ({ ownerInstagramId, rows }) => {
  if (!ownerInstagramId) {
    throw new Error('ownerInstagramId is required to store followers.');
  }

  if (!Array.isArray(rows) || !rows.length) {
    return { processed: 0, upserts: 0 };
  }

  await connectToDatabase();
  const db = getDb();

  const operations = rows
    .map((row) => normalizeFollowerDoc({ ownerInstagramId, row }))
    .filter(Boolean)
    .map((doc) => ({
      updateOne: {
        filter: {
          ownerInstagramId: doc.ownerInstagramId,
          followerInstagramId: doc.followerInstagramId
        },
        update: {
          $set: {
            ...doc,
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        upsert: true
      }
    }));

  if (!operations.length) {
    return { processed: rows.length, upserts: 0 };
  }

  const result = await db.collection(COLLECTION_NAME).bulkWrite(operations, { ordered: false });

  return {
    processed: rows.length,
    upserts: result.upsertedCount || 0,
    modified: result.modifiedCount || 0
  };
};

const findFollowersForEnrichment = async ({ ownerInstagramId, limit = 25, force = false }) => {
  if (!ownerInstagramId) {
    throw new Error('ownerInstagramId is required.');
  }

  await connectToDatabase();
  const db = getDb();

  const query = {
    ownerInstagramId: String(ownerInstagramId)
  };

  if (!force) {
    query.$or = [
      { enrichment: { $exists: false } },
      { 'enrichment.status': { $ne: 'success' } },
      { 'enrichment.fetchedAt': { $exists: false } }
    ];
  }

  return db
    .collection(COLLECTION_NAME)
    .find(query)
    .sort({ 'enrichment.fetchedAt': 1, updatedAt: 1 })
    .limit(Math.max(1, limit))
    .toArray();
};

const updateFollowerEnrichment = async ({ ownerInstagramId, followerInstagramId, enrichment }) => {
  if (!ownerInstagramId || !followerInstagramId) {
    throw new Error('ownerInstagramId and followerInstagramId are required.');
  }

  await connectToDatabase();
  const db = getDb();

  const now = new Date();

  const updateDoc = {
    $set: {
      updatedAt: now,
      enrichment: {
        ...(enrichment || {}),
        fetchedAt: enrichment?.fetchedAt || now,
        status: enrichment?.status || 'success'
      }
    }
  };

  return db.collection(COLLECTION_NAME).updateOne(
    {
      ownerInstagramId: String(ownerInstagramId),
      followerInstagramId: String(followerInstagramId)
    },
    updateDoc
  );
};

const markFollowerEnrichmentError = async ({ ownerInstagramId, followerInstagramId, error }) => {
  if (!ownerInstagramId || !followerInstagramId) {
    return;
  }

  await connectToDatabase();
  const db = getDb();

  await db.collection(COLLECTION_NAME).updateOne(
    {
      ownerInstagramId: String(ownerInstagramId),
      followerInstagramId: String(followerInstagramId)
    },
    {
      $set: {
        updatedAt: new Date(),
        enrichment: {
          status: 'error',
          message: error?.message || 'Failed to enrich follower',
          details: error?.details || null,
          fetchedAt: new Date()
        }
      }
    }
  );
};

const countFollowersByOwner = async (ownerInstagramId) => {
  if (!ownerInstagramId) {
    return 0;
  }

  await connectToDatabase();
  const db = getDb();
  return db.collection(COLLECTION_NAME).countDocuments({ ownerInstagramId: String(ownerInstagramId) });
};

module.exports = {
  bulkUpsertFollowers,
  findFollowersForEnrichment,
  updateFollowerEnrichment,
  markFollowerEnrichmentError,
  countFollowersByOwner
};
