// Shared baseline for the Financials tab — what a browser with no saved
// localStorage sees on first load. This is NOT auto-updated: when you're
// happy with your assumptions in the Financials tab, click "Copy config" and
// paste the result here, then commit. Everyone who opens the dashboard for
// the first time (or clears their browser data) will then start from your
// latest numbers. Rides/revenue actuals always come live from Slack — only
// cost/target assumptions live here, since those aren't in Slack.
window.FIN_SEED_CONFIG = {
  params: {
    pessimistic: {},
    realistic: {},
    optimistic: {},
  },
  annualTargets: [
    { targetRevenue: 0, targetRides: 0, targetProfit: 0 },
    { targetRevenue: 0, targetRides: 0, targetProfit: 0 },
  ],
};
