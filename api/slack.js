export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SLACK_TOKEN;
  const channelId = process.env.CHANNEL_ID || 'C0APSN13G3T';

  try {
    const response = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    if (!data.ok) return res.status(500).json({ error: data.error });
    res.status(200).json({ messages: data.messages || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
