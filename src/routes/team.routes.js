const express = require("express");
const { requireSession } = require("../middleware/session-auth");
const teamController = require("../controllers/team.controller");

const router = express.Router();

// ============================================================================
// INVITES (require authentication as workspace owner)
// ============================================================================

// Create a new invite
router.post("/team/invites", requireSession, teamController.createInvite);

// Get pending invites for the workspace
router.get("/team/invites", requireSession, teamController.getPendingInvites);

// Delete/cancel an invite
router.delete("/team/invites/:inviteId", requireSession, teamController.deleteInvite);

// ============================================================================
// INVITE ACCEPTANCE (public - accessed via invite link)
// ============================================================================

// Validate an invite token (check if valid before showing accept form)
router.get("/team/invites/validate/:token", teamController.validateInvite);

// Accept an invite (creates team member account)
router.post("/team/invites/accept/:token", teamController.acceptInvite);

// ============================================================================
// TEAM MEMBERS (require authentication as workspace owner)
// ============================================================================

// List all team members
router.get("/team/members", requireSession, teamController.getTeamMembers);

// Update a team member
router.patch("/team/members/:memberId", requireSession, teamController.updateTeamMember);

// Remove a team member
router.delete("/team/members/:memberId", requireSession, teamController.removeTeamMember);

// ============================================================================
// TEAM MEMBER AUTH (magic link login)
// ============================================================================

// Get workspaces for an email (for workspace picker)
router.post("/team/auth/workspaces", teamController.getWorkspacesForEmail);

// Request a login link (sends email)
router.post("/team/auth/request-login", teamController.requestLoginLink);

// Login with magic link token
router.post("/team/auth/login/:token", teamController.loginWithMagicLink);

module.exports = router;
