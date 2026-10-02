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
  // Johanna Karppinen — Oct 1, Eteläinen Rautatiekatu 4 → Nordenskiöldinkatu 11-13
  '1790818433.417879': { fare: '18,04', name: 'Johanna Karppinen', from: 'Eteläinen Rautatiekatu 4, 00100 Helsinki', to: 'Nordenskiöldinkatu 11-13, 00250 Helsinki', dist: 2.52 },
  // Johanna Karppinen — Oct 1, Nordenskiöldinkatu 11-13 → Eteläinen Rautatiekatu 4
  '1790818439.583189': { fare: '18,76', name: 'Johanna Karppinen', from: 'Nordenskiöldinkatu 11-13, 00250 Helsinki', to: 'Eteläinen Rautatiekatu 4, 00100 Helsinki', dist: 2.92 },
  // Eva Ahlstrom — Oct 1, driver Meriem ("Confirmed- Meriem" without space was missed)
  '1790849633.815899': { driver: 'Meriem' },
};
