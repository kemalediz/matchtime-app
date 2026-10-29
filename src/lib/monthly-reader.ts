/**
 * THE MONTHLY READER (2026-10-29): one model call per group message, for a
 * club on "monthly" with a live month. It reads a pasted list (its lines,
 * blanks, parts such as "Paid but can't play", the notes beside names,
 * guests, the month or game it is for, whatever was typed around it) and a
 * typed sign-up ("November good for me"). The prompt, schema and checks
 * are in `monthly-reader-prompt.ts`; the code that acts on the answer is
 * `monthly-paste.ts` and `month-signup.ts`.
 *
 * One Haiku call (`HAIKU_CALL`, budget-guarded like every pipeline call).
 * FAIL SAFE: no key, a failed call, the daily cap or an unreadable answer
 * is `{ kind: "none" }` and the caller changes nothing for the month. It
 * never invents a player: a member is only ever a ref it was shown.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { formatLondon } from "./london-time";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./pipeline/llm";
import {
  buildMonthlyReaderUserTurn,
  MONTHLY_READER_SCHEMA,
  MONTHLY_READER_SYSTEM,
  parseMonthlyReading,
  type MonthlyReaderContext,
  type MonthlyReaderInput,
  type MonthlyReading,
  type ReaderMember,
} from "./monthly-reader-prompt";

export type { MonthlyReading, MonthlyReaderContext, MonthlyReaderInput } from "./monthly-reader-prompt";

/** Pinned. Exported for the dry run. */
export const MONTHLY_READER_CALL: ModelCall = HAIKU_CALL;
const LABEL = "monthly-reader";
/** A long list is about 30 lines of a dozen fields, with Haiku's thinking. */
const MAX_TOKENS = 4_096;

/**
 * The club's context for the reader, once per batch. Null when the club
 * has no live month (nothing for the reader to do) or it cannot be read.
 */
export async function loadMonthlyReaderContext(args: { orgId: string; matchId: string | null; now?: Date }): Promise<MonthlyReaderContext | null> {
  const now = args.now ?? new Date();
  const { loadLiveMonths, renderSignupList, footerFacts } = await import("./month-signup");
  const { loadMonthlyWeek, renderWeekList } = await import("./monthly-week");
  const months = await loadLiveMonths(args.orgId, now);
  const week = args.matchId ? await loadMonthlyWeek(args.matchId) : null;
  const liveWeek = week && week.orgId === args.orgId ? week : null;
  if (months.length === 0 && !liveWeek) return null;

  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({
      where: { orgId: args.orgId, leftAt: null, ...ORDINARY_MEMBER_WHERE, user: { isActive: true } },
      select: { role: true, user: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.userAlias.findMany({ where: { orgId: args.orgId }, select: { userId: true, alias: true } }),
  ]);
  const members: ReaderMember[] = memberships
    .filter((m) => m.user.name)
    .map((m, i) => ({
      ref: `p${i + 1}`,
      userId: m.user.id,
      name: m.user.name as string,
      aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias),
      organiser: m.role === "OWNER" || m.role === "ADMIN",
    }));

  const day = (d: Date) => formatLondon(d, "EEE d MMM");
  const monthBlocks = months.map((m) => {
    const label = formatLondon(m.kickoffs[0] ?? m.firstKickoff, "MMMM yyyy");
    const started = m.startedMidMonth || now.getTime() >= m.firstKickoff.getTime();
    const state = m.open ? "sign-up open" : started ? "under way" : "sign-up closed, not started yet";
    const games = m.kickoffs.map((k) => `${day(k)}${k.getTime() < now.getTime() ? " (played)" : ""}`);
    const left = m.kickoffs.filter((k) => k.getTime() > now.getTime()).length;
    return [
      `  ${label} (month ${m.monthNumber}): ${state}. ${m.kickoffs.length} games: ${games.join(", ")}; ${left} still to play.`,
      `  Its list as MatchTime has it:`,
      ...renderSignupList(m).text.split("\n").map((l) => `    ${l}`),
    ].join("\n");
  });

  const ctx: MonthlyReaderContext = {
    orgId: args.orgId,
    members,
    months: monthBlocks,
    week: liveWeek ? { game: formatLondon(liveWeek.matchDate, "EEE d MMM yyyy, HH:mm"), text: renderWeekList(liveWeek).text } : null,
  };
  // For the e2e stub's deterministic stand-in only; never shown to the model.
  stubFactsOf.set(ctx, {
    lang: liveWeek?.language ?? months[0]?.language ?? null,
    maxPlayers: liveWeek?.maxPlayers ?? 0,
    paygPricePence: liveWeek?.paygPricePence ?? null,
    signupFooters: months.filter((m) => m.kickoffs.length > 0).map((m) => footerFacts(m)),
  });
  return ctx;
}

/** What the e2e stub's stand-in needs to strip MatchTime's own lines. */
export interface ReaderStubFacts {
  lang: string | null;
  maxPlayers: number;
  paygPricePence: number | null;
  signupFooters: Array<ReturnType<Awaited<typeof import("./month-signup")>["footerFacts"]>>;
}
const stubFactsOf = new WeakMap<MonthlyReaderContext, ReaderStubFacts>();

// ── The e2e stub ──────────────────────────────────────────────────────

/**
 * TEST-ONLY seam, as the other model steps have: what the model would have
 * said, keyed by the message body, read from a file. A body with no entry
 * is read by the deterministic stand-in (`monthly-reader-legacy.ts`, the
 * reader this step replaced), so the existing monthly scenarios run
 * unchanged for free. `e2e/helpers/live-llm.ts` refuses a live run that
 * can still see the file.
 */
export const MONTHLY_READER_STUB_FILE_ENV = "MT_TEST_MONTHLY_READER_STUB_FILE";

interface ReaderStub {
  /** Trimmed body → the model's raw answer (the schema's object). */
  bodies?: Record<string, unknown>;
  /** Bodies whose call fails, the way an overloaded API does. */
  fail?: string[];
}

async function readFromStub(file: string, input: MonthlyReaderInput, ctx: MonthlyReaderContext): Promise<MonthlyReading> {
  let cfg: ReaderStub = {};
  try {
    cfg = JSON.parse(readFileSync(file, "utf8")) as ReaderStub;
  } catch {
    cfg = {};
  }
  const user = buildMonthlyReaderUserTurn(input, ctx);
  try {
    appendFileSync(`${file}.calls`, `${JSON.stringify({ label: LABEL, user })}\n`);
  } catch {
    // Recording is for the spec only.
  }
  const body = input.body.trim();
  if ((cfg.fail ?? []).includes(body)) throw new Error(`${LABEL} stub: forced failure`);
  const answer = cfg.bodies?.[body];
  if (answer !== undefined) return parseMonthlyReading(answer, input, ctx);
  const { legacyMonthlyReading } = await import("./monthly-reader-legacy");
  return legacyMonthlyReading(input, stubFactsOf.get(ctx) ?? null);
}

function defaultModel(): PipelineModel | null {
  return process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null;
}

/**
 * Read one group message, once. `deps.model` undefined uses the real model
 * (or the e2e stub), null asserts there is none. Never throws.
 */
export async function readMonthlyMessage(
  input: MonthlyReaderInput,
  ctx: MonthlyReaderContext,
  deps?: { model?: PipelineModel | null },
): Promise<MonthlyReading> {
  if (!input.body?.trim()) return { kind: "none", why: "empty" };
  let reading: MonthlyReading;
  try {
    const stubFile = deps?.model === undefined ? process.env[MONTHLY_READER_STUB_FILE_ENV] : undefined;
    if (stubFile) {
      reading = await readFromStub(stubFile, input, ctx);
    } else {
      const model = deps?.model === undefined ? defaultModel() : deps.model;
      if (!model) return { kind: "none", why: "reader unavailable" };
      const resp = await model.complete({
        ...MONTHLY_READER_CALL,
        system: MONTHLY_READER_SYSTEM,
        user: buildMonthlyReaderUserTurn(input, ctx),
        maxTokens: MAX_TOKENS,
        schema: MONTHLY_READER_SCHEMA as unknown as Record<string, unknown>,
        label: LABEL,
      });
      reading = parseMonthlyReading(extractJson(resp.text), input, ctx);
    }
  } catch (err) {
    // FAIL SAFE: nothing is read, so nothing changes for the month.
    console.error(`[${LABEL}] read failed:`, err instanceof Error ? err.message : "failed");
    return { kind: "none", why: "reader error" };
  }
  console.info(
    `[${LABEL}] org=${ctx.orgId} sender=${input.sender.userId ?? "?"} kind=${reading.kind}` +
      (reading.kind === "list"
        ? ` month=${reading.list.month?.month ?? "-"} game=${reading.gameDay ?? "-"} of=${reading.listOf} lines=${reading.list.slots.length}+${reading.list.sections.cantPlay.length}`
        : reading.kind === "signup"
          ? ` choice=${reading.choice} month=${reading.month} games=${reading.games ?? "-"}`
          : ` why=${reading.why}`),
  );
  return reading;
}
