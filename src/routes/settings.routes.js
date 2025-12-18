const express = require("express");
const { requireSession } = require("../middleware/session-auth");
const { requireSettingsPermission } = require("../middleware/permissions");
const { getWorkspaceSettings, updateWorkspaceSettings } = require("../controllers/settings.controller");

const router = express.Router();

// Anyone can view settings
router.get("/settings", requireSession, getWorkspaceSettings);

// Only admins/owners can edit settings
router.put("/settings", requireSession, requireSettingsPermission, updateWorkspaceSettings);

module.exports = router;
