/**
 * The ONE DM slot, as running state (slice L5a, 24 Oct 2026). The rules
 * are in `dm-pacing.ts` (pure); this file holds the state, the clock, the
 * random source and the warning file, and the per-tick gate the scheduler
 * and the platform channel share.
 *
 * ── One slot for every DM ────────────────────────────────────────────
 * Club DMs (scheduler.ts, due-posts) and platform DMs (platform-jobs.ts)
 * take the same slot through the same `TickGate`, so a sign-up code and a
 * reminder can never go out inside one gap between them.
 *
 * ── The warning file ─────────────────────────────────────────────────
 * When WhatsApp shows a warning (`AccountWarning`, wired in the drivers and
 * passed in by index.ts) the gap drops to 60 s at once for 24 hours. The
 * moment is written SYNCHRONOUSLY to a small JSON file, because a fatal
 * Baileys close exits the process straight after reporting it, and a
 * restart must not undo the fall-back. Default path
 * `whatsapp-bot/.dm-pacing.json` (gitignored; `git pull` on deploy leaves
 * it alone); override with DM_PACING_STATE_PATH. Not under the Baileys
 * auth folder on purpose: a re-pair moves that folder aside, and a logout
 * (401) is exactly when the warning must outlive the session.
 *
 * Only the warning is persisted. The last DM's time is not (as before this
 * slice): a restart opens the slot for one DM, then the gap applies.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonFileIO, type JsonIO } from "./baileys/json-file.js";
import {
  decideInTick,
  effectiveGap,
  initialPacingState,
  maxInTickWaitMs,
  noteWarning as noteWarningRule,
  parsePersistedWarning,
  persistWarning,
  resolveDmPacingConfig,
  slotWaitMs,
  takeSlot,
  type AccountWarning,
  type DmPacingConfig,
  type DmPacingState,
  type GapReason,
} from "./dm-pacing.js";

export interface DmPacer {
  /** Milliseconds until the slot opens; 0 when open. */
  waitMs(): number;
  /** The longest an in-tick wait may be now (60 s in safe mode means "never wait"). */
  maxWaitMs(): number;
  /** Reserve the slot NOW, before the send is awaited. */
  take(label: string): void;
  /** WhatsApp showed a warning: 60 s at once, for the cool-down, saved to disk. */
  noteWarning(w: AccountWarning): void;
  status(): { gapMs: number; jitterMs: number; reason: GapReason };
}

export interface DmPacerDeps {
  config: DmPacingConfig;
  now(): number;
  random(): number;
  /** Where the warning lives across restarts; null keeps it in memory only. */
  store: JsonIO | null;
  log(line: string): void;
  error?(line: string): void;
}

function describeGap(g: { gapMs: number; jitterMs: number; reason: GapReason }): string {
  const spread = g.jitterMs ? ` ±${g.jitterMs / 1000}s` : "";
  return `${g.gapMs / 1000}s${spread} between DMs (${g.reason})`;
}

export function createDmPacer(deps: DmPacerDeps): DmPacer {
  const error = deps.error ?? deps.log;
  let lastWarning: DmPacingState["lastWarning"] = null;
  try {
    lastWarning = parsePersistedWarning(deps.store?.load() ?? null);
  } catch (err) {
    error(`[dm-pacing] could not read the warning file: ${err instanceof Error ? err.message : String(err)}`);
  }
  let state = initialPacingState(lastWarning);

  const status = () => {
    const g = effectiveGap(deps.config, state, deps.now());
    return { gapMs: g.baseMs, jitterMs: g.jitterMs, reason: g.reason };
  };
  // Logged on every change of mode (warm-up over, cool-down over, a
  // warning), so the journal says when the pace changed and why.
  let lastReason: GapReason = status().reason;
  const noticeChange = () => {
    const s = status();
    if (s.reason !== lastReason) {
      deps.log(`[dm-pacing] now ${describeGap(s)}; was ${lastReason}`);
      lastReason = s.reason;
    }
  };

  return {
    waitMs() {
      noticeChange();
      return slotWaitMs(deps.config, state, deps.now());
    },
    maxWaitMs() {
      return maxInTickWaitMs(deps.config, state, deps.now());
    },
    take(_label) {
      state = takeSlot(deps.config, state, deps.now(), deps.random);
    },
    noteWarning(w) {
      state = noteWarningRule(state, deps.now(), w);
      lastReason = "warning";
      error(`CRITICAL: [dm-pacing] WhatsApp warning from ${w.source}: ${w.detail}. DMs drop to one every 60 s for 24 hours.`);
      try {
        const p = persistWarning(state);
        if (p) deps.store?.save(p);
      } catch (err) {
        // In memory it already holds; only a restart could undo it.
        error(`[dm-pacing] could not save the warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    status,
  };
}

// ── The per-tick gate ────────────────────────────────────────────────

export interface TickGate {
  /**
   * True: the slot is taken for this DM, send it. False: hold it (the
   * caller releases the claim). May sleep first, within the budget.
   */
  acquire(label: string): Promise<boolean>;
}

/**
 * One per scheduler tick. Waits for the slot only while the gap is below
 * the safe 60 s, the wait is no longer than the gap, and the tick's total
 * waiting stays inside `budgetMs`. After the first hold, holds everything.
 */
export function createTickGate(
  pacer: DmPacer,
  opts: {
    sleep(ms: number): Promise<void>;
    budgetMs: number;
    log?(line: string): void;
    /**
     * True once the scheduler is stopping (a disconnect, SIGTERM): a wait
     * in progress ends as a hold, so the DM is RELEASED back to the server
     * instead of being sent into a closing socket or lost with the process.
     */
    stopped?(): boolean;
  },
): TickGate {
  const log = opts.log ?? ((l: string) => console.log(l));
  let budgetLeftMs = Math.max(0, opts.budgetMs);
  let heldAlready = false;

  return {
    async acquire(label) {
      // Bounded: every pass either returns or spends budget on a positive wait.
      for (;;) {
        const waitMs = pacer.waitMs();
        const d = decideInTick({
          waitMs,
          gapMs: pacer.maxWaitMs(),
          budgetLeftMs,
          heldAlready: heldAlready || (opts.stopped?.() ?? false),
        });
        if (d.action === "send") {
          pacer.take(label);
          return true;
        }
        if (d.action === "hold") {
          if (!heldAlready && waitMs > 0) {
            log(`[rate-limit] ${label} held, ${Math.ceil(waitMs / 1000)}s until next DM allowed`);
          } else {
            log(`[rate-limit] ${label} held`);
          }
          heldAlready = true;
          return false;
        }
        budgetLeftMs -= d.ms;
        await opts.sleep(d.ms);
      }
    },
  };
}

// ── The process's pacer ──────────────────────────────────────────────

const BOT_DIR = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_STATE_FILE = ".dm-pacing.json";

let processPacer: DmPacer | null = null;

/** Built once, from the env, on first use. */
export function getDmPacer(env: NodeJS.ProcessEnv = process.env): DmPacer {
  if (processPacer) return processPacer;
  const { config, problems } = resolveDmPacingConfig(env);
  for (const p of problems) console.error(`[dm-pacing] ${p}`);
  const override = env.DM_PACING_STATE_PATH?.trim();
  // Under vitest nothing touches the repo's real file unless a test names one.
  const path = override || (env.VITEST ? null : join(BOT_DIR, DEFAULT_STATE_FILE));
  processPacer = createDmPacer({
    config,
    now: () => Date.now(),
    random: Math.random,
    store: path ? jsonFileIO(path) : null,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  });
  const s = processPacer.status();
  const started = config.numberStartedAtMs === null ? "unset" : new Date(config.numberStartedAtMs).toISOString().slice(0, 10);
  console.log(`[dm-pacing] ${describeGap(s)}; DM_GAP_SEC target ${config.gapMs / 1000}s, number started ${started}`);
  return processPacer;
}

/** index.ts wires the drivers' `onAccountWarning` here. */
export function noteDmAccountWarning(w: AccountWarning): void {
  getDmPacer().noteWarning(w);
}

/** Tests only: swap the process pacer (null rebuilds from the env on next use). */
export function _setDmPacerForTest(p: DmPacer | null): void {
  processPacer = p;
}
