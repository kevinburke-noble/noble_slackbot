# Slack Analytics Daily Digest

A bot that runs every morning and posts a structured briefing of all your client analytics Slack channels — summarized by Claude AI.

## What It Does

Each morning (8am ET, weekdays), it scans all channels matching your prefix (e.g. `clients_analytics`), pulls the last 24 hours of messages, and posts a digest to your private Slack channel or DM with:

- 📋 General summary per client
- ✅ Open tasks / action items
- 🔑 Key decisions made
- ❓ Questions needing your response

---

## Setup: Step by Step

### 1. Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it something like `Analytics Briefing Bot`
3. Under **OAuth & Permissions**, add these **Bot Token Scopes**:
   - `channels:read`
   - `groups:read` ← for private channels
   - `channels:history`
   - `groups:history`
   - `users:read`
   - `chat:write`
4. Click **Install to Workspace** → copy the **Bot User OAuth Token** (starts with `xoxb-`)
5. **Invite the bot to each client channel**: In Slack, go to each `#clients_analytics_*` channel → `/invite @YourBotName`

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Fill in:
- `SLACK_BOT_TOKEN` — your `xoxb-...` token from step 1
- `ANTHROPIC_API_KEY` — your Claude API key from [console.anthropic.com](https://console.anthropic.com)
- `DIGEST_CHANNEL_ID` — where to post the digest (see below)
- `CHANNEL_PREFIX` — the common string in your client channel names

**Finding your Digest Channel ID:**
- Open Slack in your browser
- Navigate to your DM with yourself (or create a `#my-briefings` private channel)
- The ID is in the URL: `slack.com/app_redirect?channel=D0123456789` → use `D0123456789`

### 3. Run Locally to Test

```bash
npm install
node digest.js    # runs once immediately — great for testing
```

If it works, you'll see a message appear in your Slack.

### 4. Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select your repo
4. Go to **Variables** tab → add all your `.env` values
5. Deploy — Railway will run `node scheduler.js` which fires the digest every weekday at 8am ET

That's it. Free tier should cover this easily (it's a lightweight process that wakes up once a day).

---

## Customization

| Variable | Default | Description |
|---|---|---|
| `CHANNEL_PREFIX` | `clients_analytics` | Filter channels by name |
| `LOOKBACK_HOURS` | `24` | How far back to look |
| `CRON_SCHEDULE` | `0 13 * * 1-5` | When to run (UTC, weekdays) |

To run on-demand anytime: `npm run digest:now`

---

## Extending This

Some ideas once it's running:

- **BigQuery integration** — append a bullet to each client section with their latest metric from BQ
- **Priority scoring** — have Claude flag which client needs attention most urgently
- **Weekly rollup** — a Friday version that looks back 7 days instead of 24 hours
- **Slack threads** — post each client as a thread reply for cleaner organization
