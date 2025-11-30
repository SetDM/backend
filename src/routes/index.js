const express = require('express');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const webhookRoutes = require('./webhook.routes');

const router = express.Router();

router.use('/api', healthRoutes);
router.use('/api', authRoutes);
router.use('/api', webhookRoutes);

module.exports = router;
