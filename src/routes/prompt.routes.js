const express = require("express");
const requirePromptAdmin = require("../middleware/prompt-admin-auth");
const { requireSession } = require("../middleware/session-auth");
const { requireEditPermission } = require("../middleware/permissions");
const { getSystemPrompt, updateSystemPrompt, getUserPrompt, updateUserPrompt, testUserPrompt } = require("../controllers/prompt.controller");

const router = express.Router();

// System prompts - admin only
router.get("/prompts/system", requirePromptAdmin, getSystemPrompt);
router.put("/prompts/system", requirePromptAdmin, updateSystemPrompt);

// User prompts - view for all, edit for editors+
router.get("/prompts/user", requireSession, getUserPrompt);
router.put("/prompts/user", requireSession, requireEditPermission, updateUserPrompt);
router.post("/prompts/user/test", requireSession, requireEditPermission, testUserPrompt);

module.exports = router;
