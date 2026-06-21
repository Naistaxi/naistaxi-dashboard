// In-memory cache to avoid re-fetching all threads on every poll (resets on cold start)
let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 25000; // slightly less than the 30s frontend poll interval

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SLACK_TOKEN;
  const channelId = process.env.CHANNEL_ID || 'C0APSN13G3T';
  const mode = req.query.mode || 'full';
  const forceRefresh = req.query.force === '1';

  try {
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const histData = await histRes.json();
    if (!histData.ok) return res.status(500).json({ error: histData.error });

    const messages = histData.messages || [];

    if (mode === 'messages') {
      return res.status(200).json({ messages: messages.map(m => ({ ...m, confirmed: false, rejected: false, cancelled: false, status_unknown: false })) });
    }

    // Serve from cache if fresh enough (avoids hammering Slack every 30s and reduces rate-limit risk)
    const now = Date.now();
    if (!forceRefresh && cache.data && (now - cache.timestamp) < CACHE_TTL_MS) {
      return res.status(200).json({ messages: cache.data, cached: true });
    }

    const withReplies = messages.filter(m => m.reply_count > 0);
    const confirmedMap = {};

    // Sequential fetch with retries — slower but reliable, avoids parallel rate-limit storms
    async function fetchThread(msg, attempt = 1) {
      try {
        const r = await fetch(
          `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${msg.ts}&limit=50`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const d = await r.json();
        if (!d.ok) {
          if ((d.error === 'ratelimited' || d.error === 'rate_limited') && attempt < 5) {
            await new Promise(res => setTimeout(res, 600 * attempt));
            return fetchThread(msg, attempt + 1);
          }
          return { error: true };
        }
        const replies = (d.messages || []).filter(r => r.ts !== msg.ts);
        return {
          confirmed: replies.some(r => /\bconfirmed\b/i.test(r.text || '')),
          rejected: replies.some(r => /\brejected\b/i.test(r.text || '')),
          cancelled: replies.some(r => /\bcancell?ed\b/i.test(r.text || ''))
        };
      } catch {
        if (attempt < 5) {
          await new Promise(res => setTimeout(res, 600 * attempt));
          return fetchThread(msg, attempt + 1);
        }
        return { error: true };
      }
    }

    // Small batches (3) with delay to stay well under Slack's rate limit
    const batchSize = 3;
    for (let i = 0; i < withReplies.length; i += batchSize) {
      const batch = withReplies.slice(i, i + batchSize);
      await Promise.all(batch.map(async (msg) => {
        const result = await fetchThread(msg);
        confirmedMap[msg.ts] = result;
      }));
      if (i + batchSize < withReplies.length) {
        await new Promise(r => setTimeout(r, 350));
      }
    }

    const enriched = messages.map(m => {
      const r = confirmedMap[m.ts];
      // status_unknown = we couldn't determine the thread status (Slack error/timeout) — NOT a real "pending"
      const statusUnknown = m.reply_count > 0 && (!r || r.error);
      return {
        ...m,
        confirmed: r && !r.error ? r.confirmed : false,
        rejected: r && !r.error ? r.rejected : false,
        cancelled: r && !r.error ? r.cancelled : false,
        status_unknown: statusUnknown
      };
    });

    // Update cache
    cache = { data: enriched, timestamp: now };

    res.status(200).json({ messages: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
