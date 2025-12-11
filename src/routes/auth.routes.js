const express = require('express');
const {
  startInstagramAuth,
  handleInstagramCallback,
  getCurrentUser,
  logout,
  unlinkInstagramAccount
} = require('../controllers/auth.controller');
const { requireSession } = require('../middleware/session-auth');

const router = express.Router();

router.get('/auth/instagram', startInstagramAuth);
router.get('/auth/instagram/callback', handleInstagramCallback);
router.get('/auth/me', requireSession, getCurrentUser);
router.post('/auth/logout', requireSession, logout);
router.post('/auth/unlink', requireSession, unlinkInstagramAccount);

module.exports = router;
