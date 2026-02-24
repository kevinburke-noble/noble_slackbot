require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const Anthropic = require('@anthropic-ai/sdk');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DIGEST_CHANNEL = process.env.DIGEST_CHANNEL_ID;
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || '24');

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

Analyze the conversation and return a JSON object with exactly these four fields:
- "summary": 2-3 sentence overview of what was discussed
- "tasks": array of strings, each an open task or action item (include owner in parens if mentioned, e.g. "Fix data mapping (Kevin)")
- "decisions": array of strings, each a key decision or resolved item
- "questions": array of strings, each a question directed at Kevin or left unanswered

If a section has nothing relevant, return an empty array [] for that field.
Return ONLY valid JSON, no markdown, no explanation.

CLIENT: ${clientName}
---
${transcript}`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  let parsed;
  try {
    const raw = response.content[0].text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(raw);
  } catch {
    // fallback if JSON parsing fails
    parsed = {
      summary: response.content[0].text.replace(/```json|```/g, "").trim(),
      tasks: [],
      decisions: [],
      questions: [],
    };
  }

  return {
    channelName,
    clientName,
    data: parsed,
    messageCount: messages.length,
    isEmpty: false,
  };
}

function buildChannelBlocks(result) {
  const { channelName, clientName, data, messageCount } = result;
  const blocks = [];

  // Channel header
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*📊 ${clientName}* · <#${CHANNELS.find(c => c.name === channelName)?.id}> · _${messageCount} message${messageCount !== 1 ? 's' : ''}_`,
    },
  });

  // Summary
  if (data.summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: data.summary },
    });
  }

  // Tasks
  if (data.tasks?.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*✅ Action Items*\n${data.tasks.map(t => `• ${t}`).join('\n')}`,
      },
    });
  }

  // Decisions
  if (data.decisions?.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔑 Decisions Made*\n${data.decisions.map(d => `• ${d}`).join('\n')}`,
      },
    });
  }

  // Questions needing response
  if (data.questions?.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*❓ Needs Your Response*\n${data.questions.map(q => `• ${q}`).join('\n')}`,
      },
    });
  }

  blocks.push({ type: 'divider' });
  return blocks;
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
      text: { type: 'plain_text', text: `📋 Daily Analytics Briefing — ${today}`, emoji: true },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${activeResults.length} active client${activeResults.length !== 1 ? 's' : ''} • Last ${LOOKBACK_HOURS} hours`,
      }],
    },
    { type: 'divider' },
  ];

  for (const result of activeResults) {
    blocks.push(...buildChannelBlocks(result));
  }

  if (emptyChannels.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `💤 No activity: ${emptyChannels.join(', ')}`,
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
