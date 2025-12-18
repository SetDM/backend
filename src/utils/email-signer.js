const crypto = require("crypto");

const EMAIL_SIGNING_SECRET = process.env.EMAIL_SIGNING_SECRET || "setdm-email-secret-change-in-prod";
const SIGNATURE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sign an email request payload
 * @param {Object} payload - { type, to, ...data }
 * @returns {Object} - { signature, timestamp }
 */
const signEmailRequest = (payload) => {
    const timestamp = Date.now();
    const dataToSign = JSON.stringify({ ...payload, timestamp });

    const signature = crypto.createHmac("sha256", EMAIL_SIGNING_SECRET).update(dataToSign).digest("hex");

    return { signature, timestamp };
};

/**
 * Verify an email request signature
 * @param {Object} payload - The email payload (type, to, etc.)
 * @param {string} signature - The signature to verify
 * @param {number} timestamp - The timestamp when signature was created
 * @returns {boolean} - Whether the signature is valid
 */
const verifyEmailSignature = (payload, signature, timestamp) => {
    // Check if timestamp is within expiry window
    const now = Date.now();
    if (now - timestamp > SIGNATURE_EXPIRY_MS) {
        return false;
    }

    // Recreate the signature
    const dataToSign = JSON.stringify({ ...payload, timestamp });
    const expectedSignature = crypto.createHmac("sha256", EMAIL_SIGNING_SECRET).update(dataToSign).digest("hex");

    // Use timing-safe comparison
    return crypto.timingSafeEquals(Buffer.from(signature, "hex"), Buffer.from(expectedSignature, "hex"));
};

module.exports = {
    signEmailRequest,
    verifyEmailSignature,
    EMAIL_SIGNING_SECRET,
};
