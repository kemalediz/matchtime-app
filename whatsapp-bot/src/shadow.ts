/**
 * SHADOW MODE: a bot that listens and cannot speak.
 *
 * ── What it is for ──────────────────────────────────────────────────
 * Phase 5 of `MDs/baileys-migration-plan-2026-09-21.md`. A second
 * WhatsApp number, on Baileys, in a throwaway group, for a week, so that
 * the eight things nobody can learn from reading code (the offline
 * replay, LID to phone resolution, reactions, mentions, poll votes,
 * participant events, history on join, memory without Chromium) are
 * measured somewhere that is not a live club.
 *
 * The week is only worth having if it cannot touch Sutton FC. "The
 * caller never calls send" is not a guarantee, it is a hope: the
 * scheduler, the flush, the DM nudge, the self-setup intro and the
 * reaction ticks are five separate code paths that each end in a send,
 * and any of them firing once in a group of strangers is the incident
 * this mode exists to prevent. So the refusal lives at the DRIVER, below
 * every caller, and it is exhaustive by construction:
 * `shadow.source.test.ts` reads `driver.ts` and fails if an outbound
 * member exists that `SHADOW_SEND_MEMBERS` does not name.
 *
 * ── What it switches off, and where ─────────────────────────────────
 *   sends           here, at the driver (`shadowGuard`). Throws, counts
 *                   and logs what it WOULD have sent.
 *   server writes   here, at `api.ts`'s one fetch (`refuseServerWriteInShadow`).
 *                   A shadow bot added to a group must not create an
 *                   onboarding session in the production database.
 *   scheduler       `index.ts`, which does not call `initScheduler`.
 *   batch flush     `index.ts`, which does not start the timer. That also
 *                   stops the heartbeat, so a shadow process cannot
 *                   pollute the real Pi's health signal.
 *   org refresh,
 *   participant
 *   sweep, catch-up `index.ts`, which leaves the open handler early.
 *
 * Inbound is untouched. The whole point is to hear everything.
 *
 * ── Why a typo throws ───────────────────────────────────────────────
 * The dangerous direction is an operator who believes the guard is on
 * while it is off. `WA_DRIVER` follows the same rule for the same
 * reason: on the morning somebody sets these over SSH, "it started fine"
 * must not be able to mean "it started fine without the guard".
 *
 * No WhatsApp library is imported here, and none may be: this module sits
 * above the driver seam (`driver-seam.test.ts`).
 */
import type { WaDriver } from "./driver.js";
import type { ReactionOutcome } from "./react-with-id.js";

/** The one switch. */
export const SHADOW_ENV = "WA_SHADOW";

export interface ShadowMode {
  readonly enabled: boolean;
  /** Where the decision came from, for the startup line. */
  readonly source: string;
}

const YES = ["1", "true", "yes", "on"];
const NO = ["0", "false", "no", "off"];

export function resolveShadowMode(env: Record<string, string | undefined>): ShadowMode {
  const raw = typeof env[SHADOW_ENV] === "string" ? (env[SHADOW_ENV] as string).trim() : "";
  if (raw.length === 0) return { enabled: false, source: `${SHADOW_ENV} unset` };
  const value = raw.toLowerCase();
  if (YES.includes(value)) return { enabled: true, source: `${SHADOW_ENV}=${raw}` };
  if (NO.includes(value)) return { enabled: false, source: `${SHADOW_ENV}=${raw}` };
  throw new Error(
    `${SHADOW_ENV}=${JSON.stringify(raw)} is not a yes or a no. Use one of ` +
      `${YES.join(", ")} to run the Phase 5 shadow bot (receive-only, every send refused at ` +
      `the driver), or one of ${NO.join(", ")}, or leave it unset. It is not defaulted, ` +
      "because believing the guard is on while it is off is the failure this mode exists " +
      "to prevent.",
  );
}

let cached: ShadowMode | null = null;

/** The process's mode, read from `process.env` once. */
export function shadowMode(): ShadowMode {
  cached ??= resolveShadowMode(process.env);
  return cached;
}

// ── The counters ────────────────────────────────────────────────────

export interface ShadowStats {
  /** Sends refused, across every member. */
  sendsRefused: number;
  /** Sends refused, by driver member. */
  byMember: Record<string, number>;
  /** Writes to the MatchTime server refused. */
  serverWritesRefused: number;
}

const stats: ShadowStats = { sendsRefused: 0, byMember: {}, serverWritesRefused: 0 };

/** A snapshot, for a log line or a test. */
export function shadowStats(): ShadowStats {
  return { ...stats, byMember: { ...stats.byMember } };
}

/** Tests only: forget the cached mode and the counters. */
export function _test_resetShadow(): void {
  cached = null;
  stats.sendsRefused = 0;
  stats.serverWritesRefused = 0;
  for (const k of Object.keys(stats.byMember)) delete stats.byMember[k];
}

// ── What a refusal looks like ───────────────────────────────────────

/**
 * Every outbound member of `WaDriver`.
 *
 * Pinned against `driver.ts` itself by `shadow.source.test.ts`. Adding a
 * send to the interface without adding it here is a failing test, not a
 * silent hole.
 */
export const SHADOW_SEND_MEMBERS = [
  "sendText",
  "sendTextWithMentions",
  "sendDirectText",
  "sendPoll",
  "sendReaction",
  "replyTo",
  "sendTextViaChat",
] as const;

export type ShadowSendMember = (typeof SHADOW_SEND_MEMBERS)[number];

export class ShadowModeSendRefused extends Error {
  override readonly name = "ShadowModeSendRefused";
  constructor(
    readonly member: ShadowSendMember,
    /** What it would have done, in the same words as the log line. */
    readonly would: string,
  ) {
    super(
      `[shadow] ${member} refused: this process is running in shadow mode ` +
        `(${SHADOW_ENV}), so it sends nothing. It would have done: ${would}`,
    );
  }
}

const PREVIEW_MAX = 160;

/**
 * One safe, single-line rendering of anything.
 *
 * Newlines become `\n` because a squad post is fifteen lines long and a
 * refusal has to stay one log line. Total, including against a throwing
 * getter, which is what a broken whatsapp-web.js payload hands us.
 */
export function shadowPreview(value: unknown, max = PREVIEW_MAX): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return "<unreadable>";
  }
  if (typeof text !== "string") return "<unreadable>";
  const flat = text.replace(/\r/g, "").replace(/\n/g, "\\n");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ── The guard ───────────────────────────────────────────────────────

export interface ShadowGuardOptions {
  log?(line: string): void;
}

/**
 * Wrap a driver so that every send refuses, and nothing else changes.
 *
 * A Proxy rather than a spread, deliberately. A spread copies the members
 * that exist at the moment it runs; a Proxy forwards whatever is asked
 * for, so a member added to a driver later cannot arrive unguarded, and a
 * getter stays a getter. The only members it intercepts are the ones
 * named in `SHADOW_SEND_MEMBERS`, plus `shadowGuarded` so a log line (and
 * a test) can tell a guarded driver from a bare one.
 *
 * The raw driver never escapes `createDriver`, so there is no reference
 * anywhere in the bot that could be used to go around this.
 */
export function shadowGuard<T extends WaDriver>(driver: T, opts: ShadowGuardOptions = {}): T {
  const log = opts.log ?? ((l: string) => console.warn(l));

  function refuse(member: ShadowSendMember, would: string): ShadowModeSendRefused {
    stats.sendsRefused++;
    stats.byMember[member] = (stats.byMember[member] ?? 0) + 1;
    log(`[shadow] REFUSED ${member}: ${would}`);
    return new ShadowModeSendRefused(member, would);
  }

  const overrides: Record<string, unknown> = {
    shadowGuarded: true,

    sendText: async (chatId: string, text: string) => {
      throw refuse("sendText", `post in ${chatId}: "${shadowPreview(text)}"`);
    },

    sendTextWithMentions: async (chatId: string, text: string, mentionPhones: string[]) => {
      const who = Array.isArray(mentionPhones) ? mentionPhones : [];
      throw refuse(
        "sendTextWithMentions",
        `post in ${chatId} tagging ${who.length} (${shadowPreview(who.slice(0, 5).join(", "), 60)}): ` +
          `"${shadowPreview(text)}"`,
      );
    },

    sendDirectText: async (phone: string, text: string) => {
      throw refuse("sendDirectText", `DM ${phone}: "${shadowPreview(text)}"`);
    },

    sendPoll: async (
      chatId: string,
      question: string,
      options: string[],
      allowMultipleAnswers: boolean,
    ) => {
      const opts2 = Array.isArray(options) ? options : [];
      throw refuse(
        "sendPoll",
        `poll in ${chatId}: "${shadowPreview(question, 80)}" ` +
          `[${shadowPreview(opts2.join(" | "), 120)}] multi=${allowMultipleAnswers === true}`,
      );
    },

    replyTo: async (msg: unknown, text: string) => {
      let chat = "?";
      try {
        const from = (msg as { from?: unknown } | null | undefined)?.from;
        if (typeof from === "string") chat = from;
      } catch {
        /* a throwing getter is exactly what a broken payload gives us */
      }
      throw refuse("replyTo", `reply in ${chat}: "${shadowPreview(text)}"`);
    },

    sendTextViaChat: async (chatId: string, text: string) => {
      throw refuse("sendTextViaChat", `post in ${chatId} via the chat handle: "${shadowPreview(text)}"`);
    },

    /**
     * NEVER throws, even here.
     *
     * `sendReaction`'s contract is that a failure is a named reason, not
     * an exception, because the attendance write has already happened and
     * a tick is only its confirmation (`react-with-id.ts`). Shadow mode is
     * a refusal like any other, so it answers in the same vocabulary and
     * `reactAndReport` logs it with the same line it logs a real failure
     * with.
     */
    sendReaction: async (waMessageId: string, emoji: string): Promise<ReactionOutcome> => {
      refuse("sendReaction", `react ${shadowPreview(emoji, 16)} on ${shadowPreview(waMessageId, 80)}`);
      return { ok: false, reason: "shadow-mode" };
    },
  };

  return new Proxy(driver, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
    has(target, prop) {
      return (typeof prop === "string" && prop in overrides) || Reflect.has(target, prop);
    },
  }) as T;
}

// ── Server writes ───────────────────────────────────────────────────

/**
 * Should this write to the MatchTime server be refused?
 *
 * Called from `api.ts`'s single `fetch` for every non-GET. The reason it
 * is not enough to switch off the scheduler and the flush: a reaction, a
 * poll vote, a DM reply and above all a self-add (`bot-added`) are
 * forwarded straight from their inbound handlers, and a shadow number
 * being added to a throwaway group would otherwise create a real
 * onboarding session against production.
 *
 * Returns false, and does nothing at all, when shadow mode is off.
 */
export function refuseServerWriteInShadow(url: string, body?: unknown): boolean {
  if (!shadowMode().enabled) return false;
  stats.serverWritesRefused++;
  let route = url;
  try {
    route = new URL(url).pathname;
  } catch {
    /* a relative or malformed url logs as it came */
  }
  console.warn(
    `[shadow] REFUSED server write ${route}: nothing was sent to MatchTime. ` +
      `Payload would have been: ${shadowPreview(typeof body === "string" ? body : String(body ?? ""))}`,
  );
  return true;
}

// ── What the journal says ───────────────────────────────────────────

export function shadowBanner(driverName: string, mode: ShadowMode): string {
  const bar = "=".repeat(72);
  return [
    "",
    bar,
    `  SHADOW MODE IS ON (${mode.source}). Driver: ${driverName}.`,
    "  This process RECEIVES ONLY. Every send is refused at the driver and",
    "  counted; every write to the MatchTime server is refused; the scheduler,",
    "  the batch-flush timer (and with it the heartbeat), the org refresh, the",
    "  participant sweep and the restart catch-up do not start.",
    "  It cannot post to any WhatsApp group, including Sutton FC's.",
    "  Phase 5 of MDs/baileys-migration-plan-2026-09-21.md.",
    bar,
    "",
  ].join("\n");
}

/**
 * The group the shadow run is watching, for the one read it DOES make.
 *
 * Optional. With `WA_SHADOW_GROUP=<jid>@g.us` set, the open handler asks
 * the driver for that group's recent messages once and logs the answer,
 * which is how the restart-replay question (plan §2.15) gets an answer in
 * the shape the real catch-up would have seen, rather than only in the
 * raw `[baileys][msg]` lines. It reads; it enqueues nothing, POSTs
 * nothing and sends nothing.
 */
export function shadowGroup(env: Record<string, string | undefined>): string {
  const raw = typeof env.WA_SHADOW_GROUP === "string" ? env.WA_SHADOW_GROUP.trim() : "";
  return raw.endsWith("@g.us") ? raw : "";
}

/** The line the open handler prints instead of starting the bot's work. */
export function shadowOpenNotice(): string {
  return (
    "[shadow] receive-only: not starting the scheduler, the batch-flush timer, the org " +
      "refresh, the participant sweep or the restart catch-up. Inbound is fully wired, so " +
      "every message, reaction, poll vote, join and leave is still logged. Read " +
      "MDs/baileys-migration-plan-2026-09-21.md, Phase 5, for what to measure."
  );
}
