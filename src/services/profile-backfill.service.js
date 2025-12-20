/**
 * Profile Backfill Service
 *
 * Periodically fetches missing Instagram profile data for users
 * to improve UX when initial profile fetch failed.
 */

const { connectToDatabase, getDb } = require("../database/mongo");
const { fetchInstagramProfileById } = require("./instagram.service");
const { getInstagramUserById } = require("./instagram-user.service");
const logger = require("../utils/logger");

const USERS_COLLECTION = "users";
const CONVERSATIONS_COLLECTION = "conversations";

// Run backfill every 30 minutes
const BACKFILL_INTERVAL_MS = 30 * 60 * 1000;

// Max profiles to process per run (to avoid rate limits)
const MAX_PROFILES_PER_RUN = 20;

let backfillTimer = null;

/**
 * Find users with missing profile data
 */
const findUsersWithMissingProfiles = async () => {
    await connectToDatabase();
    const db = getDb();

    // Find users without username
    const usersWithMissingData = await db
        .collection(USERS_COLLECTION)
        .find({
            $or: [{ username: null }, { username: { $exists: false } }],
        })
        .limit(MAX_PROFILES_PER_RUN)
        .toArray();

    return usersWithMissingData;
};

/**
 * Find unique sender IDs from conversations that don't have a user profile
 */
const findConversationSendersWithoutProfiles = async () => {
    await connectToDatabase();
    const db = getDb();

    // Get distinct sender IDs from conversations using aggregation (distinct not supported in API v1)
    const senderAggResult = await db
        .collection(CONVERSATIONS_COLLECTION)
        .aggregate([{ $group: { _id: "$senderId" } }, { $limit: 500 }])
        .toArray();

    const senderIds = senderAggResult.map((doc) => doc._id).filter(Boolean);

    if (senderIds.length === 0) {
        return [];
    }

    // Find which ones don't have a profile
    const existingProfiles = await db
        .collection(USERS_COLLECTION)
        .find({ instagramId: { $in: senderIds } })
        .project({ instagramId: 1 })
        .toArray();

    const existingIds = new Set(existingProfiles.map((p) => p.instagramId));
    const missingIds = senderIds.filter((id) => !existingIds.has(id));

    return missingIds.slice(0, MAX_PROFILES_PER_RUN);
};

/**
 * Update a user's profile data
 */
const updateUserProfile = async (instagramId, profileData) => {
    await connectToDatabase();
    const db = getDb();

    await db.collection(USERS_COLLECTION).updateOne(
        { instagramId },
        {
            $set: {
                username: profileData.username || null,
                name: profileData.name || null,
                profilePic: profileData.profile_pic || null,
                followerCount: Number.isFinite(profileData.follower_count) ? profileData.follower_count : null,
                isUserFollowBusiness: typeof profileData.is_user_follow_business === "boolean" ? profileData.is_user_follow_business : null,
                isBusinessFollowUser: typeof profileData.is_business_follow_user === "boolean" ? profileData.is_business_follow_user : null,
                updatedAt: new Date(),
            },
        }
    );
};

/**
 * Create a user profile if it doesn't exist
 */
const createUserProfile = async (instagramId, profileData) => {
    await connectToDatabase();
    const db = getDb();

    const now = new Date();
    await db.collection(USERS_COLLECTION).insertOne({
        instagramId,
        username: profileData.username || null,
        name: profileData.name || null,
        profilePic: profileData.profile_pic || null,
        followerCount: Number.isFinite(profileData.follower_count) ? profileData.follower_count : null,
        isUserFollowBusiness: typeof profileData.is_user_follow_business === "boolean" ? profileData.is_user_follow_business : null,
        isBusinessFollowUser: typeof profileData.is_business_follow_user === "boolean" ? profileData.is_business_follow_user : null,
        createdAt: now,
        updatedAt: now,
    });
};

/**
 * Get an access token for a workspace that has conversations with this user
 */
const getAccessTokenForUser = async (instagramUserId) => {
    await connectToDatabase();
    const db = getDb();

    // Find a conversation with this user to get the business account
    const conversation = await db.collection(CONVERSATIONS_COLLECTION).findOne({ senderId: instagramUserId });

    if (!conversation?.recipientId) {
        return null;
    }

    const businessAccount = await getInstagramUserById(conversation.recipientId);
    return businessAccount?.tokens?.longLived?.accessToken || null;
};

/**
 * Run the profile backfill process
 */
const runProfileBackfill = async () => {
    logger.info("Starting profile backfill job");

    let updatedCount = 0;
    let createdCount = 0;
    let failedCount = 0;

    try {
        // First, update existing users with missing data
        const usersWithMissingData = await findUsersWithMissingProfiles();

        for (const user of usersWithMissingData) {
            try {
                const accessToken = await getAccessTokenForUser(user.instagramId);
                if (!accessToken) {
                    continue;
                }

                const profile = await fetchInstagramProfileById({
                    instagramId: user.instagramId,
                    accessToken,
                });

                if (profile?.username) {
                    await updateUserProfile(user.instagramId, profile);
                    updatedCount++;
                    logger.debug("Updated profile for user", { instagramId: user.instagramId, username: profile.username });
                }
            } catch (error) {
                failedCount++;
                logger.debug("Failed to backfill profile", { instagramId: user.instagramId, error: error.message });
            }

            // Small delay to avoid rate limits
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // Then, create profiles for conversation senders without any profile
        const missingProfileIds = await findConversationSendersWithoutProfiles();

        for (const instagramId of missingProfileIds) {
            try {
                const accessToken = await getAccessTokenForUser(instagramId);
                if (!accessToken) {
                    continue;
                }

                const profile = await fetchInstagramProfileById({
                    instagramId,
                    accessToken,
                });

                if (profile) {
                    await createUserProfile(instagramId, profile);
                    createdCount++;
                    logger.debug("Created profile for user", { instagramId, username: profile.username });
                }
            } catch (error) {
                failedCount++;
                logger.debug("Failed to create profile", { instagramId, error: error.message });
            }

            // Small delay to avoid rate limits
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        logger.info("Profile backfill job completed", {
            updated: updatedCount,
            created: createdCount,
            failed: failedCount,
        });
    } catch (error) {
        logger.error("Profile backfill job failed", { error: error.message });
    }
};

/**
 * Start the periodic backfill job
 */
const startProfileBackfill = () => {
    if (backfillTimer) {
        return;
    }

    // Run once after a short delay on startup
    setTimeout(() => {
        runProfileBackfill().catch((err) => {
            logger.error("Initial profile backfill failed", { error: err.message });
        });
    }, 60000); // Wait 1 minute after startup

    // Then run periodically
    backfillTimer = setInterval(() => {
        runProfileBackfill().catch((err) => {
            logger.error("Periodic profile backfill failed", { error: err.message });
        });
    }, BACKFILL_INTERVAL_MS);

    logger.info("Profile backfill scheduler started", { intervalMs: BACKFILL_INTERVAL_MS });
};

/**
 * Stop the periodic backfill job
 */
const stopProfileBackfill = () => {
    if (backfillTimer) {
        clearInterval(backfillTimer);
        backfillTimer = null;
        logger.info("Profile backfill scheduler stopped");
    }
};

module.exports = {
    runProfileBackfill,
    startProfileBackfill,
    stopProfileBackfill,
};
