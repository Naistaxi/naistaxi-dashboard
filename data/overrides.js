// Manual corrections for bookings whose Slack message says "Not calculated"
// but whose real fare is known from the internal Notion CRM.
// Keyed by Slack message ts. Applied by api/slack.js after merging live + archive data.
export default {
  // Marja Åhman — Jun 7, Ottelukuja 5 (Espoo) → Jorvin sairaala
  '1780834426.664009': { fare: '21,64' },
  // Barbro Widing — Apr 22
  '1776833403.189539': { fare: '35,00' },
  // Anna Paulig — Apr 22
  '1776848360.433669': { fare: '32,78' },
};
