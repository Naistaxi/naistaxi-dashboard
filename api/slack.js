// Import the historical archive directly so Vercel bundles it with the function.
// Reading it from disk with fs is unreliable on serverless.
import archive from '../data/bookings.js';
import overrides from '../data/overrides.js';

let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 25000;

// Live Slack data wins for any ts present in both, since its status is freshest.
function mergeArchiveAndLive(archiveData, live) {
  const liveTs = new Set(live.map(m => m.ts));
  const archiveOnly = archiveData.filter(a => !liveTs.has(a.ts));
  const merged = [...live, ...archiveOnly].sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  // Apply manual corrections (e.g. real fares for "Not calculated" bookings, sourced from Notion)
  return merged.map(m => {
    const o = overrides[m.ts];
    if (o && o.fare && m.text) {
      return { ...m, text: m.text.replace(/Estimated fare:\s*Not calculated/i, `Estimated fare: ${o.fare} €`) };
    }
    return m;
  });
}

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

    if (!histData.ok) {
      if (archive.length) {
        return res.status(200).json({
          messages: archive, archive_only: true, archive_count: archive.length, slack_error: histData.error
        });
      }
      return res.status(500).json({ error: histData.error });
    }

    const liveMessages = histData.messages || [];

    if (mode === 'messages') {
      const merged = mergeArchiveAndLive(archive, liveMessages.map(m => ({
        ...m, confirmed: false, rejected: false, cancelled: false, status_unknown: false
      })));
      return res.status(200).json({ messages: merged, archive_count: archive.length });
    }

    const now = Date.now();
    if (!forceRefresh && cache.data && (now - cache.timestamp) < CACHE_TTL_MS) {
      return res.status(200).json({ messages: cache.data, cached: true, archive_count: archive.length });
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
        const texts = replies.map(r => r.text || '');
        const cancelled = texts.some(t => /\bcancell?ed\b/i.test(t));
        const rejected = texts.some(t =>
          /\brejected\b/i.test(t) ||
          /\bno drivers?\b/i.test(t) ||
          /emme l.yt.neet sinulle kuljettajaa/i.test(t)
        );
        // Confirmation: explicit word, driver claim phrases, or "Name 💜" style replies
        let confirmed = texts.some(t =>
          /\bconfirmed\b/i.test(t) ||
          /\b(got it|took it|takes it|will take|taken by|is taking|its? done)\b/i.test(t) ||
          /white_check_mark/i.test(t) ||
          /[A-Za-zÀ-ÿÄÖÅäöå]+\s*(:purple_heart:|💜)/.test(t)
        );
        if (cancelled || rejected) confirmed = false;
        return { confirmed, rejected, cancelled };
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

    // Index archive statuses by ts — used as fallback when a live thread fetch fails
    const archiveStatusByTs = {};
    for (const a of archive) {
      archiveStatusByTs[a.ts] = { confirmed: a.confirmed, rejected: a.rejected, cancelled: a.cancelled };
    }

    const enrichedLive = liveMessages.map(m => {
      const r = confirmedMap[m.ts];
      const liveOk = r && !r.error && !r.unsupported;
      const fallback = archiveStatusByTs[m.ts];

      if (liveOk) {
        return { ...m, confirmed: r.confirmed, rejected: r.rejected, cancelled: r.cancelled, status_unknown: false };
      }
      // Live fetch failed (rate limit / free plan) — fall back to the archived status if we have one
      if (fallback) {
        return { ...m, confirmed: fallback.confirmed, rejected: fallback.rejected, cancelled: fallback.cancelled, status_unknown: false };
      }
      const statusUnknown = m.reply_count > 0;
      return { ...m, confirmed: false, rejected: false, cancelled: false, status_unknown: statusUnknown };
    });

    const merged = mergeArchiveAndLive(archive, enrichedLive);
    cache = { data: merged, timestamp: now };
    res.status(200).json({ messages: merged, archive_count: archive.length });
  } catch (err) {
    if (archive.length) {
      return res.status(200).json({
        messages: archive, archive_only: true, archive_count: archive.length, slack_error: err.message
      });
    }
    res.status(500).json({ error: err.message });
  }
}
