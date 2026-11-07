/**
 * WHAT A CLOUD API SEND MEANT, AND WHETHER TO TRY AGAIN (WhatsApp Cloud
 * API plan, PR C4). Plan: MDs/whatsapp-cloud-api-plan-2026-11-04.md,
 * sections 1 (Meta's error codes) and 5.5. Pure: no imports, no clock, no
 * network.
 *
 * ── AT MOST ONCE ───────────────────────────────────────────────────────
 * Meta documents no idempotency key (plan UNVERIFIED item 4), and its 200
 * only means "accepted". So a send is tried again ONLY when Meta said it
 * did not take the message:
 *   130429 throughput, 131056 the pair rate limit (one message per six
 *   seconds to one person), 80007 the account rate limit, and any HTTP
 *   5xx that carries Meta's error body;
 *   plus a connection that was never made (refused, no DNS): Meta never
 *   saw that request at all.
 * With backoff (`CLOUD_RETRY_BASE_MS` times 1, 4, 16), at most
 * `CLOUD_MAX_RETRIES` times. Anything that may have landed (a timeout
 * with no answer, a connection lost mid request, a 5xx with no body, a 200
 * with no wamid) is `unconfirmed`, never retried: the status webhook (PR
 * C5) settles it.
 *
 * ── FAILED, AND WHAT FOLLOWS ───────────────────────────────────────────
 *   131026 undeliverable, 131049 held for ecosystem health: failed.
 *   131050 he stopped marketing messages: failed, `stopMarketing` (the
 *          opt-out wiring is PR C8).
 *   132015 template paused, 132016 template disabled: failed,
 *          `flagTemplate`; the dispatcher stops using it until it is
 *          approved again.
 *   131047 the 24 hour window is closed: `window-closed`, so the
 *          dispatcher can send the job's template instead, once.
 *   Any other answer: failed.
 * A sign-up code whose retry would land after it expires is failed
 * instead: a dead code is worth nothing (`expiresAt`).
 */

/** Retries after the first try. */
export const CLOUD_MAX_RETRIES = 3;
/** The first retry's wait; each later one waits four times longer. */
export const CLOUD_RETRY_BASE_MS = 30_000;

/** Meta's codes for "not taken, try later". */
export const CLOUD_RETRYABLE_CODES = [130429, 131056, 80007] as const;
export const CLOUD_WINDOW_CLOSED_CODE = 131047;
export const CLOUD_STOP_MARKETING_CODE = 131050;
export const CLOUD_TEMPLATE_FLAG_BY_CODE: Readonly<Record<number, "PAUSED" | "DISABLED">> = { 132015: "PAUSED", 132016: "DISABLED" };

/** Meta's error object, as much of it as we use. */
export interface MetaError {
  code: number | null;
  subcode?: number | null;
  message?: string | null;
}

/** What one request to `POST /<PHONE_NUMBER_ID>/messages` came to. */
export type CloudSendResult =
  /** A 2xx. `wamid` null when the body named none. */
  | { kind: "accepted"; wamid: string | null }
  /** Any other HTTP answer. `error` null when the body was not Meta's. */
  | { kind: "error"; httpStatus: number; error: MetaError | null }
  /** No answer in time: it may have landed. */
  | { kind: "timeout" }
  /** The connection was never made: Meta never saw the request. */
  | { kind: "unreachable"; reason: string }
  /** The connection broke after the request went: it may have landed. */
  | { kind: "lost"; reason: string };

export type CloudSendVerdict =
  | { verdict: "sent"; wamid: string }
  | { verdict: "retry"; errorCode: number | null; retryAt: Date; reason: string }
  | { verdict: "unconfirmed"; errorCode: number | null; reason: string }
  | { verdict: "window-closed"; errorCode: number; reason: string }
  | { verdict: "failed"; errorCode: number | null; reason: string; stopMarketing?: true; flagTemplate?: "PAUSED" | "DISABLED" };

const MESSAGE_MAX = 200;

function describeError(httpStatus: number, error: MetaError | null): string {
  if (!error) return `HTTP ${httpStatus}, no error body`;
  const msg = (error.message ?? "").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
  return `Meta ${error.code ?? "?"} (HTTP ${httpStatus})${msg ? `: ${msg}` : ""}`;
}

/**
 * The one decision. `retriesSoFar`: retries already made for this job.
 * `expiresAt`: when what it carries stops being worth sending (a sign-up
 * code), or null.
 */
export function classifyCloudSend(
  result: CloudSendResult,
  ctx: { retriesSoFar: number; now: Date; expiresAt: Date | null },
): CloudSendVerdict {
  const retryOrGiveUp = (errorCode: number | null, reason: string): CloudSendVerdict => {
    if (ctx.retriesSoFar >= CLOUD_MAX_RETRIES) {
      return { verdict: "failed", errorCode, reason: `gave up after ${CLOUD_MAX_RETRIES} retries: ${reason}` };
    }
    const retryAt = new Date(ctx.now.getTime() + CLOUD_RETRY_BASE_MS * 4 ** ctx.retriesSoFar);
    if (ctx.expiresAt && retryAt.getTime() > ctx.expiresAt.getTime()) {
      return { verdict: "failed", errorCode, reason: `expired before it could be retried: ${reason}` };
    }
    return { verdict: "retry", errorCode, retryAt, reason };
  };

  switch (result.kind) {
    case "accepted":
      return result.wamid
        ? { verdict: "sent", wamid: result.wamid }
        : { verdict: "unconfirmed", errorCode: null, reason: "accepted with no message id" };
    case "timeout":
      return { verdict: "unconfirmed", errorCode: null, reason: "no answer in time; it may have landed" };
    case "lost":
      return { verdict: "unconfirmed", errorCode: null, reason: `connection lost after sending (${result.reason}); it may have landed` };
    case "unreachable":
      return retryOrGiveUp(null, `could not connect (${result.reason})`);
    case "error": {
      const code = result.error?.code ?? null;
      const reason = describeError(result.httpStatus, result.error);
      if (code !== null && (CLOUD_RETRYABLE_CODES as readonly number[]).includes(code)) return retryOrGiveUp(code, reason);
      if (result.httpStatus >= 500) {
        return result.error ? retryOrGiveUp(code, reason) : { verdict: "unconfirmed", errorCode: null, reason: `${reason}; it may have landed` };
      }
      if (code === CLOUD_WINDOW_CLOSED_CODE) return { verdict: "window-closed", errorCode: code, reason };
      if (code === CLOUD_STOP_MARKETING_CODE) return { verdict: "failed", errorCode: code, reason, stopMarketing: true };
      const flag = code !== null ? CLOUD_TEMPLATE_FLAG_BY_CODE[code] : undefined;
      if (flag) return { verdict: "failed", errorCode: code, reason, flagTemplate: flag };
      return { verdict: "failed", errorCode: code, reason };
    }
  }
}
