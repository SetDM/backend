const crypto = require("crypto");
const { getDb } = require("../database/mongo");

const INVITES_COLLECTION = "team_invites";
const MEMBERS_COLLECTION = "team_members";
const MAGIC_LINKS_COLLECTION = "magic_links";

// Generate a secure random token
const generateToken = () => crypto.randomBytes(32).toString("hex");

// ============================================================================
// TEAM INVITES
// ============================================================================

const createInvite = async ({ workspaceId, email, role, invitedBy }) => {
    const db = getDb();
    const now = new Date();
    const token = generateToken();

    // Check if invite already exists for this email + workspace
    const existingInvite = await db.collection(INVITES_COLLECTION).findOne({
        workspaceId,
        email: email.toLowerCase(),
        acceptedAt: null,
        expiresAt: { $gt: now },
    });

    if (existingInvite) {
        // Return existing invite instead of creating new one
        return existingInvite;
    }

    // Check if already a team member
    const existingMember = await db.collection(MEMBERS_COLLECTION).findOne({
        workspaceId,
        email: email.toLowerCase(),
    });

    if (existingMember) {
        const error = new Error("This email is already a team member.");
        error.statusCode = 400;
        throw error;
    }

    const invite = {
        workspaceId,
        email: email.toLowerCase(),
        role,
        token,
        invitedBy,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24 hours
        acceptedAt: null,
        createdAt: now,
    };

    await db.collection(INVITES_COLLECTION).insertOne(invite);
    return invite;
};

const getInviteByToken = async (token) => {
    const db = getDb();
    return db.collection(INVITES_COLLECTION).findOne({ token });
};

const validateInviteToken = async (token) => {
    const invite = await getInviteByToken(token);

    if (!invite) {
        return { valid: false, error: "Invalid invite link." };
    }

    if (invite.acceptedAt) {
        return { valid: false, error: "This invite has already been used." };
    }

    if (new Date() > invite.expiresAt) {
        return { valid: false, error: "This invite has expired." };
    }

    return { valid: true, invite };
};

const acceptInvite = async (token, { name }) => {
    const db = getDb();
    const now = new Date();

    const validation = await validateInviteToken(token);
    if (!validation.valid) {
        const error = new Error(validation.error);
        error.statusCode = 400;
        throw error;
    }

    const { invite } = validation;

    // Create team member
    const member = {
        workspaceId: invite.workspaceId,
        email: invite.email,
        name: name || invite.email.split("@")[0],
        role: invite.role,
        isOwner: false,
        inviteId: invite._id,
        createdAt: now,
        lastLoginAt: now,
    };

    const result = await db.collection(MEMBERS_COLLECTION).insertOne(member);
    member._id = result.insertedId;

    // Mark invite as accepted
    await db.collection(INVITES_COLLECTION).updateOne({ _id: invite._id }, { $set: { acceptedAt: now } });

    // Create initial magic link for login
    const loginToken = await createMagicLink(member._id);

    return { member, loginToken };
};

const getPendingInvites = async (workspaceId) => {
    const db = getDb();
    const now = new Date();

    return db
        .collection(INVITES_COLLECTION)
        .find({
            workspaceId,
            acceptedAt: null,
            expiresAt: { $gt: now },
        })
        .sort({ createdAt: -1 })
        .toArray();
};

const deleteInvite = async (workspaceId, inviteId) => {
    const db = getDb();
    const { ObjectId } = require("mongodb");

    const result = await db.collection(INVITES_COLLECTION).deleteOne({
        _id: new ObjectId(inviteId),
        workspaceId,
        acceptedAt: null,
    });

    return result.deletedCount > 0;
};

// ============================================================================
// TEAM MEMBERS
// ============================================================================

const getTeamMembers = async (workspaceId) => {
    const db = getDb();
    return db.collection(MEMBERS_COLLECTION).find({ workspaceId }).sort({ createdAt: 1 }).toArray();
};

const getTeamMemberById = async (memberId) => {
    const db = getDb();
    const { ObjectId } = require("mongodb");
    return db.collection(MEMBERS_COLLECTION).findOne({ _id: new ObjectId(memberId) });
};

const getTeamMemberByEmail = async (workspaceId, email) => {
    const db = getDb();
    return db.collection(MEMBERS_COLLECTION).findOne({
        workspaceId,
        email: email.toLowerCase(),
    });
};

const updateTeamMember = async (memberId, updates) => {
    const db = getDb();
    const { ObjectId } = require("mongodb");
    const now = new Date();

    const allowedUpdates = {};
    if (updates.name !== undefined) allowedUpdates.name = updates.name;
    if (updates.role !== undefined) allowedUpdates.role = updates.role;
    allowedUpdates.updatedAt = now;

    return db.collection(MEMBERS_COLLECTION).findOneAndUpdate({ _id: new ObjectId(memberId) }, { $set: allowedUpdates }, { returnDocument: "after" });
};

const removeTeamMember = async (workspaceId, memberId) => {
    const db = getDb();
    const { ObjectId } = require("mongodb");

    // Can't remove owner
    const member = await db.collection(MEMBERS_COLLECTION).findOne({ _id: new ObjectId(memberId) });
    if (member?.isOwner) {
        const error = new Error("Cannot remove the workspace owner.");
        error.statusCode = 400;
        throw error;
    }

    const result = await db.collection(MEMBERS_COLLECTION).deleteOne({
        _id: new ObjectId(memberId),
        workspaceId,
    });

    return result.deletedCount > 0;
};

// ============================================================================
// MAGIC LINKS (for team member authentication)
// ============================================================================

const createMagicLink = async (memberId) => {
    const db = getDb();
    const now = new Date();
    const token = generateToken();

    const magicLink = {
        memberId,
        token,
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000), // 15 minutes
        usedAt: null,
        createdAt: now,
    };

    await db.collection(MAGIC_LINKS_COLLECTION).insertOne(magicLink);
    return token;
};

const validateMagicLink = async (token) => {
    const db = getDb();
    const magicLink = await db.collection(MAGIC_LINKS_COLLECTION).findOne({ token });

    if (!magicLink) {
        return { valid: false, error: "Invalid login link." };
    }

    if (magicLink.usedAt) {
        return { valid: false, error: "This login link has already been used." };
    }

    if (new Date() > magicLink.expiresAt) {
        return { valid: false, error: "This login link has expired." };
    }

    return { valid: true, magicLink };
};

const consumeMagicLink = async (token) => {
    const db = getDb();
    const now = new Date();

    const validation = await validateMagicLink(token);
    if (!validation.valid) {
        const error = new Error(validation.error);
        error.statusCode = 400;
        throw error;
    }

    const { magicLink } = validation;

    // Mark as used
    await db.collection(MAGIC_LINKS_COLLECTION).updateOne({ _id: magicLink._id }, { $set: { usedAt: now } });

    // Get member and update last login
    const member = await getTeamMemberById(magicLink.memberId);
    if (!member) {
        const error = new Error("Team member not found.");
        error.statusCode = 404;
        throw error;
    }

    await db.collection(MEMBERS_COLLECTION).updateOne({ _id: member._id }, { $set: { lastLoginAt: now } });

    return member;
};

const requestLoginLink = async (email, workspaceId) => {
    const member = await getTeamMemberByEmail(workspaceId, email);

    if (!member) {
        // Don't reveal if email exists or not
        return null;
    }

    const token = await createMagicLink(member._id);
    return { member, token };
};

module.exports = {
    // Invites
    createInvite,
    getInviteByToken,
    validateInviteToken,
    acceptInvite,
    getPendingInvites,
    deleteInvite,

    // Members
    getTeamMembers,
    getTeamMemberById,
    getTeamMemberByEmail,
    updateTeamMember,
    removeTeamMember,

    // Magic Links
    createMagicLink,
    validateMagicLink,
    consumeMagicLink,
    requestLoginLink,
};
