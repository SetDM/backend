const express = require('express');
const { requireSession } = require('../middleware/session-auth');
const { getUserProfile } = require('../controllers/user.controller');

const router = express.Router();

router.get('/users/:instagramId', requireSession, getUserProfile);

module.exports = router;
