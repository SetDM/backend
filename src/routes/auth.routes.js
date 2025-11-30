const express = require('express');
const {
  startInstagramAuth,
  handleInstagramCallback,
  sendInstagramDm
} = require('../controllers/auth.controller');

const router = express.Router();

router.get('/auth/instagram', startInstagramAuth);
router.get('/auth/instagram/callback', handleInstagramCallback);
router.post('/auth/instagram/send-dm', sendInstagramDm);

module.exports = router;
