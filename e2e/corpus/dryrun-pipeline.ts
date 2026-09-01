/**
 * Pipeline #2 — router → extractors → engine → composer, IN DRY RUN.
 *
 * §10 step 2. The same 46 cases that judge the shipped analyzer judge
 * this one, through the same adapter, against a world built by the same
 * builder. That is the whole point of `pipeline.ts` deliberately
 * containing no `AnalysisVerdict`, no intents and no `reasoning`.
 *
 * ZERO WRITES. This pipeline never calls `/api/whatsapp/analyze`, never
 * touches `registerAttendance`, and issues no INSERT or UPDATE of its
 * own. It READS the world the harness built, decides what it WOULD do,
 * and projects that forward in memory. `attendanceAfter` is therefore
 * the engine's PROPOSAL, not a database read.
 *
 * That is a real difference from pipeline #1 and it must be stated
 * plainly, because it is the one place this comparison is not
 * apples-to-apples:
 *
 *   • What it grades honestly: every decision. Which write, for whom,
 *     with what status, and whether the bot speaks. That is what §10
 *     step 3's criteria are about ("zero cases where the new pipeline
 *     would write and the old correctly did not; ≤2% where it would
 *     miss a write the old one correctly made").
 *   • What it does NOT exercise: the apply path itself —
 *     `registerAttendance`'s transaction, position ordering, the
 *     BenchSlotOffer auto-resolve queries. Those are shared code that
 *     step 6 would reuse unchanged, and they have their own tests. The
 *     engine's capacity rule is a faithful reimplementation of
 *     `attendance.ts:180-197` and is unit tested against it, but it IS a
 *     reimplementation, and a divergence there would not show up here.
 *
 * LIVE ONLY, deliberately. A stubbed run of this pipeline would need
 * hand-written FACTS, and the facts are exactly what the model produces:
 * writing them myself would be grading my own answer key, which is the
 * trap `e2e/corpus/README.md` warns about under "Do not 'record' stubs
 * from a live run". The engine's deterministic coverage comes from 153
 * unit tests in `src/lib/pipeline/__tests__` instead.
 */
import { anthropicModel } from "@/lib/pipeline/llm";
import { runPipeline, type PipelineMessage } from "@/lib/pipeline/run";
import { selectRegistrationMatch } from "@/lib/registration-match-select";
import { totalPlayersFor } from "@/lib/format-switch";
import type { SquadState } from "@/lib/pipeline/types";
import type { SimGroup } from "../sim/group";
import type { AttStatus, CorpusCase, CorpusMessage, CorpusObservation } from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";
import { buildCorpusWorld, readMembers, readRows, readTeams } from "./world";

export class DryRunPipeline implements CorpusPipeline {
  readonly name = "pipeline-dryrun";

  supports(_c: CorpusCase, mode: CorpusMode): boolean {
    // See the header: a stubbed run would mean hand-writing the facts.
    return mode === "live";
  }

  async run(ctx: PipelineContext, c: CorpusCase): Promise<CorpusObservation> {
    const grp = await buildCorpusWorld(ctx, c);

    const attendanceBefore = await readRows(grp);
    const memberNamesBefore = await readMembers(grp);
    const teamsBefore = await readTeams(grp);

    let state = await loadStateViaSql(grp);
    const now = new Date();

    const spoken: string[] = [];
    const reacts: Array<string | null> = [];
    const notes: Record<string, unknown> = {
      orgId: grp.orgId,
      matchId: grp.matchId,
      routes: [] as unknown[],
      // §11.2: "log the route alongside the extracted facts, so triage
      // is one query". Two-stage disagreement is a new failure mode and
      // this is the thing that makes it debuggable.
      facts: [] as unknown[],
      reasons: [] as unknown[],
      degradations: [] as string[],
      costUsd: 0,
      ms: 0,
    };

    const turns = new Map<number, CorpusMessage[]>();
    for (const m of c.messages) {
      const t = m.turn ?? 0;
      if (!turns.has(t)) turns.set(t, []);
      turns.get(t)!.push(m);
    }

    const history: Array<{ author: string | null; body: string }> = (c.history ?? []).map((h) => ({
      author: h.author,
      body: h.body,
    }));

    const model = anthropicModel();

    for (const turn of [...turns.keys()].sort((a, b) => a - b)) {
      const items = turns.get(turn)!;

      const lastBot =
        [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ??
        null;

      const messages: PipelineMessage[] = items.map((m, i) => {
        const roster = typeof m.from === "string" ? grp.player(m.from) : null;
        return {
          id: `corpus-${turn}-${i}`,
          body: m.body,
          authorName: roster ? roster.name : (m.from as { name: string | null }).name,
          senderUserId: roster ? roster.userId : null,
          senderName: roster ? roster.name : (m.from as { name: string | null }).name,
          tagged: m.tag ?? false,
        };
      });

      const result = await runPipeline({
        messages,
        history: [...history],
        state: { ...state, lastBotPost: lastBot },
        now,
        models: { router: model, extractor: model },
      });

      // The PROPOSAL becomes the world the next turn decides against —
      // the same thing a real write would do, minus the write.
      state = result.engine.nextState;

      const reactById = new Map(result.composed.reacts.map((r) => [r.messageId, r.emoji]));
      for (const m of messages) reacts.push(reactById.get(m.id) ?? null);
      for (const u of result.composed.utterances) spoken.push(u.text);

      (notes.routes as unknown[]).push(
        ...result.routes.map((r) => ({ id: r.messageId, route: r.route, source: r.source })),
      );
      (notes.facts as unknown[]).push(...result.facts.map((f) => ({ id: f.messageId, facts: f.facts })));
      (notes.reasons as unknown[]).push(
        ...result.engine.outcomes.map((o) => ({
          id: o.messageId,
          disposition: o.disposition,
          reasons: o.reasons,
        })),
      );
      (notes.degradations as string[]).push(...result.degradations.map((d) => `${d.stage}: ${d.detail}`));
      notes.costUsd = (notes.costUsd as number) + result.cost.totalUsd;
      notes.ms = (notes.ms as number) + result.ms;
      notes.cost = result.cost;

      for (const m of items) {
        history.push({
          author: typeof m.from === "string" ? grp.player(m.from).name : m.from.name,
          body: m.body,
        });
      }
      for (const u of result.composed.utterances) {
        history.push({ author: "MatchTime", body: u.text });
      }
    }

    const nameById = new Map(state.roster.map((m) => [m.userId, m.name]));
    const attendanceAfter = [...state.rows]
      .sort((a, b) => a.position - b.position)
      .map((r) => ({
        name: nameById.get(r.userId) ?? "(unnamed)",
        status: r.status as AttStatus,
      }));

    return {
      attendanceBefore,
      attendanceAfter,
      memberNamesBefore,
      memberNamesAfter: state.roster.map((m) => m.name).sort((a, b) => a.localeCompare(b)),
      spoken,
      // The dry run proposes no DMs: nothing here can send one.
      dms: [],
      reacts,
      benchOffersOpen: state.openOffers.length,
      teamsBefore,
      teamsAfter: state.teams.map((t) => ({
        name: nameById.get(t.userId) ?? "(unnamed)",
        team: t.team,
      })),
      scoreAfter: state.completedMatch
        ? { red: state.completedMatch.redScore, yellow: state.completedMatch.yellowScore }
        : undefined,
      notes,
    };
  }
}

/**
 * `SquadState` out of the e2e database, in plain SQL.
 *
 * The server's loader is `src/lib/pipeline/load-state.ts` (Prisma). This
 * is a second implementation ON PURPOSE: `e2e/sim/group.ts` is explicit
 * that the Playwright process uses plain SQL and never Prisma. The two
 * must agree, so both derive the ACTIVE MATCH from the same pure module
 * (`selectRegistrationMatch`) and both compute format capacity through
 * `totalPlayersFor` — the two places a divergence would actually change
 * a decision. Everything else here is a column read.
 */
async function loadStateViaSql(grp: SimGroup): Promise<SquadState> {
  const now = new Date();

  const matches = await grp.db.all<{
    id: string;
    date: Date;
    status: string;
    maxPlayers: number;
    venue: string;
    teamLabels: string[] | null;
    sportLabels: string[] | null;
  }>(
    `SELECT m.id, m.date, m.status, m."maxPlayers", a.venue,
            m."teamLabels" AS "teamLabels", s."teamLabels" AS "sportLabels"
       FROM "Match" m
       JOIN "Activity" a ON a.id = m."activityId"
       JOIN "Sport" s ON s.id = a."sportId"
      WHERE a."orgId" = $1 AND m.date >= $2
      ORDER BY m.date ASC`,
    // The SAME 30-day window the server's loader uses. Without it the
    // two loaders can disagree about `selectRegistrationMatch`'s
    // "previous match still in flight" guard, which decides whether a
    // write lands at all — the one place a divergence between them would
    // change a decision rather than a display.
    [grp.orgId, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)],
  );

  const active = selectRegistrationMatch(
    matches.map((m) => ({ id: m.id, date: new Date(m.date), status: m.status })),
    now,
  );
  const match = active ? matches.find((m) => m.id === active.id)! : null;

  const org = await grp.db.one<{
    teamLabels: string[] | null;
    featureAttendance: boolean;
    paymentTrackingEnabled: boolean;
    featureStatsQa: boolean;
  }>(
    `SELECT "teamLabels", "featureAttendance", "paymentTrackingEnabled", "featureStatsQa"
       FROM "Organisation" WHERE id = $1`,
    [grp.orgId],
  );

  const members = await grp.db.all<{
    userId: string;
    name: string | null;
    role: string;
    phoneNumber: string | null;
  }>(
    `SELECT u.id AS "userId", u.name, m.role, u."phoneNumber"
       FROM "Membership" m JOIN "User" u ON u.id = m."userId"
      WHERE m."orgId" = $1 AND m."leftAt" IS NULL
      ORDER BY u.name ASC`,
    [grp.orgId],
  );

  const rows = match
    ? await grp.db.all<{ userId: string; status: AttStatus; position: number }>(
        `SELECT "userId", status, position FROM "Attendance"
          WHERE "matchId" = $1 ORDER BY position ASC`,
        [match.id],
      )
    : [];

  const benchIds = rows.filter((r) => r.status === "BENCH").map((r) => r.userId);

  const offers = match
    ? await grp.db.all<{ id: string; replacingUserId: string | null }>(
        `SELECT id, "replacingUserId" FROM "BenchSlotOffer"
          WHERE "matchId" = $1 AND "resolvedAt" IS NULL`,
        [match.id],
      )
    : [];

  const teams = match
    ? await grp.db.all<{ userId: string; team: "RED" | "YELLOW" }>(
        `SELECT "userId", team FROM "TeamAssignment" WHERE "matchId" = $1`,
        [match.id],
      )
    : [];

  const completed = await grp.db.all<{
    id: string;
    redScore: number | null;
    yellowScore: number | null;
  }>(
    `SELECT m.id, m."redScore", m."yellowScore"
       FROM "Match" m JOIN "Activity" a ON a.id = m."activityId"
      WHERE a."orgId" = $1 AND m.status = 'COMPLETED'
      ORDER BY m.date DESC LIMIT 1`,
    [grp.orgId],
  );

  const participants = completed[0]
    ? await grp.db.all<{ userId: string }>(
        `SELECT "userId" FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`,
        [completed[0].id],
      )
    : [];

  const appearances = await grp.db.all<{ userId: string; matches: string }>(
    `SELECT att."userId", COUNT(*) AS matches
       FROM "Attendance" att
       JOIN "Match" m ON m.id = att."matchId"
       JOIN "Activity" a ON a.id = m."activityId"
      WHERE a."orgId" = $1 AND m.status = 'COMPLETED' AND att.status = 'CONFIRMED'
      GROUP BY att."userId"`,
    [grp.orgId],
  );

  const formats = await grp.db.all<{ name: string; playersPerTeam: number }>(
    `SELECT s.name, s."playersPerTeam"
       FROM "Activity" a JOIN "Sport" s ON s.id = a."sportId"
      WHERE a."orgId" = $1 AND a."isActive" = true`,
    [grp.orgId],
  );

  const currentTotal = match?.maxPlayers ?? 0;
  const labels = pickLabels(match?.teamLabels ?? null, org?.teamLabels ?? null, match?.sportLabels ?? null);

  return {
    matchId: match?.id ?? null,
    maxPlayers: currentTotal,
    kickoffLabel: match ? formatKickoff(new Date(match.date)) : "the next match",
    venue: match?.venue ?? "",
    rows: rows.map((r) => ({ userId: r.userId, status: r.status, position: r.position })),
    roster: members.map((m) => ({
      userId: m.userId,
      name: m.name ?? "",
      isAdmin: m.role === "OWNER" || m.role === "ADMIN",
      hasPhone: !!m.phoneNumber,
    })),
    openOffers: offers.map((o) => ({
      id: o.id,
      replacingUserId: o.replacingUserId,
      offeredToUserIds: benchIds,
    })),
    teams,
    teamLabels: labels,
    completedMatch: completed[0]
      ? {
          id: completed[0].id,
          redScore: completed[0].redScore,
          yellowScore: completed[0].yellowScore,
          participantUserIds: participants.map((p) => p.userId),
        }
      : null,
    appearances: appearances.map((a) => ({ userId: a.userId, matches: Number(a.matches) })),
    lastBotPost: null,
    features: {
      attendance: org?.featureAttendance ?? true,
      paymentTracking: org?.paymentTrackingEnabled ?? false,
      statsQa: org?.featureStatsQa ?? true,
    },
    smallerFormats: formats
      .map((f) => ({ sportName: f.name, totalPlayers: totalPlayersFor(f.playersPerTeam) }))
      .filter((f) => f.totalPlayers > 0 && f.totalPlayers < currentTotal),
    guestAskedUserIds: [],
  };
}

function pickLabels(
  matchLabels: string[] | null,
  orgLabels: string[] | null,
  sportLabels: string[] | null,
): [string, string] {
  for (const set of [matchLabels, orgLabels, sportLabels]) {
    if (set && set.length === 2 && set[0] && set[1]) return [set[0], set[1]];
  }
  return ["Red", "Yellow"];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 21:30", London. The composer never formats a date itself. */
function formatKickoff(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday") || DAYS[d.getUTCDay()];
  return `${weekday} ${get("hour")}:${get("minute")}`;
}
