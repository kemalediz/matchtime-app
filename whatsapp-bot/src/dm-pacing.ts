/**
 * DM pacing RULES: the one source of truth for the gap between private
 * messages (slice L5a, approved by Kemal 24 Oct 2026). Pure: no clock, no
 * disk, no randomness of its own. `dm-pacer.ts` holds the state and does
 * the I/O; `scheduler.ts` and `platform-jobs.ts` only ever ask it.
 *
 * ── The rule ─────────────────────────────────────────────────────────
 * "About 10 seconds between private messages (up to six a minute, up from
 * one), with a small random spread. One global setting for every DM. A new
 * number starts at one a minute for its first two weeks; the setting drops
 * back to one a minute at once if WhatsApp shows any warning."
 *
 * Why so careful: WhatsApp restricted the MatchTime number for 21 hours on
 * 2026-04-30 after about 56 DMs in quick succession. One a minute has held
 * since. Group posts, polls, bench prompts and reactions are NOT paced
 * (they go into a chat that already exists).
 *
 * ── Env (read once, at startup) ──────────────────────────────────────
 *   DM_GAP_SEC            target gap, 7..60. Unset: 60 (today's behaviour).
 *   DM_GAP_JITTER_SEC     spread either side of the target, 0..30. Unset: 0.
 *   DM_NUMBER_STARTED_AT  ISO date the WhatsApp number started sending. For
 *                         its first 14 days the gap is 60 s whatever
 *                         DM_GAP_SEC says. UNSET with a fast gap also means
 *                         60 s: we cannot know the number is past its warm-up.
 * A bad value falls back to the safe value for that setting and is reported
 * once (`problems`).
 *
 * ── The safe gap is the old code path ────────────────────────────────
 * Whenever the gap in force is the 60 s safe gap (default, warm-up, no
 * start date, warning) the scheduler never waits inside a tick: it sends
 * one DM and releases the rest, exactly as before this slice.
 */

export const SAFE_GAP_MS = 60_000;
/** The spread never takes a gap below this. */
export const MIN_GAP_MS = 7_000;
/** Nor above this: slower than one a minute is not a pacing setting. */
export const MAX_GAP_MS = 60_000;
const MAX_JITTER_MS = 30_000;
export const WARM_UP_MS = 14 * 24 * 3_600_000;
/** How long the gap stays at 60 s after the LAST warning. */
export const WARNING_COOL_DOWN_MS = 24 * 3_600_000;

export interface DmPacingConfig {
  /** The target gap once warmed up and with no recent warning. */
  gapMs: number;
  /** Uniform spread either side of the target. */
  jitterMs: number;
  /** When the number started sending, or null when unknown. */
  numberStartedAtMs: number | null;
}

export const DEFAULT_DM_PACING: DmPacingConfig = Object.freeze({
  gapMs: SAFE_GAP_MS,
  jitterMs: 0,
  numberStartedAtMs: null,
}) as DmPacingConfig;

export function resolveDmPacingConfig(env: Record<string, string | undefined>): {
  config: DmPacingConfig;
  problems: string[];
} {
  const problems: string[] = [];
  const clean = (v: string | undefined) => (typeof v === "string" ? v.trim() : "");

  let gapMs = DEFAULT_DM_PACING.gapMs;
  const gapRaw = clean(env.DM_GAP_SEC);
  if (gapRaw) {
    const n = Number(gapRaw);
    if (Number.isFinite(n) && n * 1000 >= MIN_GAP_MS && n * 1000 <= MAX_GAP_MS) gapMs = Math.round(n * 1000);
    else problems.push(`DM_GAP_SEC=${JSON.stringify(gapRaw)} is not a number of seconds from 7 to 60; using 60`);
  }

  let jitterMs = DEFAULT_DM_PACING.jitterMs;
  const jitterRaw = clean(env.DM_GAP_JITTER_SEC);
  if (jitterRaw) {
    const n = Number(jitterRaw);
    if (Number.isFinite(n) && n >= 0 && n * 1000 <= MAX_JITTER_MS) jitterMs = Math.round(n * 1000);
    else problems.push(`DM_GAP_JITTER_SEC=${JSON.stringify(jitterRaw)} is not a number of seconds from 0 to 30; using 0`);
  }

  let numberStartedAtMs: number | null = null;
  const startedRaw = clean(env.DM_NUMBER_STARTED_AT);
  if (startedRaw) {
    const t = Date.parse(startedRaw);
    if (Number.isFinite(t)) numberStartedAtMs = t;
    else problems.push(`DM_NUMBER_STARTED_AT=${JSON.stringify(startedRaw)} is not a date; treating the number as new (60 s)`);
  }

  return { config: { gapMs, jitterMs, numberStartedAtMs }, problems };
}

// ── State ────────────────────────────────────────────────────────────

export interface AccountWarning {
  /** Where it was seen, e.g. "baileys:reachout-timelock". */
  source: string;
  /** A short human line for the journal. Never message text. */
  detail: string;
}

export interface DmPacingState {
  /** When the last DM took the slot, or null before the first. */
  lastDmAtMs: number | null;
  /** The gap drawn for the DM after that one. */
  gapAfterLastMs: number;
  lastWarning: { atMs: number; source: string; detail: string } | null;
}

export function initialPacingState(lastWarning: DmPacingState["lastWarning"] = null): DmPacingState {
  return { lastDmAtMs: null, gapAfterLastMs: SAFE_GAP_MS, lastWarning };
}

export type GapReason = "default" | "configured" | "warm-up" | "no-start-date" | "warning";

export interface EffectiveGap {
  baseMs: number;
  jitterMs: number;
  reason: GapReason;
}

/** The gap in force right now, and why. */
export function effectiveGap(cfg: DmPacingConfig, state: DmPacingState, nowMs: number): EffectiveGap {
  const safe = (reason: GapReason): EffectiveGap => ({ baseMs: SAFE_GAP_MS, jitterMs: 0, reason });
  if (state.lastWarning && nowMs - state.lastWarning.atMs < WARNING_COOL_DOWN_MS) return safe("warning");
  if (cfg.gapMs >= SAFE_GAP_MS) return safe("default");
  if (cfg.numberStartedAtMs === null) return safe("no-start-date");
  if (nowMs - cfg.numberStartedAtMs < WARM_UP_MS) return safe("warm-up");
  return { baseMs: cfg.gapMs, jitterMs: cfg.jitterMs, reason: "configured" };
}

/** The gap the slot must stay closed after the last DM, as of now. */
function requiredGapMs(cfg: DmPacingConfig, state: DmPacingState, nowMs: number): number {
  const eff = effectiveGap(cfg, state, nowMs);
  // A warning (or the warm-up) applies to the NEXT DM at once, whatever
  // gap was drawn when the last one went.
  return eff.baseMs >= SAFE_GAP_MS ? SAFE_GAP_MS : state.gapAfterLastMs;
}

/** Milliseconds until the slot opens; 0 when it is open. */
export function slotWaitMs(cfg: DmPacingConfig, state: DmPacingState, nowMs: number): number {
  if (state.lastDmAtMs === null) return 0;
  return Math.max(0, state.lastDmAtMs + requiredGapMs(cfg, state, nowMs) - nowMs);
}

/** The longest an in-tick wait may be right now: the gap in force, or 60 s in safe mode. */
export function maxInTickWaitMs(cfg: DmPacingConfig, state: DmPacingState, nowMs: number): number {
  return requiredGapMs(cfg, state, nowMs);
}

/** Take the slot now, drawing the gap for the next DM. Call only when `slotWaitMs` is 0. */
export function takeSlot(
  cfg: DmPacingConfig,
  state: DmPacingState,
  nowMs: number,
  random: () => number,
): DmPacingState {
  const eff = effectiveGap(cfg, state, nowMs);
  let gap = SAFE_GAP_MS;
  if (eff.baseMs < SAFE_GAP_MS) {
    const r = Math.min(Math.max(random(), 0), 1);
    gap = Math.round(eff.baseMs + (r * 2 - 1) * eff.jitterMs);
    gap = Math.min(Math.max(gap, MIN_GAP_MS), MAX_GAP_MS);
  }
  return { ...state, lastDmAtMs: nowMs, gapAfterLastMs: gap };
}

export function noteWarning(state: DmPacingState, nowMs: number, w: AccountWarning): DmPacingState {
  return { ...state, lastWarning: { atMs: nowMs, source: w.source, detail: w.detail } };
}

// ── The in-tick decision ─────────────────────────────────────────────

export type TickDecision = { action: "send" } | { action: "wait"; ms: number } | { action: "hold" };

/**
 * Send now, wait inside this tick for the slot, or hold (the caller
 * releases the claim so the server re-emits it on a later poll).
 *
 *   - never wait in safe mode (`gapMs` 60 s): the old behaviour, exactly;
 *   - never wait longer than the gap in force or the tick's budget left;
 *   - once anything was held this tick, hold everything after it, so a
 *     later DM cannot overtake one the server listed first.
 */
export function decideInTick(input: {
  waitMs: number;
  gapMs: number;
  budgetLeftMs: number;
  heldAlready: boolean;
}): TickDecision {
  if (input.heldAlready) return { action: "hold" };
  if (input.waitMs <= 0) return { action: "send" };
  if (input.gapMs >= SAFE_GAP_MS) return { action: "hold" };
  if (input.waitMs > input.gapMs || input.waitMs > input.budgetLeftMs) return { action: "hold" };
  return { action: "wait", ms: input.waitMs };
}

// ── Persistence (the warning only) ───────────────────────────────────

export interface PersistedWarning {
  lastWarningAtIso: string;
  source: string;
  detail: string;
}

export function persistWarning(state: DmPacingState): PersistedWarning | null {
  const w = state.lastWarning;
  if (!w) return null;
  return { lastWarningAtIso: new Date(w.atMs).toISOString(), source: w.source, detail: w.detail };
}

export function parsePersistedWarning(raw: unknown): DmPacingState["lastWarning"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.lastWarningAtIso !== "string") return null;
  const atMs = Date.parse(r.lastWarningAtIso);
  if (!Number.isFinite(atMs)) return null;
  return {
    atMs,
    source: typeof r.source === "string" ? r.source : "unknown",
    detail: typeof r.detail === "string" ? r.detail : "",
  };
}

// ── Warning signals the code can actually observe ────────────────────
// Each one returns null for "not a warning". Conservative by design: a
// false warning costs 24 hours at the old one-a-minute pace, a missed one
// can cost the number.

/** Baileys close: 401 logged out, 403 forbidden (connection.ts FATAL). */
export function warningFromCloseStatus(status: number | undefined): AccountWarning | null {
  if (status === 401) return { source: "baileys:close", detail: "logged out (status 401)" };
  if (status === 403) return { source: "baileys:close", detail: "forbidden (status 403)" };
  return null;
}

/** Baileys `connection.update.reachoutTimeLock`: WhatsApp's own restriction notice. */
export function warningFromReachoutTimelock(lock: unknown): AccountWarning | null {
  if (!lock || typeof lock !== "object") return null;
  const l = lock as { isActive?: unknown; enforcementType?: unknown; timeEnforcementEnds?: unknown };
  if (l.isActive !== true) return null;
  const ends = l.timeEnforcementEnds instanceof Date ? ` until ${l.timeEnforcementEnds.toISOString()}` : "";
  return {
    source: "baileys:reachout-timelock",
    detail: `reach-out timelock active (${String(l.enforcementType ?? "DEFAULT")})${ends}`,
  };
}

/** Baileys bad ack on our own message: `messageStubParameters[0]` is the error code. */
export function warningFromAckError(stubParameters: unknown): AccountWarning | null {
  if (!Array.isArray(stubParameters)) return null;
  if (String(stubParameters[0]) !== "463") return null;
  return { source: "baileys:ack-463", detail: "message refused with 463 (account restricted)" };
}

const SEND_WARNING_TEXT = /rate-overlimit|\b429\b|\b463\b|spam|reachout|account.?restrict/i;

/** A send that threw. 403 is NOT here: it is also "you may not post in this group". */
export function warningFromSendError(err: unknown): AccountWarning | null {
  if (!err || typeof err !== "object") return null;
  const status = (err as { output?: { statusCode?: unknown } }).output?.statusCode;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? "");
  if (status === 429 || status === 463 || SEND_WARNING_TEXT.test(message)) {
    return {
      source: "baileys:send",
      detail: `send refused: ${message.slice(0, 120)}${typeof status === "number" ? ` (status ${status})` : ""}`,
    };
  }
  return null;
}

const WWEBJS_WARNING_STATES = new Set(["TOS_BLOCK", "SMB_TOS_BLOCK", "LOGOUT", "UNPAIRED"]);

/** whatsapp-web.js `disconnected` reason (a WAState, or "LOGOUT"). */
export function warningFromWwebjsDisconnect(reason: unknown): AccountWarning | null {
  if (typeof reason !== "string" || !WWEBJS_WARNING_STATES.has(reason)) return null;
  return { source: "wwebjs:disconnected", detail: `disconnected: ${reason}` };
}
