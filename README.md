# SetDM Backend

Modular Express API scaffold featuring security middleware, centralized logging, and Instagram Graph API login helpers.

## Getting Started

```bash
npm install
cp .env.example .env
npm run dev
```

## Scripts

- `npm run dev` – start the API with `nodemon` for hot reload
- `npm start` – run the API in production mode
- `npm run lint` – lint the source files via ESLint flat config

## Environment

Populate the variables shown in `.env.example`. Instagram Graph integrations need:

- `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and `INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `INSTAGRAM_REDIRECT_URI` that is whitelisted inside Meta App Dashboard
- `INSTAGRAM_SCOPES` covering the features you need (e.g., `instagram_business_manage_messages` for DMs)
- `INSTAGRAM_LONG_LIVED_TOKEN` (used for automated replies) and `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`
- `META_GRAPH_API_BASE`/`META_GRAPH_API_VERSION` if you need to target a different Graph API version
- `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` should match the token configured in App Dashboard → Webhooks

## API Surface

- `GET /` – welcome message to verify the server is up
- `GET /api/health` – uptime, timestamp, and status for monitoring
- `GET /api/auth/instagram` – redirects to Instagram OAuth dialog
- `GET /api/auth/instagram/callback` – exchanges `code` for both short-lived and long-lived tokens and returns profile data
- `POST /api/auth/instagram/send-dm` – accepts `{ recipientId, message, accessToken }` and relays a DM via the Instagram Graph API
- `GET /api/webhooks/instagram` – verification endpoint that echoes `hub.challenge` when Meta validates the webhook
- `POST /api/webhooks/instagram` – receives Instagram messaging webhooks, validates `X-Hub-Signature-256`, auto-replies "Hello Testing" using the configured long-lived token, and logs each interaction

### Webhook security & logging

- Incoming POST requests must include a valid `X-Hub-Signature-256` header; the server recomputes the HMAC using `INSTAGRAM_APP_SECRET`.
- Each inbound message and auto-reply is appended to `logs/instagram-messages.log` so you can trace conversations without storing access tokens.

## Instagram Login Flow

1. Client requests `/api/auth/instagram?state=<nonce>`; server redirects to Instagram.
2. Instagram redirects back to `/api/auth/instagram/callback?code=...&state=...`.
3. API exchanges `code` for a short-lived token, upgrades it to a long-lived token, fetches profile info, and returns `{ profile, tokens }`.
4. Use the long-lived token to call `/api/auth/instagram/send-dm` (or store it for future scheduled jobs). The example endpoint simply proxies the DM call; in production you should persist tokens securely and inject them server-side.

## Project Structure

```
src/
  app.js
  server.js
  config/
    environment.js
  controllers/
    auth.controller.js
    health.controller.js
    webhook.controller.js
  middleware/
    error-handler.js
    not-found-handler.js
  routes/
    auth.routes.js
    health.routes.js
    webhook.routes.js
    index.js
  services/
    instagram.service.js
  utils/
    logger.js
    conversation-store.js
```
