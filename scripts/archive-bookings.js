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
    return {
      confirmed: replies.some(r => /\bconfirmed\b/i.test(r.text || '')),
      rejected: replies.some(r => /\brejected\b/i.test(r.text || '')),
      cancelled: replies.some(r => /\bcancell?ed\b/i.test(r.text || ''))
    };
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

  // 4. Merge — new messages appended, existing ones get status refreshed
  let added = 0, updated = 0;
  for (const m of messages) {
    const status = statusMap[m.ts] || { confirmed: false, rejected: false, cancelled: false };
    const record = {
      ts: m.ts,
      text: m.text,
      subtype: m.subtype || null,
      reply_count: m.reply_count || 0,
      confirmed: status.confirmed,
      rejected: status.rejected,
      cancelled: status.cancelled,
      archived_at: new Date().toISOString()
    };

    if (existingTs.has(m.ts)) {
      // Refresh status of existing record (a booking may get confirmed later)
      const idx = archive.findIndex(b => b.ts === m.ts);
      const prev = archive[idx];
      if (
        prev.confirmed !== record.confirmed ||
        prev.rejected !== record.rejected ||
        prev.cancelled !== record.cancelled
      ) {
        archive[idx] = { ...prev, ...record, archived_at: prev.archived_at };
        updated++;
      }
    } else {
      archive.push(record);
      added++;
    }
  }

  // 5. Sort newest first and save
  archive.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2));

  console.log(`Archive updated: ${added} added, ${updated} status updates, ${archive.length} total`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
