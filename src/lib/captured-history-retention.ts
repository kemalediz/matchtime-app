/**
 * How long captured group chat is kept while nobody has read it (owner's
 * decision, 2026-10-08). THE one number; the rule and the job that
 * enforces it are in captured-history-expiry.ts. It lives in its own file,
 * with no imports, so group-add.ts can read it without pulling in the
 * learned-setup code.
 */
export const CAPTURED_HISTORY_RETENTION_DAYS = 7;
export const CAPTURED_HISTORY_RETENTION_MS = CAPTURED_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
