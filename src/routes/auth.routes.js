const express = require('express');
const {
  startInstagramAuth,
  handleInstagramCallback
} = require('../controllers/auth.controller');

const router = express.Router();

router.get('/auth/instagram', startInstagramAuth);
router.get('/auth/instagram/callback', handleInstagramCallback);

module.exports = router;
