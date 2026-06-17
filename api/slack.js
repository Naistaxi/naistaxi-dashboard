export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SLACK_TOKEN;
  const channelId = process.env.CHANNEL_ID || 'C0APSN13G3T';

  try {
    // Fetch main messages
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const histData = await histRes.json();
    if (!histData.ok) return res.status(500).json({ error: histData.error });

    const messages = histData.messages || [];

    // For each message that has replies, fetch the thread
    const messagesWithThreads = await Promise.all(
      messages.map(async (msg) => {
        if (!msg.reply_count || msg.reply_count === 0) {
          return { ...msg, confirmed: false };
        }
        try {
          const threadRes = await fetch(
            `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${msg.ts}&limit=20`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const threadData = await threadRes.json();
          const replies = threadData.messages || [];
          // Check if any reply contains "confirmed" (case-insensitive)
          const confirmed = replies.some(r =>
            r.ts !== msg.ts && /confirmed/i.test(r.text || '')
          );
          return { ...msg, confirmed };
        } catch {
          return { ...msg, confirmed: false };
        }
      })
    );

    res.status(200).json({ messages: messagesWithThreads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
