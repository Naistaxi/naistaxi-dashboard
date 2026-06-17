const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

    // Only fetch threads for messages that have replies, sequentially with delay
    const messagesWithThreads = [];
    for (const msg of messages) {
      if (!msg.reply_count || msg.reply_count === 0) {
        messagesWithThreads.push({ ...msg, confirmed: false });
        continue;
      }

      try {
        await sleep(300); // 300ms delay between requests to avoid rate limiting
        const threadRes = await fetch(
          `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${msg.ts}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const threadData = await threadRes.json();

        if (!threadData.ok) {
          messagesWithThreads.push({ ...msg, confirmed: false });
          continue;
        }

        const replies = (threadData.messages || []).filter(r => r.ts !== msg.ts);
        const confirmed = replies.some(r => /confirmed/i.test(r.text || ''));
        messagesWithThreads.push({ ...msg, confirmed });
      } catch {
        messagesWithThreads.push({ ...msg, confirmed: false });
      }
    }

    res.status(200).json({ messages: messagesWithThreads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
