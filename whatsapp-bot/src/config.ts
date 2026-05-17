// How often to poll /api/whatsapp/due-posts per org. Sub-minute
// precision configured via SCHEDULER_INTERVAL_SEC; falls back to
// SCHEDULER_INTERVAL_MIN minutes when unset. Defaults to 30 seconds
// so user-facing OTPs (claim flow, phone-signup) land near-real-time
// instead of waiting up to 5 minutes for the next tick.
function resolvePollMs(): number {
  const sec = parseInt(process.env.SCHEDULER_INTERVAL_SEC || "0");
  if (sec > 0) return sec * 1000;
  const min = parseInt(process.env.SCHEDULER_INTERVAL_MIN || "0");
  if (min > 0) return min * 60 * 1000;
  return 30 * 1000; // default: 30s
}

export const config = {
  apiUrl: process.env.MATCHTIME_API_URL || "https://matchtime.ai",
  apiKey: process.env.WHATSAPP_API_KEY || "",
  schedulerIntervalMs: resolvePollMs(),
};
