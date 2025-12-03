const express = require('express');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const webhookRoutes = require('./webhook.routes');
const promptRoutes = require('./prompt.routes');

const router = express.Router();

router.use('/api', healthRoutes);
router.use('/api', authRoutes);
router.use('/api', webhookRoutes);
router.use('/api', promptRoutes);

module.exports = router;
