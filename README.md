# SetDM Backend

Modular Express API scaffold featuring security middleware, centralized logging, Instagram Graph API login helpers, and MongoDB persistence via the official Node.js driver. Instagram OAuth responses (profile + tokens) are stored for each user so they can be reused server-side.

## Getting Started

```bash
npm install
cp .env.example .env
  serverless-app.js
npm run dev
```

## Scripts

- `npm run dev` – start the API with `nodemon` for hot reload
- `npm start` – run the API in production mode
- `npm run lint` – lint the source files via ESLint flat config

## Environment

Populate the variables shown in `.env.example`. Instagram Graph integrations need:

- `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and (optionally) `INSTAGRAM_REDIRECT_URI` (if omitted, the server builds the callback from the incoming request host)
- `INSTAGRAM_SCOPES` covering the exact data you request (comma-separated)
- `INSTAGRAM_GRAPH_API_BASE`, `INSTAGRAM_OAUTH_URL`, `INSTAGRAM_TOKEN_URL` if you want to override default endpoints
- `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` that matches the Meta App Dashboard → Webhooks configuration

MongoDB configuration lives in the same `.env` file:


`api/index.js` re-exports the serverless handler so Vercel can deploy the entire Express app as a single serverless function.

## Deploying to Vercel

1. Ensure `api/index.js` and `src/serverless-app.js` stay committed—they expose the Express app in a serverless-friendly way.
2. Create `vercel.json` (already included) so every request is routed through the Node function.
3. Set all environment variables (`MONGO_URI`, `MONGO_DB_NAME`, Instagram secrets, webhook token, etc.) in the Vercel dashboard or via `vercel env`.
4. Deploy with `vercel` (preview) and `vercel --prod`. Once deployed, update Meta’s redirect URI/webhook URLs to the new Vercel domain.
- `MONGO_URI` – full connection string (e.g., `mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority`)
- `MONGO_DB_NAME` – logical database to use (defaults to `setdm` if omitted)

## API Surface

- `GET /` – welcome message to verify the server is up
- `GET /privacy` – renders the privacy policy Markdown as an HTML page
- `GET /api/health` – uptime, timestamp, and status for monitoring
- `GET /api/auth/instagram` – redirects to Instagram OAuth dialog
- `GET /api/auth/instagram/callback` – exchanges `code` for both short-lived and long-lived tokens, persists the Instagram profile **and token metadata** in MongoDB, and returns `{ profile, user, tokens }`
- `GET /api/webhooks/instagram` – verification endpoint that echoes `hub.challenge` when Meta validates the webhook
- `POST /api/webhooks/instagram` – receives Instagram webhook payloads, stores them in memory (as per the Facebook sample), logs the raw body, and automatically replies “Hello testing” to inbound IG DMs using the stored long-lived token
- `GET /api/webhooks/instagram/updates` – dumps the in-memory webhook payload list for quick inspection

## Instagram Login Flow

1. Client requests `/api/auth/instagram?state=<nonce>`; server redirects to Instagram.
2. Instagram redirects back to `/api/auth/instagram/callback?code=...&state=...`.
3. API exchanges `code` for a short-lived token, upgrades it to a long-lived token, fetches profile info, persists the profile + token metadata in MongoDB, and returns `{ profile, user, tokens }`.
4. Secure the database because access tokens now live server-side. Rotate them as needed in a job or upon new logins. The backend still does not proxy DM calls.

## Project Structure

```
src/
  app.js
  server.js
  config/
    environment.js
  database/
    mongo.js
  controllers/
     - `POST /api/webhooks/instagram` – receives Instagram webhook payloads, stores them in memory (as per the Facebook sample), logs the raw body, and automatically replies “Hello testing” to inbound IG DMs using the stored long-lived token
```
  routes/

## ChatGPT + Calendly link

- The ChatGPT system prompt can include `{{CALENDLY_LINK}}`. The backend will only replace that placeholder when the assistant response contains it, so the link is sent strictly when the prompt logic decides it should be.
- Store the link per Instagram business account inside MongoDB under `instagram_users.settings.calendlyLink`. Example Mongo shell update:

  ```javascript
  db.instagram_users.updateOne(
    { instagramId: '<business_ig_id>' },
    { $set: { 'settings.calendlyLink': 'https://calendly.com/coach/intro-call' } }
  );
  ```

- The webhook controller automatically injects the stored link before messages are persisted/sent. If no link is configured, the placeholder is stripped and a warning is logged so the DM never leaks template syntax.

## ChatGPT Prompt Storage

- The system prompt now lives in MongoDB (collection: `prompts`). Only one document is needed, with `{ name: 'system', content: '<your prompt text>' }`.
- Seed/update it manually or via script:

  ```javascript
  db.prompts.updateOne(
    { name: 'system' },
    {
      $set: {
        content: '<paste your long prompt here>',
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );
  ```

- On startup, the API caches the prompt in memory after the first lookup. Update the Mongo document (and restart the server, or add an admin endpoint) whenever you want to change the AI behavior.
