const express = require('express');
const {
  startInstagramAuth,
  handleInstagramCallback,
  getCurrentUser,
  logout
} = require('../controllers/auth.controller');
const { requireSession } = require('../middleware/session-auth');

const router = express.Router();

router.get('/auth/instagram', startInstagramAuth);
router.get('/auth/instagram/callback', handleInstagramCallback);
router.get('/auth/me', requireSession, getCurrentUser);
router.post('/auth/logout', requireSession, logout);

module.exports = router;
