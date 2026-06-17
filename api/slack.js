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
        // reply_count > 0 means there are thread replies
        if (!msg.reply_count || msg.reply_count === 0) {
          return { ...msg, confirmed: false, debug_replies: 0 };
        }
        try {
          const threadRes = await fetch(
            `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${msg.ts}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const threadData = await threadRes.json();
          
          if (!threadData.ok) {
            return { ...msg, confirmed: false, debug_thread_error: threadData.error };
          }

          const replies = (threadData.messages || []).filter(r => r.ts !== msg.ts);
          const confirmed = replies.some(r => /confirmed/i.test(r.text || ''));
          
          return { 
            ...msg, 
            confirmed,
            debug_replies: replies.length,
            debug_reply_texts: replies.map(r => r.text?.substring(0, 50))
          };
        } catch(e) {
          return { ...msg, confirmed: false, debug_error: e.message };
        }
      })
    );

    res.status(200).json({ messages: messagesWithThreads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
