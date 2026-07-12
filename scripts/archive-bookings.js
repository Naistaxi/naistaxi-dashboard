// scripts/archive-bookings.js
// Fetches messages from Slack and merges them into data/bookings.json
// Run daily via GitHub Actions so history survives Slack's 90-day free-plan limit.

import fs from 'fs';
import path from 'path';

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || 'C0APSN13G3T';
const ARCHIVE_PATH = path.join(process.cwd(), 'data', 'bookings.json');

if (!TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN');
  process.exit(1);
}

async function slackFetch(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return res.json();
}

async function fetchThreadStatus(ts, attempt = 1) {
  try {
    const d = await slackFetch(
      `https://slack.com/api/conversations.replies?channel=${CHANNEL_ID}&ts=${ts}&limit=50`
    );
    if (!d.ok) {
      if ((d.error === 'ratelimited' || d.error === 'rate_limited') && attempt < 4) {
        await new Promise(r => setTimeout(r, 800 * attempt));
        return fetchThreadStatus(ts, attempt + 1);
      }
      return null;
    }
    const replies = (d.messages || []).filter(r => r.ts !== ts);
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
    return { confirmed, rejected, cancelled };
  } catch {
    if (attempt < 4) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return fetchThreadStatus(ts, attempt + 1);
    }
    return null;
  }
}

function isBookingMessage(text) {
  if (!text) return false;
  return /ennakkovaraus|booking|reservation|reitti|route|pre-book|prebook|ride request/i.test(text);
}

async function main() {
  // 1. Load existing archive
  let archive = [];
  if (fs.existsSync(ARCHIVE_PATH)) {
    try {
      archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf-8'));
      console.log(`Loaded ${archive.length} existing bookings from archive`);
    } catch (e) {
      console.error('Could not parse existing archive, starting fresh:', e.message);
    }
  }
  const existingTs = new Set(archive.map(b => b.ts));

  // 2. Fetch from Slack
  const hist = await slackFetch(
    `https://slack.com/api/conversations.history?channel=${CHANNEL_ID}&limit=200`
  );
  if (!hist.ok) {
    console.error('Slack error:', hist.error);
    process.exit(1);
  }

  const messages = (hist.messages || []).filter(
    m => m.text && (!m.subtype || m.subtype === 'bot_message') && isBookingMessage(m.text)
  );
  console.log(`Slack returned ${messages.length} booking messages`);

  // 3. Fetch thread statuses in small batches
  const withReplies = messages.filter(m => m.reply_count > 0);
  const statusMap = {};
  const batchSize = 5;
  for (let i = 0; i < withReplies.length; i += batchSize) {
    const batch = withReplies.slice(i, i + batchSize);
    await Promise.all(batch.map(async m => {
      const s = await fetchThreadStatus(m.ts);
      if (s) statusMap[m.ts] = s;
    }));
    if (i + batchSize < withReplies.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // 4. Merge — new messages appended; statuses only updated from SUCCESSFUL thread reads.
  // A failed/rate-limited read must never wipe a previously saved definitive status.
  let added = 0, updated = 0;
  for (const m of messages) {
    const fetched = statusMap[m.ts]; // undefined if the thread read failed or msg has no replies
    const idx = archive.findIndex(b => b.ts === m.ts);

    if (idx === -1) {
      // New booking — store it with whatever we know (all-false if no replies yet)
      const status = fetched || { confirmed: false, rejected: false, cancelled: false };
      archive.push({
        ts: m.ts,
        text: m.text,
        subtype: m.subtype || null,
        reply_count: m.reply_count || 0,
        confirmed: status.confirmed,
        rejected: status.rejected,
        cancelled: status.cancelled,
        archived_at: new Date().toISOString()
      });
      added++;
      continue;
    }

    // Existing booking — refresh text/reply_count always, status only from a successful read
    const prev = archive[idx];
    const next = { ...prev, text: m.text, reply_count: m.reply_count || 0 };

    if (fetched) {
      const hadDefinitive = prev.confirmed || prev.rejected || prev.cancelled;
      const fetchedDefinitive = fetched.confirmed || fetched.rejected || fetched.cancelled;
      // Apply the fetched status unless it would erase a definitive one with all-false
      // (all-false on a thread that previously had a status usually means a partial read)
      if (fetchedDefinitive || !hadDefinitive) {
        if (prev.confirmed !== fetched.confirmed || prev.rejected !== fetched.rejected || prev.cancelled !== fetched.cancelled) {
          next.confirmed = fetched.confirmed;
          next.rejected = fetched.rejected;
          next.cancelled = fetched.cancelled;
          updated++;
        }
      }
    }
    archive[idx] = next;
  }

  // 5. Sort newest first and save both formats
  archive.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });

  // Human-readable JSON (source of truth, easy to inspect in the repo)
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2));

  // JS module — Vercel bundles this reliably into the serverless function,
  // unlike a .json read at runtime with fs.
  const jsPath = path.join(path.dirname(ARCHIVE_PATH), 'bookings.js');
  const header =
    "// Auto-generated historical archive of bookings older than Slack's 90-day free-plan window.\n" +
    "// Regenerated daily by .github/workflows/archive-bookings.yml — do not edit by hand.\n";
  fs.writeFileSync(jsPath, header + 'export default ' + JSON.stringify(archive, null, 2) + ';\n');

  console.log(`Archive updated: ${added} added, ${updated} status updates, ${archive.length} total`);

  // 6. Validate new bookings for missing fields and notify Slack if anything looks off
  await checkMissingFields(messages);
}

function fieldValue(text, ...keys) {
  const clean = text.replace(/\*/g, '');
  for (const key of keys) {
    const m = clean.match(new RegExp(key + '\\s*:?\\s*(.+)', 'i'));
    if (m) return m[1].trim();
  }
  return null;
}

async function checkMissingFields(messages) {
  // Only check recent bookings (last 48h) so we don't re-alert on old known cases
  const cutoff = Date.now() / 1000 - 48 * 3600;
  const problems = [];

  for (const m of messages) {
    if (parseFloat(m.ts) < cutoff) continue;
    const t = m.text || '';
    const issues = [];

    const price = fieldValue(t, 'Arvioitu hinta', 'Estimated fare', 'Estimated fair', 'Estimated price', 'Hinta');
    if (!price || /not calculated/i.test(price)) issues.push('price');

    const dist = fieldValue(t, 'Etäisyys', 'Distance');
    if (!dist || /not calculated/i.test(dist)) issues.push('distance');

    const name = fieldValue(t, 'Nimi', 'Name');
    if (!name) issues.push('name');

    const phone = fieldValue(t, 'Puhelin', 'Phone');
    if (!phone) issues.push('phone');

    if (issues.length) {
      const who = name || 'Unknown';
      const date = new Date(parseFloat(m.ts) * 1000).toISOString().slice(0, 10);
      problems.push(`• *${who}* (${date}) — missing: ${issues.join(', ')}`);
    }
  }

  if (!problems.length) {
    console.log('Field check: all recent bookings complete');
    return;
  }

  console.log(`Field check: ${problems.length} booking(s) with missing fields`);
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: CHANNEL_ID,
        text: `:warning: *Dashboard data check* — some recent bookings have missing fields and won't be tracked correctly:\n${problems.join('\n')}\n_Fix the booking data or add the real value to \`data/overrides.js\` in the dashboard repo._`
      })
    });
    console.log('Notification sent to Slack');
  } catch (e) {
    console.error('Could not send Slack notification:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
