const express = require("express");
const healthRoutes = require("./health.routes");
const authRoutes = require("./auth.routes");
const webhookRoutes = require("./webhook.routes");
const promptRoutes = require("./prompt.routes");
const userRoutes = require("./user.routes");
const conversationRoutes = require("./conversation.routes");
const settingsRoutes = require("./settings.routes");
const followersRoutes = require("./followers.routes");
const teamRoutes = require("./team.routes");

const router = express.Router();

router.use("/api", healthRoutes);
router.use("/api", authRoutes);
router.use("/api", webhookRoutes);
router.use("/api", promptRoutes);
router.use("/api", conversationRoutes);
router.use("/api", settingsRoutes);
router.use("/api", userRoutes);
router.use("/api", followersRoutes);
router.use("/api", teamRoutes);

module.exports = router;
