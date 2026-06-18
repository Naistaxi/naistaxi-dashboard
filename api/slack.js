export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SLACK_TOKEN;
  const channelId = process.env.CHANNEL_ID || 'C0APSN13G3T';

  try {
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const histData = await histRes.json();
    if (!histData.ok) return res.status(500).json({ error: histData.error });

    const messages = histData.messages || [];

    // Fetch ALL threads in parallel at once — fastest possible
    const results = await Promise.allSettled(
      messages.map(async (msg) => {
        if (!msg.reply_count || msg.reply_count === 0) {
          return { ts: msg.ts, confirmed: false };
        }
        const r = await fetch(
          `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${msg.ts}&limit=50`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const d = await r.json();
        if (!d.ok) return { ts: msg.ts, confirmed: false };
        const replies = (d.messages || []).filter(r => r.ts !== msg.ts);
        const confirmed = replies.some(r => /confirmed/i.test(r.text || ''));
        return { ts: msg.ts, confirmed };
      })
    );

    const confirmedMap = {};
    results.forEach(r => {
      if (r.status === 'fulfilled') confirmedMap[r.value.ts] = r.value.confirmed;
    });

    res.status(200).json({
      messages: messages.map(m => ({ ...m, confirmed: confirmedMap[m.ts] || false }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
