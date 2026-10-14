/**
 * THE REHEARSAL'S CLOCK DRIVER. Pure: no I/O.
 *
 * Turns a scenario into one ordered list of ticks, each at a simulated
 * instant, that the runner plays in order (moving the server's clock to
 * each tick's instant first, see clock-shim.cjs):
 *
 *   cron   a Vercel cron firing on its schedule (vercel.json, UTC)
 *   step   a scenario step (a message, a DM, a setup action, ...)
 *   flush  the Pi sending its buffered players'-group messages to
 *          /api/whatsapp/analyze in one batch
 *   poll   the Pi polling /api/whatsapp/due-posts
 *
 * HOW CLOSE TO THE REAL PI. The Pi buffers every players'-group message
 * and flushes on a ten-minute timer, at once when kickoff is less than an
 * hour away (whatsapp-bot/src/smart-analysis.ts). Admin-group messages are
 * forwarded at once (admin-group.ts). It polls due posts every minute; the
 * rehearsal polls every `pollEveryMinutes`, plus one minute after every
 * step or flush, which is when anything that step queued would go out.
 * Scheduled posts are due from their time onwards, so a coarser poll only
 * delays them to the next poll; it does not lose them.
 */
import { localToUtc, type Scenario, type Step } from "./scenario";

const MIN = 60_000;

// ── Cron ──────────────────────────────────────────────────────────────

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
}

function field(text: string, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (part === "*") for (let i = 0; i < max; i++) out.add(i);
    else if (/^\*\/\d+$/.test(part)) {
      const step = Number(part.slice(2));
      if (step <= 0) throw new Error(`cron: bad step in ${name} "${text}"`);
      for (let i = 0; i < max; i += step) out.add(i);
    } else if (/^\d+$/.test(part) && Number(part) < max) out.add(Number(part));
    else throw new Error(`cron: cannot read ${name} "${text}"`);
  }
  return new Set([...out].sort((a, b) => a - b));
}

/** Minute and hour fields only; the three day fields must be "*". */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron: expected 5 fields, got "${expr}"`);
  if (parts.slice(2).some((p) => p !== "*"))
    throw new Error(`cron: day fields are not supported ("${expr}"); the rehearsal fires these daily or more often only`);
  return { minutes: field(parts[0], 60, "minute"), hours: field(parts[1], 24, "hour") };
}

/** Every firing of `expr` (UTC) in the half-open window (from, to]. */
export function cronFiresBetween(expr: string, from: Date, to: Date): Date[] {
  const spec = parseCron(expr);
  const out: Date[] = [];
  let t = Math.floor(from.getTime() / MIN) * MIN + MIN;
  for (; t <= to.getTime(); t += MIN) {
    const d = new Date(t);
    if (spec.minutes.has(d.getUTCMinutes()) && spec.hours.has(d.getUTCHours())) out.push(d);
  }
  return out;
}

// ── Kickoffs and the Pi's batches ─────────────────────────────────────

/** Each weekly kickoff in [from, to), in the club's zone. */
export function kickoffsBetween(
  activity: { dayOfWeek: number; time: string },
  timeZone: string,
  from: Date,
  to: Date,
): Date[] {
  const out: Date[] = [];
  // Walk calendar days in UTC; a day's local date is close enough to pick
  // the weekday, and localToUtc settles the exact instant.
  for (let t = from.getTime() - 86_400_000; t <= to.getTime() + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    const ymd = d.toISOString().slice(0, 10);
    const local = localToUtc(`${ymd} ${activity.time}`, timeZone);
    const weekday = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    if (weekday !== activity.dayOfWeek) continue;
    if (local >= from && local < to && !out.some((k) => k.getTime() === local.getTime())) out.push(local);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

const URGENCY_MS = 60 * MIN;

/** When the Pi would send a players'-group message written at `at`. */
export function flushTimeFor(at: Date, windowMinutes: number, kickoffs: Date[]): Date {
  const t = at.getTime();
  if (kickoffs.some((k) => k.getTime() > t && k.getTime() - t < URGENCY_MS)) return new Date(t);
  const w = windowMinutes * MIN;
  return new Date(Math.floor(t / w) * w + w);
}

// ── The plan ──────────────────────────────────────────────────────────

export type Tick =
  | { at: Date; kind: "cron"; path: string }
  | { at: Date; kind: "step"; step: Step }
  | { at: Date; kind: "flush"; stepSeqs: number[] }
  | { at: Date; kind: "poll" };

const ORDER: Record<Tick["kind"], number> = { cron: 0, step: 1, flush: 2, poll: 3 };

export function planTimeline(
  scenario: Scenario,
  vercelCrons: Array<{ path: string; schedule: string }> = [],
): Tick[] {
  const ticks: Tick[] = [];
  const { start, end } = scenario;
  const players = scenario.groups.find((g) => g.role === "players")!.key;
  const kickoffs = kickoffsBetween(scenario.club.activity, scenario.timezone, start, new Date(end.getTime() + 7 * 86_400_000));

  const crons = (scenario.crons === "vercel" ? vercelCrons : scenario.crons).filter(
    (c) => !scenario.skipCrons.includes(c.path),
  );
  for (const c of crons) {
    for (const at of cronFiresBetween(c.schedule, new Date(start.getTime() - 1), end)) ticks.push({ at, kind: "cron", path: c.path });
  }

  const pollAt = new Set<number>();
  // On the clock (17:00, 18:00, ...), not counted from an odd start time, so
  // a post due at 17:00 is not reported at 17:50.
  const every = scenario.pollEveryMinutes * MIN;
  for (let t = Math.ceil(start.getTime() / every) * every; t <= end.getTime(); t += every) pollAt.add(t);

  const flushes = new Map<number, number[]>();
  for (const step of scenario.steps) {
    ticks.push({ at: step.at, kind: "step", step });
    if (step.do === "message" && step.group === players) {
      const f = flushTimeFor(step.at, scenario.batchMinutes, kickoffs).getTime();
      flushes.set(f, [...(flushes.get(f) ?? []), step.seq]);
    } else if (step.do !== "note" && step.do !== "message") {
      pollAt.add(step.at.getTime() + MIN);
    } else if (step.do === "message") {
      const g = scenario.groups.find((x) => x.key === step.group);
      if (g?.role === "admin") pollAt.add(step.at.getTime() + MIN);
    }
  }
  for (const [t, seqs] of flushes) {
    ticks.push({ at: new Date(t), kind: "flush", stepSeqs: seqs });
    pollAt.add(t + MIN);
  }
  for (const t of pollAt) if (t <= end.getTime() + MIN) ticks.push({ at: new Date(t), kind: "poll" });

  return ticks.sort((a, b) => a.at.getTime() - b.at.getTime() || ORDER[a.kind] - ORDER[b.kind]);
}
