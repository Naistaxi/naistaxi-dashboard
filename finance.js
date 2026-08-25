// ============================================================================
// Naistaxi Financials — 36-month scenario model, driven by real confirmed
// rides from the #ride-requests Slack feed (via allRides in index.html).
//
// No build step, no framework: plain functions + Chart.js, matching the rest
// of this app. Everything here is pure/DOM-free except the render* functions
// at the bottom, so the math can be reasoned about (and unit-tested) on its
// own.
// ============================================================================

const FIN_TOTAL_MONTHS = 36;
const FIN_COMMISSION_START = new Date('2026-07-15T00:00:00');
const FIN_SCENARIOS = ['pessimistic', 'realistic', 'optimistic'];

const FIN_DEFAULT_PARAMS = {
  startMonth: null, // filled in from real data at runtime (earliest confirmed ride's month)
  standardRidePrice: 0,       // € per ride — used only for forecast months (actual months use real price)
  standardCommissionRate: 0.15, // matches the real 15% commission used on the Overview tab
  monthlyRideGrowth: 0,       // manual fallback growth (absolute rides/month) when trend can't be computed
  fullTimeTeamSize: 0,
  internsTeamSize: 0,
  avgSalaryPerPerson: 0,
  avgSalaryPerIntern: 0,
  marketingBudgetYear1: 0,
  operatingCostsMonthly: 0,
  paymentProcessingFee: 0,
  avgRidesPerCustomerLifetime: 0,
  newCustomersYear1: 0,
  socialSecurityTax: 0,
};

const FIN_DEFAULT_ANNUAL_TARGET = { targetRevenue: 0, targetRides: 0, targetProfit: 0 };

// ---------------------------------------------------------------------------
// Persistence — localStorage is the live/editable copy. A committed
// data/financials-config.js (optional) supplies the shared starting point
// for a fresh browser; see FIN_SEED_CONFIG below.
// ---------------------------------------------------------------------------

function finLoadParams(scenario) {
  try {
    const saved = localStorage.getItem(`nais-fin-params-${scenario}`);
    if (saved) return { ...FIN_DEFAULT_PARAMS, ...JSON.parse(saved) };
  } catch (e) { console.error('finLoadParams', e); }
  const seed = (window.FIN_SEED_CONFIG && window.FIN_SEED_CONFIG.params && window.FIN_SEED_CONFIG.params[scenario]) || {};
  return { ...FIN_DEFAULT_PARAMS, ...seed };
}

function finSaveParams(scenario, params) {
  try { localStorage.setItem(`nais-fin-params-${scenario}`, JSON.stringify(params)); }
  catch (e) { console.error('finSaveParams', e); }
}

function finLoadAnnualTargets() {
  try {
    const saved = localStorage.getItem('nais-fin-annual-targets');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length === 3) return parsed;
    }
  } catch (e) { console.error('finLoadAnnualTargets', e); }
  const seed = (window.FIN_SEED_CONFIG && window.FIN_SEED_CONFIG.annualTargets) || null;
  if (Array.isArray(seed) && seed.length === 3) return seed;
  return [{ ...FIN_DEFAULT_ANNUAL_TARGET }, { ...FIN_DEFAULT_ANNUAL_TARGET }, { ...FIN_DEFAULT_ANNUAL_TARGET }];
}

function finSaveAnnualTargets(targets) {
  try { localStorage.setItem('nais-fin-annual-targets', JSON.stringify(targets)); }
  catch (e) { console.error('finSaveAnnualTargets', e); }
}

// Per-month target overrides: { [monthIndex]: { targetRides, targetRevenue } }
function finLoadMonthTargetOverrides() {
  try {
    const saved = localStorage.getItem('nais-fin-month-target-overrides');
    if (saved) return JSON.parse(saved);
  } catch (e) { console.error('finLoadMonthTargetOverrides', e); }
  return {};
}

function finSaveMonthTargetOverrides(overrides) {
  try { localStorage.setItem('nais-fin-month-target-overrides', JSON.stringify(overrides)); }
  catch (e) { console.error('finSaveMonthTargetOverrides', e); }
}

// ---------------------------------------------------------------------------
// Real actuals — aggregate the same `allRides` the Overview tab already
// parses from Slack into one bucket per calendar month.
// ---------------------------------------------------------------------------

function finMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// rides: the `allRides` array from index.html (already parsed by parseRides()).
// Returns { monthKey -> { rides, revenue } }, confirmed (non-rejected, non-cancelled) only.
// Revenue uses the same 15%-commission-from-Jul-15 rule as the Overview tab, so
// the two tabs never disagree with each other.
function finAggregateActualsByMonth(rides) {
  const byMonth = {};
  rides.forEach(r => {
    if (!r.confirmed || r.rejected || r.cancelled) return;
    const key = finMonthKey(r.date);
    if (!byMonth[key]) byMonth[key] = { rides: 0, revenue: 0, gbv: 0 };
    byMonth[key].rides += 1;
    byMonth[key].gbv += r.price;
    if (r.date >= FIN_COMMISSION_START) byMonth[key].revenue += r.price * 0.15;
  });
  return byMonth;
}

function finEarliestRideDate(rides) {
  const confirmed = rides.filter(r => r.confirmed && !r.rejected && !r.cancelled);
  if (!confirmed.length) return null;
  return confirmed.reduce((min, r) => (r.date < min ? r.date : min), confirmed[0].date);
}

// ---------------------------------------------------------------------------
// The model — mirrors the logic from the standalone investor dashboard, but
// actual months come from real Slack data instead of manual entry.
// ---------------------------------------------------------------------------

function finBuildMonthTimeline(startDate) {
  const months = [];
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  for (let i = 0; i < FIN_TOTAL_MONTHS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    months.push({
      index: i,
      year: Math.floor(i / 12) + 1,
      monthKey: finMonthKey(d),
      label: d.toLocaleDateString('en', { month: 'short', year: 'numeric' }),
    });
  }
  return months;
}

function finTrendGrowthRate(actualsInOrder) {
  // actualsInOrder: array of {rides} for months that have real data, in chronological order.
  if (actualsInOrder.length < 2) return null;
  const sampleSize = Math.min(3, actualsInOrder.length - 1);
  const recent = actualsInOrder.slice(-(sampleSize + 1));
  let sum = 0;
  for (let k = 1; k < recent.length; k++) sum += recent[k].rides - recent[k - 1].rides;
  return sum / sampleSize;
}

// Core computation. Returns { monthly: [...], yearly: [...], meta: {...} }
function finComputeModel({ params, annualTargets, monthTargetOverrides, actualsByMonth, startDate, growthBasis }) {
  const months = finBuildMonthTimeline(startDate);

  const actualsInOrder = months
    .map(m => ({ ...m, actual: actualsByMonth[m.monthKey] || null }))
    .filter(m => m.actual !== null)
    .map(m => ({ index: m.index, rides: m.actual.rides }));

  const lastActualIndex = actualsInOrder.length ? actualsInOrder[actualsInOrder.length - 1].index : -1;
  const trend = finTrendGrowthRate(actualsInOrder);
  const growthRate = (growthBasis === 'trend' && trend !== null) ? trend : params.monthlyRideGrowth;

  // Average real price-per-ride (from actuals) — used to convert forecast rides into
  // forecast revenue when no explicit standardRidePrice assumption is set.
  let avgActualPrice = params.standardRidePrice;
  if (!avgActualPrice) {
    let totalRides = 0, totalGbv = 0;
    Object.values(actualsByMonth).forEach(a => { totalRides += a.rides; totalGbv += a.gbv; });
    avgActualPrice = totalRides > 0 ? totalGbv / totalRides : 0;
  }

  let runningRides = null;
  const monthly = months.map((m) => {
    const actual = actualsByMonth[m.monthKey] || null;
    const isActual = !!actual;

    let rides;
    if (isActual) {
      rides = actual.rides;
      runningRides = rides;
    } else if (runningRides === null) {
      rides = 0; // no actuals yet and no prior forecast point to grow from
    } else {
      runningRides = Math.max(0, runningRides + growthRate);
      rides = runningRides;
    }

    const revenue = isActual ? actual.revenue : rides * avgActualPrice * params.standardCommissionRate;
    const gmv = isActual ? actual.gbv : rides * avgActualPrice;

    // Costs — always modeled (no real cost feed exists yet).
    const salaryWithTax = params.avgSalaryPerPerson * (1 + params.socialSecurityTax);
    const internSalaryWithTax = params.avgSalaryPerIntern * (1 + params.socialSecurityTax);
    const teamCosts = params.fullTimeTeamSize * salaryWithTax + params.internsTeamSize * internSalaryWithTax;

    const marketingMultiplier = Math.pow(1.5, m.year - 1);
    const marketingCosts = (params.marketingBudgetYear1 * marketingMultiplier) / 12;

    let operatingCosts;
    if (m.year === 1) {
      operatingCosts = params.operatingCostsMonthly;
    } else {
      const monthInYearIdx = m.index % 12;
      const prevYearEndMultiplier = Math.pow(1.10, m.year - 2);
      const monthlyGrowthFactor = Math.pow(1.10, 1 / 11);
      operatingCosts = params.operatingCostsMonthly * prevYearEndMultiplier * Math.pow(monthlyGrowthFactor, monthInYearIdx);
    }

    const paymentFees = gmv * params.paymentProcessingFee;
    const costs = Math.max(0, teamCosts + operatingCosts + marketingCosts + paymentFees);
    const profit = revenue - costs;

    const annual = annualTargets[m.year - 1] || FIN_DEFAULT_ANNUAL_TARGET;
    const override = monthTargetOverrides[m.index] || {};
    const targetRides = override.targetRides != null ? override.targetRides : annual.targetRides / 12;
    const targetRevenue = override.targetRevenue != null ? override.targetRevenue : annual.targetRevenue / 12;

    const isForecastBoundary = isActual && m.index === lastActualIndex;

    return {
      ...m,
      isActual,
      rides: Math.round(rides),
      revenue: Math.round(revenue),
      costs: Math.round(costs),
      teamCosts: Math.round(teamCosts),
      marketingCosts: Math.round(marketingCosts),
      operatingCosts: Math.round(operatingCosts),
      paymentFees: Math.round(paymentFees),
      profit: Math.round(profit),
      targetRides: Math.round(targetRides),
      targetRevenue: Math.round(targetRevenue),
      actualRidesSeries: isActual ? Math.round(rides) : null,
      forecastRidesSeries: (!isActual || isForecastBoundary) ? Math.round(rides) : null,
      actualRevenueSeries: isActual ? Math.round(revenue) : null,
      forecastRevenueSeries: (!isActual || isForecastBoundary) ? Math.round(revenue) : null,
    };
  });

  const yearly = [1, 2, 3].map(year => {
    const yearData = monthly.filter(m => m.year === year);
    const revenue = yearData.reduce((s, m) => s + m.revenue, 0);
    const costs = yearData.reduce((s, m) => s + m.costs, 0);
    return { year, revenue, costs, profit: revenue - costs };
  });

  let breakEven = null;
  for (const m of monthly) {
    const netRate = params.standardCommissionRate - params.paymentProcessingFee;
    const fixed = m.teamCosts + m.operatingCosts + m.marketingCosts;
    const beRides = avgActualPrice > 0 && netRate > 0 ? fixed / (avgActualPrice * netRate) : 0;
    if (m.rides >= beRides && beRides > 0) { breakEven = m; break; }
  }

  // Cash gap: total funding needed to cover losses until break-even (or over the
  // full 3 years, if break-even is never reached in the horizon).
  const monthsToSum = breakEven ? monthly.slice(0, breakEven.index + 1) : monthly;
  const cashGap = Math.abs(monthsToSum.reduce((s, m) => s + Math.min(0, m.profit), 0));

  // LTV / CAC — same formula as the standalone investor model: net revenue per
  // ride (after commission & payment fees) × lifetime rides, vs. Year-1
  // marketing spend spread over new customers acquired.
  const netRevenuePerRide = Math.max(0, avgActualPrice * (params.standardCommissionRate - params.paymentProcessingFee));
  const customerLifetimeValue = netRevenuePerRide * params.avgRidesPerCustomerLifetime;
  const customerAcquisitionCost = params.newCustomersYear1 > 0 ? params.marketingBudgetYear1 / params.newCustomersYear1 : 0;
  const ltvCacRatio = customerAcquisitionCost > 0 ? customerLifetimeValue / customerAcquisitionCost : 0;

  return {
    monthly,
    yearly,
    meta: {
      lastActualIndex,
      actualMonthsCount: actualsInOrder.length,
      trend,
      growthRate,
      avgActualPrice,
      breakEven,
      cashGap,
      customerLifetimeValue,
      customerAcquisitionCost,
      ltvCacRatio,
      isLtvCacHealthy: ltvCacRatio >= 3,
      totalRevenue: monthly.reduce((s, m) => s + m.revenue, 0),
      totalCosts: monthly.reduce((s, m) => s + m.costs, 0),
      totalProfit: monthly.reduce((s, m) => s + m.profit, 0),
      totalActualRevenue: monthly.filter(m => m.isActual).reduce((s, m) => s + m.revenue, 0),
      totalTargetRevenue: annualTargets.reduce((s, t) => s + (t.targetRevenue || 0), 0),
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    finMonthKey, finAggregateActualsByMonth, finEarliestRideDate,
    finBuildMonthTimeline, finTrendGrowthRate, finComputeModel,
    finLoadParams, finSaveParams, finLoadAnnualTargets, finSaveAnnualTargets,
    finLoadMonthTargetOverrides, finSaveMonthTargetOverrides,
    FIN_DEFAULT_PARAMS, FIN_TOTAL_MONTHS, FIN_COMMISSION_START, FIN_SCENARIOS,
  };
}
