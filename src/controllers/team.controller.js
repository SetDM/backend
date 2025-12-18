const logger = require("../utils/logger");
const config = require("../config/environment");
const teamService = require("../services/team.service");
const { issueTeamMemberToken, setAuthCookie } = require("./auth.controller");

const VALID_ROLES = ["admin", "editor", "viewer"];

// ============================================================================
// INVITES
// ============================================================================

const createInvite = async (req, res, next) => {
    const workspaceId = req.user?.instagramId;
    if (!workspaceId) {
        return res.status(401).json({ message: "Authentication required." });
    }

    try {
        const { email, role } = req.body;

        if (!email || typeof email !== "string") {
            return res.status(400).json({ message: "Email is required." });
        }

        if (!role || !VALID_ROLES.includes(role)) {
            return res.status(400).json({ message: "Valid role is required (admin, editor, viewer)." });
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: "Invalid email format." });
        }

        const invite = await teamService.createInvite({
            workspaceId,
            email: email.trim(),
            role,
            invitedBy: req.user.username || workspaceId,
        });

        const inviteUrl = `${config.frontendUrl}/invite/${invite.token}`;

        logger.info("Team invite created", {
            workspaceId,
            email: invite.email,
            role,
        });

        // Email is sent via Netlify function from frontend
        return res.status(201).json({
            data: {
                id: invite._id,
                email: invite.email,
                role: invite.role,
                expiresAt: invite.expiresAt,
                inviteUrl,
            },
        });
    } catch (error) {
        logger.error("Failed to create team invite", { error: error.message });
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        return next(error);
    }
};

const validateInvite = async (req, res, next) => {
    try {
        const { token } = req.params;

        if (!token) {
            return res.status(400).json({ message: "Invite token is required." });
        }

        const validation = await teamService.validateInviteToken(token);

        if (!validation.valid) {
            return res.status(400).json({ message: validation.error });
        }

        return res.json({
            data: {
                email: validation.invite.email,
                role: validation.invite.role,
                expiresAt: validation.invite.expiresAt,
            },
        });
    } catch (error) {
        logger.error("Failed to validate invite", { error: error.message });
        return next(error);
    }
};

const acceptInvite = async (req, res, next) => {
    try {
        const { token } = req.params;
        const { name } = req.body;

        if (!token) {
            return res.status(400).json({ message: "Invite token is required." });
        }

        const { member } = await teamService.acceptInvite(token, { name });

        // Issue JWT token for the team member
        const authToken = issueTeamMemberToken({
            teamMemberId: member._id.toString(),
            workspaceId: member.workspaceId,
        });

        // Set auth cookie
        setAuthCookie(res, authToken);

        logger.info("Team invite accepted", {
            memberId: member._id,
            workspaceId: member.workspaceId,
            email: member.email,
        });

        return res.json({
            data: {
                id: member._id.toString(),
                email: member.email,
                name: member.name,
                role: member.role,
                workspaceId: member.workspaceId,
                isTeamMember: true,
            },
            token: authToken,
        });
    } catch (error) {
        logger.error("Failed to accept invite", { error: error.message });
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        return next(error);
    }
};

const getPendingInvites = async (req, res, next) => {
    const workspaceId = req.user?.instagramId;
    if (!workspaceId) {
        return res.status(401).json({ message: "Authentication required." });
    }

    try {
        const invites = await teamService.getPendingInvites(workspaceId);

        return res.json({
            data: invites.map((invite) => ({
                id: invite._id,
                email: invite.email,
                role: invite.role,
                expiresAt: invite.expiresAt,
                createdAt: invite.createdAt,
            })),
        });
    } catch (error) {
        logger.error("Failed to get pending invites", { error: error.message });
        return next(error);
    }
};

const deleteInvite = async (req, res, next) => {
    const workspaceId = req.user?.instagramId;
    if (!workspaceId) {
        return res.status(401).json({ message: "Authentication required." });
    }

    try {
        const { inviteId } = req.params;

        const deleted = await teamService.deleteInvite(workspaceId, inviteId);

        if (!deleted) {
            return res.status(404).json({ message: "Invite not found or already accepted." });
        }

        return res.json({ message: "Invite deleted successfully." });
    } catch (error) {
        logger.error("Failed to delete invite", { error: error.message });
        return next(error);
    }
};

// ============================================================================
// TEAM MEMBERS
// ============================================================================

const getTeamMembers = async (req, res, next) => {
    const workspaceId = req.user?.instagramId;
    if (!workspaceId) {
        return res.status(401).json({ message: "Authentication required." });
    }

    try {
        const members = await teamService.getTeamMembers(workspaceId);

        // Add the owner (Instagram account holder) as a virtual member
        const ownerMember = {
            id: "owner",
            email: "",
            name: req.user.username || "Owner",
            role: "admin",
            isOwner: true,
            createdAt: null,
        };

        const formattedMembers = members.map((member) => ({
            id: member._id.toString(),
            email: member.email,
            name: member.name,
            role: member.role,
            isOwner: member.isOwner || false,
            lastLoginAt: member.lastLoginAt,
            createdAt: member.createdAt,
        }));

        return res.json({
            data: [ownerMember, ...formattedMembers],
        });
    } catch (error) {
        logger.error("Failed to get team members", { error: error.message });
        return next(error);
    }
};

const updateTeamMember = async (req, res, next) => {
    const workspaceId = req.user?.instagramId;
    if (!workspaceId) {
        return res.status(401).json({ message: "Authentication required." });
    }

    try {
        const { memberId } = req.params;
        const { name, role } = req.body;

        if (memberId === "owner") {
            return res.status(400).json({ message: "Cannot modify the owner." });
        }

        if (role && !VALID_ROLES.includes(role)) {
            return res.status(400).json({ message: "Invalid role." });
        }

        const member = await teamService.updateTeamMember(memberId, { name, role });

        if (!member) {
            return res.status(404).json({ message: "Team member not found." });
        }

        return res.json({
            data: {
                id: member._id.toString(),
                email: member.email,
                name: member.name,
                role: member.role,
            },
        });
    } catch (error) {
        logger.error("Failed to update team member", { error: error.message });
        return next(error);
    }
};

const removeTeamMember = async (req, res, next) => {
    const workspaceId = req.user?.instagramId;
    if (!workspaceId) {
        return res.status(401).json({ message: "Authentication required." });
    }

    try {
        const { memberId } = req.params;

        if (memberId === "owner") {
            return res.status(400).json({ message: "Cannot remove the owner." });
        }

        const removed = await teamService.removeTeamMember(workspaceId, memberId);

        if (!removed) {
            return res.status(404).json({ message: "Team member not found." });
        }

        logger.info("Team member removed", { workspaceId, memberId });

        return res.json({ message: "Team member removed successfully." });
    } catch (error) {
        logger.error("Failed to remove team member", { error: error.message });
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        return next(error);
    }
};

// ============================================================================
// TEAM MEMBER AUTH (Magic Links)
// ============================================================================

// Get workspaces for an email (for workspace picker)
const getWorkspacesForEmail = async (req, res, next) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }

        const workspaces = await teamService.getWorkspacesForEmail(email);

        // Always return empty array if no workspaces (don't reveal if email exists)
        return res.json({
            data: workspaces,
        });
    } catch (error) {
        logger.error("Failed to get workspaces for email", { error: error.message });
        return next(error);
    }
};

const requestLoginLink = async (req, res, next) => {
    try {
        const { email, workspaceId } = req.body;

        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }

        // First, check how many workspaces this email belongs to
        const workspaces = await teamService.getWorkspacesForEmail(email);

        // If multiple workspaces and no workspaceId specified, return the list
        if (workspaces.length > 1 && !workspaceId) {
            return res.json({
                message: "Multiple workspaces found. Please select one.",
                data: {
                    requiresSelection: true,
                    workspaces,
                },
            });
        }

        // workspaceId is now optional - if not provided and only one workspace, use it
        const result = await teamService.requestLoginLink(email, workspaceId || null);

        // Always return success to not reveal if email exists
        if (result) {
            const loginUrl = `${config.frontendUrl}/team-login/${result.token}`;

            logger.info("Login link created", {
                email,
                workspaceId: result.member.workspaceId,
            });

            // Return login URL so frontend can send email via Netlify function
            return res.json({
                message: "Login link created.",
                data: {
                    loginUrl,
                    name: result.member.name,
                    email: result.member.email,
                    workspaceId: result.member.workspaceId,
                },
            });
        }

        return res.json({
            message: "If an account exists with this email, a login link has been sent.",
        });
    } catch (error) {
        logger.error("Failed to request login link", { error: error.message });
        return next(error);
    }
};

const loginWithMagicLink = async (req, res, next) => {
    try {
        const { token } = req.params;

        if (!token) {
            return res.status(400).json({ message: "Login token is required." });
        }

        const member = await teamService.consumeMagicLink(token);

        // Issue JWT token for the team member
        const authToken = issueTeamMemberToken({
            teamMemberId: member._id.toString(),
            workspaceId: member.workspaceId,
        });

        // Set auth cookie
        setAuthCookie(res, authToken);

        logger.info("Team member logged in via magic link", {
            memberId: member._id,
            email: member.email,
        });

        return res.json({
            data: {
                id: member._id.toString(),
                email: member.email,
                name: member.name,
                role: member.role,
                workspaceId: member.workspaceId,
                isTeamMember: true,
            },
            token: authToken,
        });
    } catch (error) {
        logger.error("Failed to login with magic link", { error: error.message });
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        return next(error);
    }
};

module.exports = {
    // Invites
    createInvite,
    validateInvite,
    acceptInvite,
    getPendingInvites,
    deleteInvite,

    // Members
    getTeamMembers,
    updateTeamMember,
    removeTeamMember,

    // Auth
    getWorkspacesForEmail,
    requestLoginLink,
    loginWithMagicLink,
};
