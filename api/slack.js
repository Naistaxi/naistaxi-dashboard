import fs from 'fs';
import path from 'path';

let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 25000;

function loadArchive() {
  try {
    const p = path.join(process.cwd(), 'data', 'bookings.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (e) {
    console.error('Could not load archive:', e.message);
  }
  return [];
}

// Live Slack data wins for any ts present in both, since its status is freshest.
function mergeArchiveAndLive(archive, live) {
  const liveTs = new Set(live.map(m => m.ts));
  const archiveOnly = archive.filter(a => !liveTs.has(a.ts));
  return [...live, ...archiveOnly].sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SLACK_TOKEN;
  const channelId = process.env.CHANNEL_ID || 'C0APSN13G3T';
  const mode = req.query.mode || 'full';
  const forceRefresh = req.query.force === '1';

  const archive = loadArchive();

  try {
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const histData = await histRes.json();

    if (!histData.ok) {
      if (archive.length) {
        return res.status(200).json({ messages: archive, archive_only: true, slack_error: histData.error });
      }
      return res.status(500).json({ error: histData.error });
    }

    const liveMessages = histData.messages || [];

    if (mode === 'messages') {
      const merged = mergeArchiveAndLive(archive, liveMessages.map(m => ({
        ...m, confirmed: false, rejected: false, cancelled: false, status_unknown: false
      })));
      return res.status(200).json({ messages: merged });
    }

    const now = Date.now();
    if (!forceRefresh && cache.data && (now - cache.timestamp) < CACHE_TTL_MS) {
      return res.status(200).json({ messages: cache.data, cached: true });
    }

    const withReplies = liveMessages.filter(m => m.reply_count > 0);
    const confirmedMap = {};

    async function fetchThread(msg, attempt = 1) {
      try {
        const r = await fetch(
          `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${msg.ts}&limit=50`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const d = await r.json();
        if (!d.ok) {
          if (d.error === 'method_not_supported_for_channel_type' || d.error === 'not_allowed_token_type') {
            return { unsupported: true };
          }
          if ((d.error === 'ratelimited' || d.error === 'rate_limited') && attempt < 3) {
            await new Promise(res => setTimeout(res, 500 * attempt));
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
        if (attempt < 3) {
          await new Promise(res => setTimeout(res, 500 * attempt));
          return fetchThread(msg, attempt + 1);
        }
        return { error: true };
      }
    }

    const batchSize = 8;
    for (let i = 0; i < withReplies.length; i += batchSize) {
      const batch = withReplies.slice(i, i + batchSize);
      await Promise.all(batch.map(async (msg) => {
        confirmedMap[msg.ts] = await fetchThread(msg);
      }));
      if (i + batchSize < withReplies.length) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    const enrichedLive = liveMessages.map(m => {
      const r = confirmedMap[m.ts];
      const statusUnknown = m.reply_count > 0 && (!r || r.error || r.unsupported);
      return {
        ...m,
        confirmed: r && !r.error && !r.unsupported ? r.confirmed : false,
        rejected: r && !r.error && !r.unsupported ? r.rejected : false,
        cancelled: r && !r.error && !r.unsupported ? r.cancelled : false,
        status_unknown: statusUnknown
      };
    });

    const merged = mergeArchiveAndLive(archive, enrichedLive);
    cache = { data: merged, timestamp: now };
    res.status(200).json({ messages: merged, archive_count: archive.length });
  } catch (err) {
    if (archive.length) {
      return res.status(200).json({ messages: archive, archive_only: true, slack_error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
}
