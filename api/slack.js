export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SLACK_TOKEN;
  const channelId = process.env.CHANNEL_ID || 'C0APSN13G3T';
  const mode = req.query.mode || 'full'; // 'messages' or 'threads' or 'full'

  try {
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const histData = await histRes.json();
    if (!histData.ok) return res.status(500).json({ error: histData.error });

    const messages = histData.messages || [];

    if (mode === 'messages') {
      // Fast path: return messages without thread status
      return res.status(200).json({ messages: messages.map(m => ({ ...m, confirmed: false, rejected: false, cancelled: false })) });
    }

    // Fetch threads in batches of 5 with small delays, with retry on failure
    const withReplies = messages.filter(m => m.reply_count > 0);
    const confirmedMap = {};

    async function fetchThread(msg, attempt = 1) {
      try {
        const r = await fetch(
          `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${msg.ts}&limit=50`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const d = await r.json();
        if (!d.ok) {
          if (d.error === 'ratelimited' && attempt < 3) {
            await new Promise(res => setTimeout(res, 500 * attempt));
            return fetchThread(msg, attempt + 1);
          }
          return null;
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
        return null;
      }
    }

    const batchSize = 5;
    for (let i = 0; i < withReplies.length; i += batchSize) {
      const batch = withReplies.slice(i, i + batchSize);
      await Promise.all(batch.map(async (msg) => {
        const result = await fetchThread(msg);
        if (result) confirmedMap[msg.ts] = result;
      }));
      if (i + batchSize < withReplies.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    res.status(200).json({
      messages: messages.map(m => ({
        ...m,
        confirmed: confirmedMap[m.ts]?.confirmed ?? false,
        rejected: confirmedMap[m.ts]?.rejected ?? false,
        cancelled: confirmedMap[m.ts]?.cancelled ?? false,
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
