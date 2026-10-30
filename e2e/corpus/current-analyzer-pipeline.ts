/**
 * Pipeline #1 — the shipped `/api/whatsapp/analyze` route, whatever is
 * behind it.
 *
 * Builds the case's world with the existing sim harness (`e2e/sim/
 * group.ts`), posts the messages through the REAL `/api/whatsapp/analyze`
 * route, and reads the world back out of the database.
 *
 * =====================================================================
 * THE CLASS NAME IS HISTORICAL. `stub` MODE IS NOT — IT WAS PORTED
 * =====================================================================
 *
 * "current-analyzer" meant the 19,850-token mega-prompt. §10 step 8
 * (2026-09-06) deleted it. The class is deliberately NOT renamed: its
 * name is in `baseline.stub.json`, in every report under `.e2e/corpus/`
 * and in every scoreboard anyone has quoted, and a rename would make
 * those unreadable for a change that alters nothing about what it does.
 * What it does is unchanged and always was the honest description —
 * post to the real route, read the database back.
 *
 * For two days (2026-09-06 → 2026-09-08) this adapter forwarded NOTHING
 * in `stub` mode: each case carried a `CorpusStubVerdict` and there was
 * nothing left that reads a verdict, so all 36 stubbed cases ran against
 * a server that routed nothing, owned nothing and said nothing. Measured
 * then: 10 of 36 "green", most of them expecting nothing to happen and
 * getting it for the wrong reason, and exactly ONE case in the whole
 * sweep — S26 — changed a single database row.
 *
 * WHAT IT FORWARDS NOW sits one layer either side of where the verdict
 * used to be, exactly as the rest of the suite does (`e2e/sim/group.ts`,
 * `e2e/helpers/stub.ts`): per message, what the ROUTER answered
 * (`route`) and what the EXTRACTOR found (`facts`). Both are properties
 * of the message text, checkable by re-reading it. Everything between
 * here and the database — capacity, the interaction contract,
 * authorisation, `tense`, `contingent`, the confidence floor,
 * the bench, the batch-final squad post — is the real shipped code
 * deciding for itself, so every ported case PINS a decision where it
 * used to ASSUME one.
 *
 * The eleven cases whose stub used to be `historical` — "the verdict the
 * model ACTUALLY emitted on the day" — had no successor, because there
 * was no router and no extractor on 2026-05-08 and inventing their
 * output would be `README.md`'s rule 1 in reverse. They were split by
 * asking one question per case: was the READING of the message ever in
 * doubt? Where it was not, the facts are a transcription and the case
 * stays in CI; where the reading itself WAS the incident, the case is
 * live-only, asserts the OUTCOME, and says so in its `liveOnlyReason`.
 * Which bucket each went in, and why, is written at the case.
 *
 * THE BORING CLAIM FIELDS ARE FILLED IN HERE, not in the JSONL. A case
 * states the fields it is about (`polarity`, `tense`, `personNamed`, …)
 * and `withFactDefaults` supplies the rest from the same defaults
 * `helpers/stub.ts:claim()` gives the other twenty-one spec files, so
 * the two can never drift into describing different messages. The
 * defaults are listed in `e2e/corpus/README.md` under "Case shape".
 *
 * LIVE mode is unaffected and always was — it never used the seam, and
 * the `stubbed` guard in `run()` is what keeps it that way.
 *
 * HISTORY IS MANDATORY. `group.ts` forwards the "Recent chat history"
 * block the Pi sends on every production call. PR #26 discovered the sim
 * was omitting it, which meant every live-LLM test written before it ran
 * against a prompt production never uses — Amir's bug reproduced only
 * 2/5 WITH history. Every case's `history` is forwarded on every turn,
 * and later turns also see the earlier turns and MatchTime's own replies.
 */
import { SimGroup, type SimHistoryEntry } from "../sim/group";
import { claim, facts, setHqSquadReaderStub, setPastedListStub } from "../helpers/stub";
import type { CorpusCase, CorpusFacts, CorpusMessage, CorpusObservation } from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";
// The world builder and the read-back helpers moved to ./world when the
// SECOND pipeline arrived (§10 step 2). Both pipelines must be judged
// against a world built by the same code, or a divergence in the builder
// would read as a divergence in the pipelines.
import { buildCorpusWorld, readMembers, readRows, readScore, readTeams } from "./world";

/**
 * Fill in the fields a case did not bother to state.
 *
 * ONLY the boring ones, and only from `helpers/stub.ts` — the same
 * defaults the other twenty-one ported spec files get, so a corpus case
 * and a spec that write the same claim cannot end up describing
 * different messages. A case states the fields it is ABOUT (`polarity`,
 * `tense`, `personNamed`, `contingent`, `subject`, `personRef`) and says
 * nothing about the rest.
 *
 * Attendance facts are the only kind with defaults to fill: `claims`,
 * `affirmation: "none"` and `sideRequests: []`. Question, teams, score
 * and admin facts are small enough to state in full and are passed
 * through untouched, so nothing is ever silently added to them.
 */
export function withFactDefaults(raw: CorpusFacts): CorpusFacts {
  if (!Array.isArray(raw.claims)) return raw;
  const { claims, ...rest } = raw;
  return facts(
    (claims as Array<Record<string, unknown>>).map((c) => claim(c)),
    rest,
  );
}

export class CurrentAnalyzerPipeline implements CorpusPipeline {
  readonly name: string = "current-analyzer";

  supports(c: CorpusCase, mode: CorpusMode): boolean {
    if (mode === "live") return true;
    // A stubbed run needs the case to say what the ROUTER answered, so a
    // case with no route on any message is live-only by design — and the
    // loader has already made it say why (`liveOnlyReason`), so a case
    // can never drop out of CI silently.
    return c.messages.some((m) => m.route !== undefined);
  }

  // `mode` decides whether the case's routes and facts are forwarded at
  // all. A LIVE run must reach the real router and the real extractors,
  // and `helpers/live-llm.ts` refuses a "live" run whose seam files are
  // armed — so this is the second half of a guarantee, not a preference.
  async run(ctx: PipelineContext, c: CorpusCase, mode: CorpusMode): Promise<CorpusObservation> {
    const stubbed = mode === "stub";
    const grp = await this.buildWorld(ctx, c);

    const attendanceBefore = await this.rows(grp);
    const memberNamesBefore = await this.members(grp);
    const teamsBefore = await this.teams(grp);

    const spoken: string[] = [];
    const dms: Array<{ to: string | null; text: string }> = [];
    const reacts: Array<string | null> = [];

    // Messages are grouped into turns; each turn is one analyze batch,
    // exactly as the Pi's buffer flushes.
    const turns = new Map<number, CorpusMessage[]>();
    for (const m of c.messages) {
      const t = m.turn ?? 0;
      if (!turns.has(t)) turns.set(t, []);
      turns.get(t)!.push(m);
    }

    const history: SimHistoryEntry[] = (c.history ?? []).map((h) => ({
      authorName: h.author,
      body: h.body,
    }));

    for (const turn of [...turns.keys()].sort((a, b) => a - b)) {
      const items = turns.get(turn)!;
      // STUBBED MODE ONLY: the router's pasted-list flag and the squad
      // reader's answer (2026-10-30). Reset every turn, so a case that
      // says nothing about lists reads none.
      if (stubbed) {
        setPastedListStub({ bodies: items.filter((m) => m.pastedList).map((m) => m.body.trim()) });
        setHqSquadReaderStub({
          bodies: Object.fromEntries(items.filter((m) => m.listReading).map((m) => [m.body.trim(), m.listReading])),
        });
      }
      const batch = await grp.postBatch(
        items.map((m) => ({
          ...(typeof m.from === "string" ? { player: m.from } : { author: m.from }),
          body: m.body,
          botMentioned: m.tag ?? false,
          // STUBBED MODE ONLY. A message with no `route` is left
          // unmapped, which `gate.ts` reads as `unsure` — an engine
          // route — and with no facts behind it nothing is written and
          // nothing is said. That is the direction that cannot invent a
          // write in a case which never asked for one.
          ...(stubbed && m.route ? { route: m.route } : {}),
          ...(stubbed && m.facts ? { facts: withFactDefaults(m.facts) } : {}),
        })),
        { history: [...history] },
      );

      for (const r of batch.results) {
        reacts.push(r.react ?? null);
        if (r.reply) spoken.push(r.reply);
      }
      spoken.push(...batch.groupPosts);
      dms.push(...batch.dms.map((d) => ({ to: d.phone, text: d.text })));

      // Carry this turn forward as history for the next one.
      for (const m of items) {
        history.push({
          authorName: typeof m.from === "string" ? grp.player(m.from).name : m.from.name,
          body: m.body,
        });
      }
      for (const r of batch.results) {
        if (r.reply) history.push({ authorName: "MatchTime", body: r.reply });
      }
      for (const post of batch.groupPosts) history.push({ authorName: "MatchTime", body: post });
    }

    return {
      attendanceBefore,
      attendanceAfter: await this.rows(grp),
      memberNamesBefore,
      memberNamesAfter: await this.members(grp),
      spoken,
      dms,
      reacts,
      benchOffersOpen: (await grp.openOffers()).length,
      teamsBefore,
      teamsAfter: await this.teams(grp),
      scoreAfter: await this.score(grp),
      notes: { orgId: grp.orgId, matchId: grp.matchId },
    };
  }

  private async buildWorld(ctx: PipelineContext, c: CorpusCase): Promise<SimGroup> {
    return buildCorpusWorld(ctx, c);
  }

  private rows = readRows;
  private members = readMembers;
  private teams = readTeams;
  private score = readScore;
}
