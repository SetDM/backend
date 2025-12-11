const express = require('express');
const { requireSession } = require('../middleware/session-auth');
const {
  getWorkspaceSettings,
  updateWorkspaceSettings
} = require('../controllers/settings.controller');

const router = express.Router();

router.get('/settings', requireSession, getWorkspaceSettings);
router.put('/settings', requireSession, updateWorkspaceSettings);

module.exports = router;
