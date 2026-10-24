/**
 * THE POOL SCENARIO DSL, PURE HALF: who was sent what (2026-10-24, slice L1).
 *
 * MatchTime never sends anything itself; it QUEUES: a `BotJob` (a club's
 * DM, group post or admin group post), a `PlatformJob` (a DM that belongs
 * to no club: sign-up codes, and every pool DM to come), or an inline reply
 * the Pi posts (the admin group's `replyText`). This file turns those rows
 * into one shape, `SentMessage`, addressed by the scenario's own names
 * ("ali", "fnf.hq"), so a scenario asserts the conversation and not the
 * plumbing:
 *
 *   matchSent(sent, [{ to: "ali", purpose: "pool-offer", text: /FNF needs 1/ }])
 *   findLeaks(sent, [...phoneVariants(owner.phone), "Oscar Owner"], { to: ["ali"] })
 *
 * No database, no Playwright: unit-tested in transcript.test.ts. The I/O
 * half is world.ts.
 */

/** Where a message went. */
export type SentChannel = "dm" | "group" | "hq" | "action";

export interface SentMessage {
  /** The queued row's id. */
  id: string;
  channel: SentChannel;
  /** The scenario's name for the recipient: a person key ("ali"), a
   *  club's group ("fnf.group") or HQ ("fnf.hq"); anything the world does
   *  not know is named, never dropped ("unknown:+4477...", "org:<id>.group"). */
  to: string;
  text: string;
  via: "bot-job" | "platform-job" | "inline-reply";
  /** The club it was sent for; null on the platform channel. */
  orgId: string | null;
  /** PlatformJob.purpose ("otp", "pool-offer", ...); null for a BotJob. */
  purpose: string | null;
  /** Held until (quiet hours, waves); null: at once. */
  sendAfter: Date | null;
}

/** The world's address book: phone digits (no "+") to person key, org id to club key. */
export interface Registry {
  people: ReadonlyMap<string, string>;
  clubs: ReadonlyMap<string, string>;
}

const digits = (phone: string | null | undefined): string => (phone ?? "").replace(/\D/g, "");

function person(reg: Registry, phone: string | null): string {
  const d = digits(phone);
  return reg.people.get(d) ?? `unknown:+${d}`;
}

function club(reg: Registry, orgId: string, part: "group" | "hq"): string {
  const key = reg.clubs.get(orgId);
  return key ? `${key}.${part}` : `org:${orgId}.${part}`;
}

export interface BotJobRow {
  id: string;
  orgId: string;
  kind: string;
  phone: string | null;
  text: string;
  sendAfter: Date | null;
}

export function classifyBotJob(row: BotJobRow, reg: Registry): SentMessage {
  const base = { id: row.id, text: row.text, via: "bot-job" as const, orgId: row.orgId, purpose: null, sendAfter: row.sendAfter };
  if (row.kind === "dm") return { ...base, channel: "dm", to: person(reg, row.phone) };
  if (row.kind === "admin-group") return { ...base, channel: "hq", to: club(reg, row.orgId, "hq") };
  return { ...base, channel: "group", to: club(reg, row.orgId, "group") };
}

export interface PlatformJobRow {
  id: string;
  kind: string;
  phone: string | null;
  groupId: string | null;
  text: string | null;
  purpose: string;
  sendAfter: Date | null;
}

export function classifyPlatformJob(row: PlatformJobRow, reg: Registry): SentMessage {
  const base = { id: row.id, via: "platform-job" as const, orgId: null, purpose: row.purpose, sendAfter: row.sendAfter };
  if (row.kind === "dm") return { ...base, channel: "dm", to: person(reg, row.phone), text: row.text ?? "" };
  return { ...base, channel: "action", to: `group:${row.groupId ?? "?"}`, text: row.text ?? "" };
}

/** One expected message. Every field but `to` is optional. A string `text`
 *  must be contained; a RegExp must match. */
export interface ExpectedMessage {
  to: string;
  channel?: SentChannel;
  text?: string | RegExp;
  purpose?: string;
  sendAfter?: Date | null;
}

const show = (t: string) => JSON.stringify(t.length > 80 ? `${t.slice(0, 77)}...` : t);

/**
 * Exactly `expected`, in order. Returns the problems, one line each; empty
 * means it matched. Order is the order the rows were queued.
 */
export function matchSent(actual: readonly SentMessage[], expected: readonly ExpectedMessage[]): string[] {
  const problems: string[] = [];
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    const at = `#${i + 1}`;
    if (!a) {
      problems.push(`${at} expected a message to ${e.to}, nothing was sent`);
      continue;
    }
    if (!e) {
      problems.push(`${at} unexpected ${a.channel} to ${a.to}: ${show(a.text)}`);
      continue;
    }
    if (a.to !== e.to) {
      problems.push(`${at} sent to ${a.to}, expected ${e.to}`);
      continue;
    }
    if (e.channel && a.channel !== e.channel) problems.push(`${at} to ${a.to}: channel ${a.channel}, expected ${e.channel}`);
    if (e.purpose !== undefined && a.purpose !== e.purpose) problems.push(`${at} to ${a.to}: purpose ${JSON.stringify(a.purpose)}, expected ${JSON.stringify(e.purpose)}`);
    if (typeof e.text === "string" && !a.text.includes(e.text)) problems.push(`${at} to ${a.to}: text ${show(a.text)} does not contain ${JSON.stringify(e.text)}`);
    if (e.text instanceof RegExp && !e.text.test(a.text)) problems.push(`${at} to ${a.to}: text ${show(a.text)} does not match ${e.text}`);
    if (e.sendAfter !== undefined && (a.sendAfter?.getTime() ?? null) !== (e.sendAfter?.getTime() ?? null)) {
      problems.push(`${at} to ${a.to}: sendAfter ${a.sendAfter?.toISOString() ?? "none"}, expected ${e.sendAfter?.toISOString() ?? "none"}`);
    }
  }
  return problems;
}

export interface Leak {
  to: string;
  term: string;
  text: string;
}

/** Every message (to `opts.to` only, when given) that contains a forbidden term. */
export function findLeaks(sent: readonly SentMessage[], forbidden: readonly string[], opts: { to?: readonly string[] } = {}): Leak[] {
  const leaks: Leak[] = [];
  for (const m of sent) {
    if (opts.to && !opts.to.includes(m.to)) continue;
    const hay = m.text.toLowerCase();
    for (const term of forbidden) if (term.trim() && hay.includes(term.toLowerCase())) leaks.push({ to: m.to, term, text: m.text });
  }
  return leaks;
}

/** The ways a UK mobile is written, for leak checks: E.164, digits, 07..., 07... with a space, and bare. */
export function phoneVariants(phone: string): string[] {
  const d = digits(phone);
  if (!d) return [];
  const national = d.startsWith("44") ? `0${d.slice(2)}` : d;
  return [`+${d}`, d, national, `${national.slice(0, 5)} ${national.slice(5)}`, national.slice(1)];
}

/** One line of a scenario's transcript. */
export type TranscriptEvent =
  | { kind: "in"; from: string; channel: "dm" | "group" | "hq"; text: string }
  | { kind: "out"; message: SentMessage }
  | { kind: "note"; text: string };

/** The conversation as a person would read it; attached to every failed scenario. */
export function renderTranscript(events: readonly TranscriptEvent[]): string {
  return events
    .map((e) => {
      if (e.kind === "in") return `${e.from} -> MatchTime (${e.channel}): ${e.text}`;
      if (e.kind === "note") return `   ${e.text}`;
      const m = e.message;
      const tags = [m.channel, m.purpose, m.sendAfter ? `after ${m.sendAfter.toISOString()}` : null].filter(Boolean).join(", ");
      return `MatchTime -> ${m.to} (${tags}): ${m.text}`;
    })
    .join("\n");
}
