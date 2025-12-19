/**
 * Webhook Signature Validation Middleware
 *
 * Validates that incoming webhook requests are genuinely from Meta/Instagram
 * by verifying the X-Hub-Signature-256 header using HMAC SHA256.
 *
 * See: https://developers.facebook.com/docs/messenger-platform/webhooks#validate-payloads
 */

const crypto = require("crypto");
const config = require("../config/environment");
const logger = require("../utils/logger");

/**
 * Verify the X-Hub-Signature-256 header matches the payload
 *
 * @param {Buffer} rawBody - The raw request body as a Buffer
 * @param {string} signature - The signature from X-Hub-Signature-256 header
 * @param {string} appSecret - The Instagram/Meta App Secret
 * @returns {boolean} Whether the signature is valid
 */
const verifySignature = (rawBody, signature, appSecret) => {
    if (!rawBody || !signature || !appSecret) {
        return false;
    }

    // Signature format is "sha256=<hash>"
    const signatureParts = signature.split("=");
    if (signatureParts.length !== 2 || signatureParts[0] !== "sha256") {
        return false;
    }

    const providedHash = signatureParts[1];

    // Compute expected hash
    const expectedHash = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    try {
        return crypto.timingSafeEqual(Buffer.from(providedHash, "hex"), Buffer.from(expectedHash, "hex"));
    } catch (error) {
        // Buffers have different lengths or invalid hex
        return false;
    }
};

/**
 * Express middleware to validate Instagram/Meta webhook signatures
 *
 * Requires the raw body to be available at req.rawBody (set by body-parser verify option)
 */
const validateWebhookSignature = (req, res, next) => {
    const appSecret = config.instagram.appSecret;

    // Skip validation if no app secret is configured (development mode)
    if (!appSecret) {
        logger.warn("Webhook signature validation skipped: INSTAGRAM_APP_SECRET not configured");
        return next();
    }

    // GET requests (verification challenges) don't have signatures
    if (req.method === "GET") {
        return next();
    }

    const signature = req.headers["x-hub-signature-256"];

    // If no signature header, reject the request
    if (!signature) {
        logger.warn("Webhook request rejected: Missing X-Hub-Signature-256 header", {
            ip: req.ip,
            path: req.path,
        });
        return res.status(401).json({ error: "Missing signature header" });
    }

    // Get raw body (set by captureRawBody in app.js)
    const rawBody = req.rawBody;

    if (!rawBody) {
        logger.error("Webhook signature validation failed: Raw body not available", {
            ip: req.ip,
            path: req.path,
        });
        return res.status(500).json({ error: "Unable to validate signature" });
    }

    // Verify the signature
    const isValid = verifySignature(rawBody, signature, appSecret);

    if (!isValid) {
        logger.warn("Webhook request rejected: Invalid signature", {
            ip: req.ip,
            path: req.path,
            providedSignature: signature.substring(0, 20) + "...",
        });
        return res.status(401).json({ error: "Invalid signature" });
    }

    logger.debug("Webhook signature validated successfully", {
        path: req.path,
    });

    next();
};

module.exports = {
    validateWebhookSignature,
    verifySignature,
};
