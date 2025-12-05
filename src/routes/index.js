const express = require('express');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const webhookRoutes = require('./webhook.routes');
const promptRoutes = require('./prompt.routes');
const userRoutes = require('./user.routes');
const conversationRoutes = require('./conversation.routes');

const router = express.Router();

router.use('/api', healthRoutes);
router.use('/api', authRoutes);
router.use('/api', webhookRoutes);
router.use('/api', promptRoutes);
router.use('/api', conversationRoutes);
router.use('/api', userRoutes);

module.exports = router;
