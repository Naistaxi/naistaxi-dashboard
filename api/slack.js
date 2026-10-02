// Import the historical archive directly so Vercel bundles it with the function.
// Reading it from disk with fs is unreliable on serverless.
import archive from '../data/bookings.js';
import overrides from '../data/overrides.js';

const NON_NAME_WORDS = /^(by|the|for|it|ride|booking|confirmed|rejected|cancelled|canceled|driver|available|yes|no|ok|okay|okey|done|thanks|thank|sure|kiitos|joo|jep|kylla|kyll[aä]|selv[aä]|hyv[aä])$/i;

function extractDriver(texts) {
  const clean = s => (s || '').replace(/[<>|]/g, ' ').trim();
  for (const raw of texts) {
    const t = clean(raw);
    let m = t.match(/\bconfirmed\b\s*[-–:,]?\s*([A-Za-zÀ-ÿÄÖÅäöå]{2,})/i);
    if (!m) m = t.match(/\bconfirmed-([A-Za-zÀ-ÿÄÖÅäöå]{2,})/i);
    if (m && !NON_NAME_WORDS.test(m[1])) return titleCase(m[1]);
    m = t.match(/\btaken by\s+([A-Za-zÀ-ÿÄÖÅäöå]{2,})/i);
    if (m) return titleCase(m[1]);
    m = t.match(/\b([A-Za-zÀ-ÿÄÖÅäöå]{2,})\s+(?:got it|took it|takes it|will take|is taking)/i);
    if (m && !/^(she|he|they|it|we|i)$/i.test(m[1])) return titleCase(m[1]);
    m = t.match(/\bdriver\s*:\s*([A-Za-zÀ-ÿÄÖÅäöå]{2,})/i);
    if (m && !NON_NAME_WORDS.test(m[1])) return titleCase(m[1]);
    m = t.match(/\b([A-Za-zÀ-ÿÄÖÅäöå]{2,})\s*(?::purple_heart:|💜)/);
    if (m) return titleCase(m[1]);
  }
  for (const raw of texts) {
    const t = clean(raw).replace(/(:purple_heart:|💜)\s*$/, '').trim();
    if (/^[A-Za-zÀ-ÿÄÖÅäöå]{2,}$/.test(t) && !NON_NAME_WORDS.test(t)) {
      return titleCase(t);
    }
  }
  return null;
}

function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const DRIVER_ALIASES = {
  'dance': 'Danche',
};
function normalizeDriverName(name) {
  if (!name) return name;
  const canonical = DRIVER_ALIASES[name.toLowerCase()];
  return canonical || name;
}

let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 300000;
const FRESH_WINDOW_MS = 7 * 24 * 3600 * 1000;

function mergeArchiveAndLive(archiveData, live) {
  const liveTs = new Set(live.map(m => m.ts));
  const archiveOnly = archiveData.filter(a => !liveTs.has(a.ts));
  const merged = [...live, ...archiveOnly].sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  return merged.map(m => {
    const driver = m.driver ? normalizeDriverName(m.driver) : m.driver;
    const o = overrides[m.ts];
    if (o && m.text) {
      let text = m.text;
      if (o.fare) {
        if (/Estimated fare:\s*Not calculated/i.test(text)) {
          text = text.replace(/Estimated fare:\s*Not calculated/i, `Estimated fare: ${o.fare} €`);
        } else if (!/(Estimated fare|Arvioitu hinta)/i.test(text)) {
          text = text + `\nEstimated fare: ${o.fare} €`;
        }
      }
      if (o.name && !/(Nimi|Name)\s*:/i.test(text)) {
        text = text + `\nNimi: ${o.name}`;
      }
      if (o.from && !/(Lähtö|From|Pickup address)\s*:/i.test(text)) {
        text = text + `\nFrom: ${o.from}`;
      }
      if (o.to && !/(Määränpää|Destination|To)\s*:/i.test(text)) {
        text = text + `\nDestination: ${o.to}`;
      }
      if (o.dist && !/(Etäisyys|Distance)\s*:/i.test(text)) {
        text = text + `\nDistance: ${o.dist} km`;
      }
      // Override driver if explicitly set
      const finalDriver = o.driver ? normalizeDriverName(o.driver) : driver;
      return { ...m, text, driver: finalDriver };
    }
    return { ...m, driver };
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

    const archiveByTs = {};
    for (const a of archive) archiveByTs[a.ts] = a;

    const freshCutoff = (Date.now() - FRESH_WINDOW_MS) / 1000;
    const withReplies = liveMessages.filter(m => {
      if (!m.reply_count) return false;
      const known = archiveByTs[m.ts];
      const settled = known && (known.confirmed || known.rejected || known.cancelled);
      const isRecent = parseFloat(m.ts) >= freshCutoff;
      return isRecent || !settled;
    });
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
        let confirmed = texts.some(t =>
          /\bconfirmed\b/i.test(t) ||
          /\b(got it|took it|takes it|will take|taken by|is taking|its? done)\b/i.test(t) ||
          /white_check_mark/i.test(t) ||
          /[A-Za-zÀ-ÿÄÖÅäöå]+\s*(:purple_heart:|💜)/.test(t)
        );
        if (cancelled || rejected) confirmed = false;
        const driver = confirmed ? extractDriver(texts) : null;
        return { confirmed, rejected, cancelled, driver };
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

    const archiveStatusByTs = {};
    for (const a of archive) {
      archiveStatusByTs[a.ts] = { confirmed: a.confirmed, rejected: a.rejected, cancelled: a.cancelled, driver: a.driver || null };
    }

    const enrichedLive = liveMessages.map(m => {
      const r = confirmedMap[m.ts];
      const liveOk = r && !r.error && !r.unsupported;
      const fallback = archiveStatusByTs[m.ts];

      if (liveOk) {
        // If live fetch got no driver, fall back to archive driver or override before giving up
        const overrideDriver = overrides[m.ts] && overrides[m.ts].driver ? overrides[m.ts].driver : null;
        const liveDriver = r.driver || overrideDriver || (archiveStatusByTs[m.ts] && archiveStatusByTs[m.ts].driver) || null;
        return { ...m, confirmed: r.confirmed, rejected: r.rejected, cancelled: r.cancelled, driver: liveDriver, status_unknown: false };
      }
      if (fallback) {
        return { ...m, confirmed: fallback.confirmed, rejected: fallback.rejected, cancelled: fallback.cancelled, driver: fallback.driver || null, status_unknown: false };
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
