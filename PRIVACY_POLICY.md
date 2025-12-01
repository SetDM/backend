# Privacy Policy

**Last updated: November 2025**

## 1 Overview
SetDM ("we," "us," "our") operates an API that helps fitness and creator-focused teams authenticate with Meta/Instagram, receive webhook notifications, and store Instagram account metadata securely. This policy explains how we collect, use, and protect personal data processed through our backend service.

## 2. Data We Collect
- **Instagram OAuth Data:** Instagram user ID, username, account type, short-lived token, long-lived token, and token-expiration metadata created during the OAuth flow.
- **Webhook Payloads:** Verification challenges plus Instagram update payloads delivered to `/api/webhooks/instagram`. These payloads are logged transiently and stored in-memory for the inspection endpoint.
- **System & Usage Data:** Request metadata (timestamps, endpoint paths, limited IP-derived information) captured in server logs for observability and debugging.
- **Configuration Secrets:** App credentials supplied via environment variables (Instagram App ID/Secret, webhook verify token, Mongo URI). These remain on the server and are never shared externally.

## 3. How We Use Data
- Authenticate users with Instagram and return tokens to authorized clients.
- Persist Instagram profile and token metadata in MongoDB (`instagram_users` collection) so clients can manage their integrations.
- Validate and log webhook requests from Meta for monitoring and troubleshooting.
- Secure the service, diagnose issues, and improve reliability/performance.
- Comply with legal obligations and enforce platform terms.

## 4. Token & Messaging Data
- Tokens are stored encrypted-at-rest within the configured MongoDB deployment (MongoDB Atlas or equivalent). Only authorized service components can access them.
- Webhook payloads are used solely to confirm delivery and are not repurposed for marketing.
- No automated outbound messaging occurs within this backend. Clients control how returned tokens are used downstream.
- Users can revoke or request deletion of stored data by contacting us (see Section 13).

## 5. Data Sharing
We do not sell personal data. We share limited data only with:
- **Meta Platforms:** As required to complete OAuth flows and receive webhook notifications.
- **Infrastructure Providers:** Hosting (e.g., Vercel) and MongoDB Atlas to operate the service.
- **Legal Authorities:** If compelled by law or to enforce agreements.
- **Business Transfers:** In the event of merger, acquisition, or reorganization—subject to this policy’s safeguards.

## 6. Security
- All endpoints require HTTPS. Secrets are injected via environment variables and excluded from source control.
- Access controls, monitoring, and logging protect production systems.
- Despite safeguards, no system is completely secure; we continuously patch dependencies and monitor for threats.
- If a data breach likely affects personal information, we will notify impacted users and authorities within 72 hours where legally required.

## 7. Data Retention
- Instagram user records (profile + token metadata) persist until the account is removed or 60 days after access is revoked, whichever occurs first.
- Webhook payloads are stored only in-memory and cleared whenever the process restarts; log entries follow standard operational retention (≤30 days unless law requires longer).
- Backups inherit the same retention policies as their source data.

## 8. User Rights
Depending on jurisdiction (GDPR, CCPA, etc.), users may:
- Access, correct, delete, or export the Instagram data we store.
- Object to certain processing or request restrictions.
- Withdraw consent where applicable.
To exercise rights, email **ayden14567@gmail.com**. We may need to verify identity and Meta account ownership.

## 9. International Transfers
Data may be processed in the United States or other countries where our infrastructure providers operate. We rely on Standard Contractual Clauses or comparable safeguards for cross-border transfers when required.

## 10. Cookies & Tracking
This backend does not set cookies. If deployed behind a separate frontend, refer to that product’s cookie policy. Server logs capture IP addresses and headers strictly for security and analytics.

## 11. Children’s Privacy
The service targets business users and is not intended for individuals under 18. If we become aware that we processed data for a minor, we will delete it promptly.

## 12. Policy Updates
We may update this policy as the product evolves (e.g., new Meta endpoints, automation features). Updates take effect upon posting the new version. We will provide notice of material changes through release notes or direct communication when required.

## 13. Contact Us
For privacy questions or data-rights requests:
- Email: **ayden14567@gmail.com**

---

If you have any further questions about this policy or need additional language (e.g., DPA/SCC references), feel free to ask.
