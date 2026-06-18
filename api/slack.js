export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SLACK_TOKEN;
  const channelId = process.env.CHANNEL_ID || 'C0APSN13G3T';

  try {
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const histData = await histRes.json();
    if (!histData.ok) return res.status(500).json({ error: histData.error });

    const messages = histData.messages || [];

    // Only fetch threads for messages with replies (booking messages)
    const withReplies = messages.filter(m => m.reply_count > 0);

    // Fetch all threads in parallel - fast
    const threadResults = await Promise.allSettled(
      withReplies.map(async (msg) => {
        const r = await fetch(
          `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${msg.ts}&limit=50`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const d = await r.json();
        if (!d.ok) return { ts: msg.ts, confirmed: false };
        const replies = (d.messages || []).filter(r => r.ts !== msg.ts);
        const confirmed = replies.some(r => /confirmed/i.test(r.text || ''));
        const rejected = replies.some(r => /rejected|reject/i.test(r.text || ''));
        const cancelled = replies.some(r => /cancelled|canceled|cancel/i.test(r.text || ''));
        return { ts: msg.ts, confirmed, rejected, cancelled };
      })
    );

    const confirmedMap = {};
    threadResults.forEach(r => {
      if (r.status === 'fulfilled') {
        confirmedMap[r.value.ts] = { confirmed: r.value.confirmed, rejected: r.value.rejected, cancelled: r.value.cancelled };
      }
    });

    res.status(200).json({
      messages: messages.map(m => ({
        ...m,
        confirmed: confirmedMap[m.ts]?.confirmed ?? false,
        rejected: confirmedMap[m.ts]?.rejected ?? false,
        cancelled: confirmedMap[m.ts]?.cancelled ?? false
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
