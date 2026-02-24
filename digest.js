require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const Anthropic = require('@anthropic-ai/sdk');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DIGEST_CHANNEL = process.env.DIGEST_CHANNEL_ID;
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || '24');

// Channels defined by ID to bypass private channel listing limitations
const CHANNELS = [
  { id: 'C09MJ34NK17', name: 'belle-tire-analytics' },
  { id: 'C039DS07LF5', name: 'bjs_analytics' },
  { id: 'C08JDA7U5A9', name: 'data_x_platforms' },
  { id: 'C09LG7AR6R5', name: 'engine-analytics' },
  { id: 'C08GPB17Q8Z', name: 'justworks-analytics' },
  { id: 'CQV5ZDSKG',   name: 'smartsheet_analytics' },
  { id: 'C08LM5XL5QD', name: 'stripe-analytics' },
  { id: 'C09CXF3C3TK', name: 'zip_analytics' },
];
// ──────────────────────────────────────────────────────────────────────────────

async function getRecentMessages(channelId) {
  const oldest = (Date.now() / 1000) - (LOOKBACK_HOURS * 3600);
  const result = await slack.conversations.history({
    channel: channelId,
    oldest: oldest.toString(),
    limit: 200,
  });

  if (!result.messages || result.messages.length === 0) return [];

  const userIds = [...new Set(result.messages.map(m => m.user).filter(Boolean))];
  const userMap = {};
  await Promise.all(userIds.map(async (uid) => {
    try {
      const info = await slack.users.info({ user: uid });
      userMap[uid] = info.user?.real_name || info.user?.name || uid;
    } catch {
      userMap[uid] = uid;
    }
  }));

  return result.messages
    .filter(m => m.type === 'message' && m.text && !m.bot_id)
    .reverse()
    .map(m => `[${userMap[m.user] || 'Unknown'}]: ${m.text}`);
}

async function summarizeWithClaude(channelName, messages) {
  if (messages.length === 0) {
    return { channelName, summary: null, isEmpty: true };
  }

  const transcript = messages.join('\n');
  const clientName = channelName.replace(/[-_]/g, ' ').trim().toUpperCase();

  const prompt = `You are an analytics consultant's daily briefing assistant. Below is a Slack conversation from the past 24 hours in a client channel called "${channelName}".

Analyze the conversation and produce a structured briefing with these four sections:

1. **📋 General Summary** — 2-3 sentence overview of what was discussed
2. **✅ Open Tasks / Action Items** — Bullet list of things that need to be done (include owner if mentioned)
3. **🔑 Key Decisions Made** — Any decisions, conclusions, or resolved items
4. **❓ Questions Needing My Response** — Anything directed at Kevin or unanswered questions that need attention

Be concise and actionable. If a section has nothing relevant, write "None in this period."

CLIENT: ${clientName}
---
${transcript}`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  return {
    channelName,
    clientName,
    summary: response.content[0].text,
    messageCount: messages.length,
    isEmpty: false,
  };
}

async function postDigestToSlack(results) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const activeResults = results.filter(r => !r.isEmpty);
  const emptyChannels = results.filter(r => r.isEmpty).map(r => `#${r.channelName}`);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 Daily Analytics Briefing — ${today}` },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${activeResults.length} active client channel${activeResults.length !== 1 ? 's' : ''} • Last 24 hours`,
      }],
    },
    { type: 'divider' },
  ];

  for (const result of activeResults) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*#${result.channelName}* _(${result.messageCount} messages)_\n\n${result.summary}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  if (emptyChannels.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `💤 No activity in: ${emptyChannels.join(', ')}`,
      }],
    });
  }

  await slack.chat.postMessage({
    channel: DIGEST_CHANNEL,
    text: `Daily Analytics Briefing — ${today}`,
    blocks,
  });

  console.log(`✅ Digest posted to Slack for ${activeResults.length} channels`);
}

async function runDigest() {
  console.log(`🚀 Starting daily digest at ${new Date().toISOString()}`);

  try {
    const results = [];
    const chunkSize = 5;
    for (let i = 0; i < CHANNELS.length; i += chunkSize) {
      const chunk = CHANNELS.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(async (ch) => {
          console.log(`  → Processing #${ch.name}`);
          try {
            const messages = await getRecentMessages(ch.id);
            console.log(`     ${messages.length} messages found`);
            return summarizeWithClaude(ch.name, messages);
          } catch (err) {
            console.error(`     ❌ Error on #${ch.name}:`, err.message);
            return { channelName: ch.name, summary: null, isEmpty: true };
          }
        })
      );
      results.push(...chunkResults);
    }

    await postDigestToSlack(results);
  } catch (err) {
    console.error('❌ Digest failed:', err.message);
    process.exit(1);
  }
}

runDigest().then(() => {
  console.log('Done.');
}).catch(err => {
  console.error('FATAL ERROR:', err);
});