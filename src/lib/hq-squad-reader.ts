/**
 * THE HQ SQUAD READER (2026-10-29; every squad message since 2026-10-30):
 * one model call for a message a member of a live weekly club sends in its
 * admin group (HQ) that the shared router sent to the squad
 * (`admin-group-understand.ts`). It says whether the message is the squad
 * for the next game (with who plays and who is on the bench), a change to
 * it (who comes in, goes out or to the bench), something about the teams
 * (a copy of the team sheet, a swap, a move), or something else. A squad
 * list goes on to a proposal (`admin-group-paste.ts`), a change to the
 * shared attendance engine (`admin-group-squad-change.ts`), the teams to
 * the teams' handling; anything else changes nothing. The prompt, schema
 * and checks are in `hq-squad-reader-prompt.ts`; the fact gates in
 * `admin-group-squad-rules.ts`.
 *
 * One Haiku call (`HAIKU_CALL`, under the club's AI budget like every
 * pipeline call). FAIL SAFE: no key, a failed call, the cap or an
 * unreadable answer is "other", and the message goes on to the pipeline
 * as if this reader were not here. It never invents a player: a member is
 * only ever a ref it was shown.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { db } from "./db";
import { formatLondon } from "./london-time";
import { rosterLabels } from "./group-chat-history";
import { hqLogSince } from "./admin-group-log";
import { resolveTeamLabels } from "./team-labels";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./pipeline/llm";
import {
  buildHqSquadReaderUserTurn,
  HQ_SQUAD_READER_RECENT_LINES,
  HQ_SQUAD_READER_SCHEMA,
  HQ_SQUAD_READER_SYSTEM,
  parseHqSquadReading,
  type HqReaderMember,
  type HqSquadReaderContext,
  type HqSquadReaderInput,
  type HqSquadReading,
} from "./hq-squad-reader-prompt";

export type { HqSquadReading, HqSquadReaderContext, HqSquadReaderInput } from "./hq-squad-reader-prompt";

/** Pinned. Exported for the dry run. */
export const HQ_SQUAD_READER_CALL: ModelCall = HAIKU_CALL;
const LABEL = "hq-squad-reader";
/** A list of about 25 names, with Haiku's thinking. */
const MAX_TOKENS = 4_096;
/** How far back the recent HQ messages go. */
const RECENT_MS = 2 * 60 * 60 * 1000;

/**
 * The club's context for one message: its members by ref, the next game's
 * squad and its team sheet (`matchId` null: the club has no game yet).
 */
export async function loadHqSquadReaderContext(args: {
  orgId: string;
  match: { id: string; date: Date; maxPlayers: number; activityId?: string | null; teamLabels?: string[] | null } | null;
  lang: string | null | undefined;
}): Promise<HqSquadReaderContext> {
  const { orgId, match } = args;
  const [memberships, aliases, attendance, slots, proposal] = await Promise.all([
    db.membership.findMany({ where: { orgId, leftAt: null }, select: { user: { select: { id: true, name: true } } } }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
    match ? db.attendance.findMany({ where: { matchId: match.id }, select: { userId: true, status: true }, orderBy: { position: "asc" } }) : Promise.resolve([]),
    match ? db.teamAssignment.findMany({ where: { matchId: match.id }, orderBy: { id: "asc" }, select: { userId: true, team: true } }) : Promise.resolve([]),
    match ? db.adminTeamProposal.findUnique({ where: { matchId: match.id }, select: { state: true } }) : Promise.resolve(null),
  ]);
  const seen = new Set<string>();
  const members: HqReaderMember[] = [];
  for (const m of memberships ?? []) {
    if (!m.user.name || seen.has(m.user.id)) continue;
    seen.add(m.user.id);
    members.push({
      ref: `p${members.length + 1}`,
      userId: m.user.id,
      name: m.user.name,
      aliases: (aliases ?? []).filter((a) => a.userId === m.user.id).map((a) => a.alias),
    });
  }
  const rows = attendance ?? [];
  const squad = {
    playing: rows.filter((r) => r.status === "CONFIRMED").map((r) => r.userId),
    bench: rows.filter((r) => r.status === "BENCH").map((r) => r.userId),
  };
  let teams: HqSquadReaderContext["teams"] = null;
  if (match && (slots ?? []).length > 0) {
    const labels = await teamLabelsOf(match, orgId, args.lang);
    teams = {
      state: proposal?.state === "approved" ? "final" : "proposed",
      sides: [
        { label: labels[0], userIds: slots.filter((s) => s.team === "RED").map((s) => s.userId) },
        { label: labels[1], userIds: slots.filter((s) => s.team === "YELLOW").map((s) => s.userId) },
      ],
    };
  }
  return {
    orgId,
    game: match ? { label: formatLondon(match.date, "EEE d MMM, HH:mm"), places: match.maxPlayers } : null,
    members,
    squad,
    teams,
  };
}

async function teamLabelsOf(
  match: { activityId?: string | null; teamLabels?: string[] | null },
  orgId: string,
  lang: string | null | undefined,
): Promise<[string, string]> {
  try {
    const activity = match.activityId ? await db.activity.findUnique({ where: { id: match.activityId }, select: { sportId: true } }) : null;
    const [org, sport] = await Promise.all([
      db.organisation.findUnique({ where: { id: orgId } }),
      activity ? db.sport.findUnique({ where: { id: activity.sportId } }) : Promise.resolve(null),
    ]);
    return resolveTeamLabels(match as never, org as never, sport as never, lang);
  } catch {
    return ["Team 1", "Team 2"];
  }
}

/** The recent HQ messages, MatchTime's own as "MatchTime", a member's
 *  under his roster name (never a pushname), oldest first. */
export async function loadHqRecentMessages(orgId: string, messageId: string, now: Date): Promise<HqSquadReaderInput["history"]> {
  const rows = (await hqLogSince(orgId, new Date(now.getTime() - RECENT_MS)).catch(() => [])) ?? [];
  const recent = rows.filter((r) => r.waMessageId !== messageId).slice(-HQ_SQUAD_READER_RECENT_LINES);
  const names = await rosterLabels(recent.filter((r) => !r.fromMatchTime).map((r) => r.senderUserId)).catch(() => new Map<string, string | null>());
  return recent.map((r) => ({
    author: r.fromMatchTime ? "MatchTime" : r.senderUserId ? (names.get(r.senderUserId) ?? null) : null,
    body: r.text,
  }));
}

// ── The e2e stub ──────────────────────────────────────────────────────

/**
 * TEST-ONLY seam, as the other model steps have: what the model would have
 * said, read from a file the e2e suite writes, by the trimmed message body.
 * A body with no answer is "other". In a stub answer, `member` and `out`
 * may name a member by name as well as by ref (a spec cannot know the refs
 * the server gives): the stub turns those names into refs, exactly, before
 * the production check reads the answer. `e2e/helpers/live-llm.ts` refuses
 * a live run that can still see the file.
 */
export const HQ_SQUAD_READER_STUB_FILE_ENV = "MT_TEST_HQ_SQUAD_READER_STUB_FILE";

interface ReaderStub {
  bodies?: Record<string, unknown>;
  fail?: string[];
}

function refsByName(answer: unknown, ctx: HqSquadReaderContext): unknown {
  if (!answer || typeof answer !== "object") return answer;
  const refOf = (v: unknown) => {
    if (typeof v !== "string" || !v) return v;
    if (ctx.members.some((m) => m.ref === v)) return v;
    return ctx.members.find((m) => m.name === v)?.ref ?? v;
  };
  const o = answer as Record<string, unknown>;
  return {
    ...o,
    lines: Array.isArray(o.lines) ? o.lines.map((l) => (l && typeof l === "object" ? { ...l, member: refOf((l as Record<string, unknown>).member) } : l)) : o.lines,
    out: Array.isArray(o.out) ? o.out.map(refOf) : o.out,
    changes: Array.isArray(o.changes)
      ? o.changes.map((c) => {
          if (!c || typeof c !== "object") return c;
          const x = c as Record<string, unknown>;
          return { ...x, member: refOf(x.member), replaces: refOf(x.replaces) };
        })
      : o.changes,
  };
}

async function readFromStub(file: string, input: HqSquadReaderInput, ctx: HqSquadReaderContext): Promise<HqSquadReading> {
  let cfg: ReaderStub = {};
  try {
    cfg = JSON.parse(readFileSync(file, "utf8")) as ReaderStub;
  } catch {
    cfg = {};
  }
  try {
    appendFileSync(`${file}.calls`, `${JSON.stringify({ label: LABEL, user: buildHqSquadReaderUserTurn(input, ctx) })}\n`);
  } catch {
    // Recording is for the spec only.
  }
  const body = input.body.trim();
  if ((cfg.fail ?? []).includes(body)) throw new Error(`${LABEL} stub: forced failure`);
  const answer = cfg.bodies?.[body];
  return answer === undefined ? { kind: "other", why: "stub: no answer" } : parseHqSquadReading(refsByName(answer, ctx), input, ctx);
}

function defaultModel(): PipelineModel | null {
  return process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null;
}

/**
 * Read one HQ message, once. `deps.model` undefined uses the real model
 * (or the e2e stub), null asserts there is none. Never throws.
 */
export async function readHqSquadMessage(
  input: HqSquadReaderInput,
  ctx: HqSquadReaderContext,
  deps?: { model?: PipelineModel | null },
): Promise<HqSquadReading> {
  if (!input.body?.trim()) return { kind: "other", why: "empty" };
  // COST GATE, on a fact: somebody who is nobody of the club cannot change
  // who plays (`admin-group.ts` checks it too).
  if (!input.sender.userId) return { kind: "other", why: "sender not a club member" };
  let reading: HqSquadReading;
  try {
    const stubFile = deps?.model === undefined ? process.env[HQ_SQUAD_READER_STUB_FILE_ENV] : undefined;
    if (stubFile) {
      reading = await readFromStub(stubFile, input, ctx);
    } else {
      const model = deps?.model === undefined ? defaultModel() : deps.model;
      if (!model) return { kind: "other", why: "reader unavailable" };
      const resp = await model.complete({
        ...HQ_SQUAD_READER_CALL,
        system: HQ_SQUAD_READER_SYSTEM,
        user: buildHqSquadReaderUserTurn(input, ctx),
        maxTokens: MAX_TOKENS,
        schema: HQ_SQUAD_READER_SCHEMA as unknown as Record<string, unknown>,
        label: LABEL,
      });
      reading = parseHqSquadReading(extractJson(resp.text), input, ctx);
    }
  } catch (err) {
    // FAIL SAFE: nothing is read, so nothing is proposed.
    console.error(`[${LABEL}] read failed:`, err instanceof Error ? err.message : "failed");
    return { kind: "other", why: "reader error" };
  }
  console.info(
    `[${LABEL}] org=${ctx.orgId} sender=${input.sender.userId} kind=${reading.kind}` +
      (reading.kind === "squad"
        ? ` lines=${reading.lines.length} members=${reading.lines.filter((l) => l.userId).length} out=${reading.out.length}`
        : reading.kind === "change"
          ? ` changes=${reading.changes.length} members=${reading.changes.filter((c) => c.userId).length}${reading.alsoAsks ? " also-asks" : ""}`
          : reading.kind === "other"
            ? ` why=${reading.why}`
            : ""),
  );
  return reading;
}
