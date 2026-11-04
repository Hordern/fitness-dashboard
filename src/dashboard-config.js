// Dashboard display settings. The page reads them from /api/dashboard, and the
// API uses them to decide how much history to send.
export const DASHBOARD = {
  // The period pills under every chart, in order. Days count back from today.
  chart_ranges: [
    { label: "Week", days: 7 },
    { label: "Month", days: 31 },
    { label: "3 months", days: 92 },
  ],
  default_range_days: 31, // the pill selected when the page opens
  card_trend_days: 14, // the small trend lines on the Fitness cards
};

// The longest period any chart or card can show.
export const maxHistoryDays = Math.max(DASHBOARD.card_trend_days, ...DASHBOARD.chart_ranges.map((r) => r.days));
