/**
 * ═══════════════════════════════════════════════════════════════════════
 * DRY RUN — the whole pipeline against LIVE production state.
 *
 *   router → extractors → engine → composer, over the real Sutton FC
 *   squad, with the real model. It decides, projects and composes; it
 *   writes NOTHING.
 *
 * ── ZERO WRITES, structurally ────────────────────────────────────────
 * Not a promise, a property. The database calls in this file are
 * `loadSquadState`, whose module header says it is "THE ONLY I/O IN THIS
 * DIRECTORY … READ-ONLY BY CONSTRUCTION: every statement here is a
 * `findMany` / `findFirst` / `count`"; `getOrgFeatures`; and (in
 * `TEAMS=1` only) the shipped team-match selector, a single
 * `db.match.findFirst`. `runPipeline` is dry-run by design — "nothing in
 * this module writes to the database, sends a message, queues a
 * notification or touches the live analyze route. It returns a PROPOSAL
 * and a PROJECTION". Everything printed under `writes :` below is what
 * the engine WOULD do, on a projected state that lives in memory and is
 * thrown away when the process exits.
 *
 * ⚠️ `TEAMS=1` IS THE ONE MODE WHOSE REAL OWNER CAN WRITE. `runTeamOpsBatch`
 * ends in `applyGenerateTeams`, which force-confirms attendance rows and
 * rewrites every `TeamAssignment` on the match. It is safe here because
 * that apply layer's ENTIRE I/O surface is three injected functions and
 * this file replaces the two writing ones with recorders. The argument
 * is spelled out in full at `runTeams` — read it before touching that
 * mode, and never hand it `buildTeamOpsApplyDeps(...)` wholesale.
 *
 * No code path in this file calls `create`, `update`, `upsert` or
 * `delete`. Keep it that way: this script is pointed at a customer's
 * live squad days before a real match.
 *
 * ── IT COSTS REAL MONEY ──────────────────────────────────────────────
 * Every run is real router + extractor calls billed to the live
 * ANTHROPIC_API_KEY. One case is roughly $0.003–$0.01. `REPEAT=15` over
 * the whole table is a few dollars. The per-run cost is printed, and so
 * is the total.
 *
 * ── HOW TO RUN ───────────────────────────────────────────────────────
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-pipeline.ts
 *
 *   # or, if your shell exports the env for you:
 *   set -a; source .env; set +a
 *   npx tsx scripts/dryrun-pipeline.ts
 *
 * Needs DATABASE_URL and ANTHROPIC_API_KEY.
 *
 *   ONLY=C1,K1     run only these case ids (comma-separated)
 *   REPEAT=15      run each case N times and report DECISION stability
 *                  (writes + whether the group heard anything — this is
 *                  the acceptance signal and the UNSTABLE count) beside
 *                  the ROUTE spread (diagnostics: an LLM route is a
 *                  distribution, not a value). Three runs cannot settle
 *                  anything; 15 is the floor for a real question.
 *   FACTS=1        print basis / contingent / conditionOn on every run,
 *                  not just when REPEAT=1
 *   CHASES=1       compose all five scheduled-chase kinds instead of
 *                  running the case table (also read-only)
 *   QUESTIONS=1    run the TAGGED-QUESTION table (Q*) through §10 step
 *                  7's owner instead, and score every phrasing as
 *                  ANSWERED / HANDED BACK / SILENT. See `runQuestions`.
 *   TEAMS=1        run the GENERATE-TEAMS table (T*) through §10 step
 *                  8's owner (`runTeamOpsBatch`), with the apply layer's
 *                  three deps replaced by recorders. See `runTeams` —
 *                  read its header before touching it, it is the one
 *                  mode whose real owner has a write path.
 *   ORG_GROUP=…    a different WhatsApp group id (defaults to Sutton FC)
 *
 * Examples:
 *   ONLY=P1 REPEAT=15 FACTS=1 …   settle one ambiguous phrasing
 *   ONLY=K1,K2,K3 …               replay the 1 Sept incident three ways
 *   CHASES=1 …                    read the five scheduled posts
 *   TEAMS=1 …                     the seven real generate-teams phrasings
 *   TEAMS=1 ONLY=T2 REPEAT=10 …   settle whether a pairing is stable
 *
 * ── WHAT THE CASES ARE ───────────────────────────────────────────────
 * They are not synthetic. C1–C15 / D1–D3 / K1–K3 are real messages from
 * the group or real incidents; P1–P4 are the four probes that settle the
 * availability / standing-offer boundary. S1–S3 / A1–A5 / R1–R5 are §10
 * step 7 part 2's two writing routes — the score report, the payment
 * credit, the reminder and the recruit blast Kemal asked about on
 * 2026-09-06. X1–X3 and G1 are the two defects PR #55's port found and
 * marked `test.fail()`: a pasted roster swallowing its sender's drop,
 * and the guest-name-ask dedupe that had a reader and no writer.
 * Q1–Q24 (`QUESTIONS=1`) are tagged questions; T1–T7
 * (`TEAMS=1`) are the generate-teams phrasings measured over 120 days of
 * the live group, where `generate_teams_request` is the single most
 * common tagged command. Each carries an `expect`
 * string: what a human decided the right answer is. The harness does NOT
 * grade against it — it prints it next to what happened so you can. (The
 * graded, CI-runnable version of this idea is `e2e/corpus/`.)
 * ═══════════════════════════════════════════════════════════════════════
 */
import { peelClause } from "../src/lib/pipeline/clause-peel.ts";
import { parseSwapNames } from "../src/lib/team-slot-swap.ts";
import { looksLikeRatingProgressRequest } from "../src/lib/rating-progress.ts";
import { loadSquadState } from "../src/lib/pipeline/load-state.ts";
import { runPipeline } from "../src/lib/pipeline/run.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import { runTeamOpsBatch } from "../src/lib/team-ops-engine-batch.ts";
import { buildTeamOpsApplyDeps } from "../src/lib/owner-deps.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { anthropicModel } from "../src/lib/pipeline/llm.ts";
import { getOrgFeatures } from "../src/lib/org-features.ts";
import { composeChaseText, type ChaseKind } from "../src/lib/message-analyzer.ts";
import { db } from "../src/lib/db.ts";
import type { AttendanceRow, Member, Route, SquadState } from "../src/lib/pipeline/types.ts";

/** Sutton FC. Overridable so the harness is not welded to one customer. */
const DEFAULT_GROUP = "447525334985-1607872139@g.us";

type Case = {
  id: string;
  /** Sender, BY NAME. Resolved against the live roster at startup — no
   *  user id is hardcoded, so a roster change fails loudly here instead
   *  of silently attributing a message to the wrong person. */
  who: string;
  /** Display name on the message. Defaults to `who`. */
  as?: string;
  body: string;
  tagged?: boolean;
  /** The STRICTER tag signal (`messageMentionsBotExplicitly`), which the
   *  bulk-DM commands read instead of `tagged`. Defaults to `tagged`.
   *
   *  It has to be settable INDEPENDENTLY, and case B1 is why: the
   *  2026-09-10 near-miss sentence contains the bare word "Matchtime",
   *  so production's `messageTagsBot` calls it TAGGED while nobody
   *  @-mentioned the bot. A harness that could not express that
   *  combination could not replay the incident. */
  taggedExplicitly?: boolean;
  /** Fill the squad from the roster before running — for replaying an
   *  incident that only happens at 14/14. See `FULL_SQUAD_INCLUDES` /
   *  `FULL_SQUAD_BENCH` for who ends up where, and override per case. */
  fullSquad?: boolean;
  /** Who the fill must put IN the squad. Defaults to `FULL_SQUAD_INCLUDES`. */
  squadIncludes?: string[];
  /** Who the fill parks on the bench. Defaults to `FULL_SQUAD_BENCH`. */
  benched?: string;
  /** Force these roster members CONFIRMED on the CLONED state before the
   *  run. IN MEMORY ONLY — like every other knob here, it edits the
   *  structuredClone this iteration throws away, never the database.
   *
   *  It exists because a drop case can only test anything if its target
   *  is actually in the squad, and the live squad moves: Shahrokh was
   *  CONFIRMED when the 2026-09-07 incident happened and is DROPPED now,
   *  because the row was corrected by hand. `fullSquad` cannot do it —
   *  its fill SKIPS anyone who already has a row of any status, so a
   *  DROPPED target stays dropped and the replay silently tests nothing. */
  confirm?: string[];
  /** Put this case's sender in `SquadState.guestAskedUserIds` — the row
   *  `lib/guest-name-ask.ts`'s third gate reads ("at most ONE ask per
   *  player per match, forever"). IN MEMORY, on the cloned state: no
   *  `SentNotification` is written and nothing here can write one. It
   *  exists because that gate had a reader and no writer until
   *  2026-09-07, and a gate this harness cannot exercise is a gate
   *  nobody checks. */
  alreadyAskedForGuestName?: boolean;
  /**
   * RUN THE CLAUSE PEEL FIRST, exactly as `api/whatsapp/analyze/route.ts`
   * does, and hand the PIPELINE the residual.
   *
   * The peel itself is deterministic — `lib/pipeline/clause-peel.ts` is
   * pure and its unit tests settle the split. What is NOT deterministic,
   * and what this harness exists to measure, is whether the live router
   * and the live extractor then read the residual the way the fix
   * assumes: "and I'm out", torn off a swap instruction, has to route
   * `self_att` and extract a self-drop over 15 runs, not 13 of them.
   *
   * The predicate is the fast path's OWN whole-body test, passed here so
   * the harness cannot drift from the route's choice of clause.
   */
  peel?: (clause: string) => boolean;
  expect: string;
};

/** Najib is the player every `fullSquad` incident replay is ABOUT — the
 *  1 Sept "Najib is out" that MatchTime answered with "the squad is
 *  already full". If he is not in the squad, the replay tests nothing. */
const FULL_SQUAD_INCLUDES = ["Najib"];
/** Amir is the player C15b's grievance is about ("Matchtime put my name
 *  down as reserve without my confirm"), so the fill benches him. */
const FULL_SQUAD_BENCH = "Amir";

const CASES: Case[] = [
  // ── C: everyday traffic ───────────────────────────────────────────
  { id: "C1", who: "Ali", body: "In", expect: "WRITE Ali CONFIRMED" },
  { id: "C2", who: "Wasim", body: "Sorry lads can't make it Tuesday", expect: "DROP Wasim (he is in the squad)" },
  { id: "C3", who: "Mojib", body: "I'm out", expect: "NO write (not registered), stay silent" },
  { id: "C4", who: "Ilkay", body: "I'm around on Tuesday", expect: "NO write — availability is not a commitment (PR #46)" },
  { id: "C5", who: "Ilkay", body: "I'm free Tuesday if you need me", expect: "NO write — availability, not commitment" },
  { id: "C6", who: "Abid Kazmi", body: "maybe, 50/50 at the moment", expect: "NO confirmed write — tentative" },
  { id: "C7", who: "Amir", body: "@Kemal Ediz my brother can play if needed", expect: "NO attendance write for an unnamed guest; may ask for the name" },
  { id: "C8", who: "Elvin", body: "Shahrokh is IN", expect: "third-party guest registration — a write for Shahrokh is acceptable, must not touch Elvin" },
  { id: "C9", who: "Zair", body: "https://www.instagram.com/reel/DcqjVdJp6Iq/", expect: "SILENT noise" },
  { id: "C10", who: "Ali", body: "how many do we need?", expect: "SILENT — untagged non-attendance question (interaction contract)" },
  { id: "C11", who: "Ali", body: "@Match Time how many do we need?", tagged: true, expect: "ANSWER with the number still needed" },
  { id: "C12", who: "Enayem Rashid", body: "1. Kemal\n2. Mustafa\n3. Wasim\n4. Idris\n5. Burak\n6. David\n7. Ali\n8. Mojib", expect: "CLAMPED — must not rewrite the squad wholesale (PR #39)" },
  { id: "C13", who: "Zair", body: "Najib is out. We need one more player. Can someone pls come forward", expect: "recruit + third-party OUT. Najib is NOT in the squad, so no drop. Must NOT claim the squad is full" },
  { id: "C14", who: "Zair", body: "Najib is out. We need one more player. Can someone pls come forward", fullSquad: true, expect: "the 1 Sept incident replayed at a FULL squad. Must not reply 'squad is already full' and ignore the OUT" },
  { id: "C15", who: "Amir", body: "I can't come. Matchtime put my name down as reserve without my confirm", expect: "treat as OUT/grievance; must not silently confirm him" },
  { id: "C15b", who: "Amir", body: "I can't come. Matchtime put my name down as reserve without my confirm", fullSquad: true, expect: "Amir IS on the bench here. Expect he is taken OFF, not left on it" },

  // ── C16–C18: the 2026-09-09 silent-discard, end to end ────────────
  //
  // Four players typed "In" for Tuesday inside twenty minutes; two were
  // registered and two were silently discarded, one second apart in the
  // same batch. The extractor read the two that died as `claims: []` +
  // `affirmation: "yes"` and the engine's affirmation branch RETURNED.
  //
  // C1 is the same word from a different player and has always been the
  // control. These three are the phrasings Kemal named when he asked
  // for the fix to be wider than the literal word "in": "not just in,
  // anyone can say yes, count me, sure. Many different words."
  //
  // The per-phrasing extractor distribution is measured far more
  // cheaply by `scripts/measure-claimless.ts` (20+ runs, no database).
  // What these cases add is the END TO END answer over the LIVE squad:
  // router, extractor, engine and composer, with the real roster and
  // the real capacity arithmetic underneath.
  { id: "C16", who: "Zair", body: "In", expect: "THE 2026-09-09 INCIDENT. WRITE Zair CONFIRMED, every run. It was silently discarded twice on the night" },
  { id: "C17", who: "Zair", body: "count me", expect: "WRITE Zair CONFIRMED — Kemal named this phrasing by name" },
  { id: "C18", who: "Zair", body: "sure", expect: "MEASURED 7/10 WRITE Zair CONFIRMED, 3/10 silent — the router splits self_att 7/10 · none 3/10 on a bare \"sure\", and that is the honest answer for a genuinely ambiguous word. Before the fix it was 0/10. The SAME word answering a question routes `none` 19/20 and does nothing" },

  // ── X: a pasted roster that ALSO says something (2026-09-07) ──────
  //
  // The defect PR #55 marked `test.fail()`: the analyze route peeled ANY
  // roster-shaped message out of the batch, so a message that was BOTH a
  // list and its sender's own drop lost the drop. Pat stays CONFIRMED,
  // the squad reads full, the vacated slot is never offered and the club
  // turns up short.
  //
  // These are the extraction-dependent half — whether the model reads a
  // drop out of a message with fourteen names under it. The clamp itself
  // (`clampPastedRosterFacts`) is deterministic and unit-tested; run
  // these with REPEAT to see whether the EXTRACTOR is stable on the
  // shape.
  //
  // NOTE: this harness is `runPipeline`, not the route, so what it shows
  // for a paste is the ENGINE's half only. The route's arithmetic
  // (`reconcilePastedRoster`, which registers the appended names) has no
  // model in it and is not modelled here.
  { id: "X1", who: "Wasim", body: "can't make it lads, someone take my spot\n1. Kemal\n2. Mustafa\n3. Wasim\n4. Idris\n5. Burak\n6. David\n7. Ali\n8. Mojib", expect: "DROP Wasim (he is in the squad) and NOT ONE name off the list. Before 2026-09-07 the whole message was peeled and the drop was lost" },
  { id: "X2", who: "Wasim", body: "1. Kemal\n2. Mustafa\n3. Wasim\n4. Idris\n5. Burak\n6. David\n7. Ali\n8. Mojib", expect: "the same list with NOTHING else in it: no writes at all, silent. C12's rule, unchanged" },
  { id: "X3", who: "Wasim", body: "I'm in\n1. Kemal\n2. Mustafa\n3. Wasim\n4. Idris\n5. Burak\n6. David\n7. Ali\n8. Mojib", expect: "NO write. A sender's own IN read off a message containing a list is the coin flip PR #39 fixed; only a DROP survives the clamp" },

  // ── G: the guest-name-ask gate that had a reader and no writer ─────
  //
  // C7 is the ask itself. G1 is the third gate — "at most ONE ask per
  // player per match, forever" — which was inert from §10 step 8 until
  // 2026-09-07 because nothing wrote the `SentNotification` row
  // `load-state.ts` reads. With the row present the whole pipeline must
  // go silent on the SAME message C7 answers.
  { id: "G1", who: "Amir", body: "@Kemal Ediz my brother can play if needed", alreadyAskedForGuestName: true, expect: "SILENT — this player has already been asked on this match. Same message as C7, opposite outcome, and the only difference is the dedupe row" },

  // ── D: the same third-party OUT, phrased three ways ───────────────
  { id: "D1", who: "Zair", body: "Najib is out", fullSquad: true, expect: "bare third-party OUT, Najib in squad -> DROP Najib" },
  { id: "D2", who: "Zair", body: "Najib is out. We need one more player.", fullSquad: true, expect: "OUT + recruit -> DROP Najib" },
  { id: "D3", who: "Zair", body: "Najib can't make it tonight", fullSquad: true, expect: "third-party OUT phrased differently -> DROP Najib" },

  // ── K: the 1 Sept incident, as it actually happened ───────────────
  { id: "K1", who: "Kemal", body: "Najib is out. We need one more player. Can someone pls come forward", fullSquad: true, expect: "THE ACTUAL 1 SEPT INCIDENT. Admin + recruit => addressedByRecruit. Expect DROP Najib, NEVER 'squad is already full'" },
  { id: "K2", who: "Kemal", body: "Najib is out", fullSquad: true, expect: "admin, NO recruit clause => still untagged third-party OUT. Documented behaviour is silence" },
  { id: "K3", who: "Kemal", body: "@Match Time Najib is out", tagged: true, fullSquad: true, expect: "tagged third-party OUT => DROP Najib" },

  // ── Y: THE CLAUSE PEEL — incident #6 and its control ──────────────
  //
  // "@Match Time swap Elvin with Raihan, and I'm out" applied the swap
  // and lost the sender's OUT, because the swap fast path peeled the
  // WHOLE message off the pipeline. The peel now takes the SWAP CLAUSE
  // and the rest carries on. `clause-peel.ts` settles the SPLIT (it is
  // pure and unit-tested); these cases settle whether the live router
  // and extractor read what is LEFT the way the fix assumes.
  //
  // Y1 vs Y2 is the whole change in two rows: the same sentence, the
  // only difference being whether the peel ran.
  // Y4 pins the STATED LIMIT — no comma, no split, no residual — so the
  // half of the fix that was deliberately not taken is measured rather
  // than assumed.
  { id: "Y1", who: "Kemal", body: "@Match Time swap Elvin with Raihan, and I'm out", tagged: true, confirm: ["Kemal"], peel: (c) => parseSwapNames(c) !== null, expect: "THE FIX. The residual is \"I'm out\" -> route self_att -> DROP Kemal, every run" },
  // Y2 IS THE CONTROL, and what it measures is NOT "before the change"
  // — the route peels this message whole today, so the pipeline never
  // sees it at all. It measures the OTHER option that was on the table:
  // stop peeling and hand the WHOLE body down. MEASURED 2026-09-09,
  // 15/15: `other_att`, "DROPPED Kemal | CONFIRMED Raihan — slot 3 of
  // 14". It drops the sender correctly AND invents a registration for a
  // man named only as the target of a slot move. Y1, the same sentence
  // with the swap clause peeled off, is 15/15 "DROPPED Kemal" and
  // nothing else. That difference is the argument for peeling the
  // CLAUSE rather than either peeling the message or peeling nothing.
  { id: "Y2", who: "Kemal", body: "@Match Time swap Elvin with Raihan, and I'm out", tagged: true, confirm: ["Kemal"], expect: "THE CONTROL — the WHOLE body down the pipeline, the alternative to clause peeling. Expect the drop PLUS a phantom CONFIRMED Raihan read off the swap instruction" },
  { id: "Y3", who: "Kemal", body: "@Match Time who hasn't rated yet? Also I'm out", tagged: true, confirm: ["Kemal"], peel: looksLikeRatingProgressRequest, expect: "the rating-progress peel. Residual \"I'm out\" -> DROP Kemal" },
  // ⚠️ Y4 IS THE ONE CASE WHOSE HARNESS OUTPUT IS NOT WHAT PRODUCTION
  // DOES, and it is listed anyway because the difference is the point.
  // This harness has no `fresh` and therefore no SPLICE: when the peel
  // yields no residual it runs the pipeline on the whole body, whereas
  // the route removes the message from the batch entirely and the
  // pipeline never sees it. So Y4 prints what the pipeline WOULD have
  // said if the swap peel had not owned the message — and what it says
  // is itself the argument for the peel: it reads "swap Elvin with
  // Raihan" as a REGISTRATION and confirms a man called Raihan into the
  // squad. In production the swap peel owns this message, moves the
  // slot, and the sender's OUT is lost. That is the limit, stated.
  { id: "Y4", who: "Kemal", body: "@Match Time swap Elvin with Raihan and I'm out", tagged: true, confirm: ["Kemal"], peel: (c) => parseSwapNames(c) !== null, expect: "THE STATED LIMIT. No comma => a bare 'and' is not a boundary (or 'swap the reds and yellows' breaks) => NO residual. Read the `peel :` line, not the writes: in the route this message is spliced out and the pipeline never runs at all" },

  // ── P: the availability / standing-offer boundary ─────────────────
  //
  // The four probes that settle it. The two ends were always stable;
  // P1 was a coin flip until the `basis` rule was rewritten around the
  // VERB (PR #48). Kemal's decision, 2026-09-05: P1 must NOT register
  // the sender — a real player complained on 1 Sept, "I can't come.
  // Matchtime put my name down as reserve without my confirm".
  { id: "P1", who: "Ilkay", body: "I'm free Tuesday if you need me", expect: "NO write — a state verb plus a courtesy is availability, never an ask" },
  { id: "P2", who: "Ilkay", body: "I'm around if you're short", expect: "NO write — availability + politeness" },
  { id: "P3", who: "Ilkay", body: "put me down if you're short", expect: "WRITE — 'put me down' asks for the place (standing offer, S15a)" },
  { id: "P4", who: "Ilkay", body: "count me as the 14th if you need one", expect: "WRITE — claims the place (standing offer, S15a)" },

  // ── S: the score route (§10 step 7 part 2) ────────────────────────
  //
  // Untagged on purpose: `score` is deliberately EXCLUDED from
  // `ACTIONY_INTENTS` (interaction-contract.ts:125-129), so every real
  // "we won 5-3" in a group is untagged and a tag gate here would refuse
  // all of them.
  { id: "S1", who: "Kemal", body: "Red won 5-3 last night", expect: "route=score, WRITE score 5-3 against the last match PLAYED (any of TEAMS_PUBLISHED | TEAMS_GENERATED | COMPLETED)" },
  { id: "S2", who: "Zair", body: "we lost 2-6 lads, shocking", expect: "route=score. Zair must be a participant or an admin, or NO write — the §9 authorisation seatbelt" },
  { id: "S3", who: "Kemal", body: "good game that", expect: "NOT a score. Must produce no score write" },

  // ── A: the admin_ops route (§10 step 7 part 2) ────────────────────
  //
  // All THREE admin_ops actions require the tag. Payment and reminder
  // always did; the recruit blast joined them on 2026-09-06 — see the R
  // block below and `RECRUIT_BLAST_REQUIRES_TAG`.
  { id: "A1", who: "Kemal", body: "@Match Time Amir paid for 4 players", tagged: true, expect: "route=admin_ops, action=bulk_payment, WRITE payment_credit (aggregate, namedCovered false)" },
  { id: "A2", who: "Kemal", body: "@Match Time Amir paid for Faris and Adam", tagged: true, expect: "route=admin_ops, action=bulk_payment, namedCovered TRUE — a different write from A1" },
  { id: "A3", who: "Zair", body: "@Match Time Amir paid for 4 players", tagged: true, expect: "NO write — only an admin may credit a payment (real money, live club)" },
  { id: "A4", who: "Kemal", body: "@Match Time remind me tomorrow at 6 to bring the bibs", tagged: true, expect: "route=admin_ops, action=reminder, WRITE reminder with a RESOLVED sendAt — not the words" },
  { id: "A5", who: "Kemal", body: "@Match Time remind me before the match", tagged: true, expect: "NO write — the resolver refuses a phrase it cannot read rather than guessing a day" },

  // ── R: the recruit blast, the phrasing Kemal asked about ──────────
  //
  // Before this change every one of these routed `admin_ops` and came
  // back as `admin action \"other\" has no deterministic handler`, so the
  // ONLY thing that recognised them was the mega-prompt's
  // `verdict.recruitRequest`.
  { id: "R1", who: "Kemal", body: "@Match Time message all players who played in the last 5 matches to DM and invite them", tagged: true, expect: "route=admin_ops, action=recruit, lookbackMatches 5, WRITE recruit_blast. NO DM is sent from here — the route fires it after the batch" },
  // MEASURED 2026-09-06: the model reads "the last few games" as 3, not
  // as "unstated". That is a reading of the text and it is inside the
  // clamp, so it is safe either way — but the expectation says what
  // actually happens rather than what would have been tidier.
  { id: "R2", who: "Kemal", body: "@Match Time can you DM the lads from the last few games and ask them to play", tagged: true, expect: "same. 'the last few' comes back as a small number (measured: 3), which the clamp accepts; an unstated lookback would be null -> the default of 5" },
  // MEASURED 2026-09-06: the ROUTER needs the "invite them" half to call
  // this `admin_ops`; "message everyone from the last 50 games" alone
  // routes `question` 5/5. Phrased the way a real admin would, so the
  // clamp is exercised on a live route rather than only in a unit test.
  { id: "R3", who: "Kemal", body: "@Match Time DM everyone who played in the last 50 games and invite them", tagged: true, expect: "50 must be CLAMPED to 12 — a mass DM is how the WhatsApp account gets banned" },
  // ⚠️ R3b IS THE CASE THAT CHANGED THE POLICY, and the note that used
  // to sit here — "measured: routes `question`" — was measured on five
  // runs and was wrong. Over 20 router calls it is `admin_ops` 13/20,
  // `question` 4/20, `none` 3/20: a coin flip, on the one gate standing
  // between an untagged message and a 20-person mass DM. Since
  // 2026-09-06 the blast requires a tag (`RECRUIT_BLAST_REQUIRES_TAG`),
  // so all three of those routes now converge on "no blast" and the
  // DECISION is stable even though the ROUTE still is not. That is what
  // the two stability lines below report separately.
  { id: "R3b", who: "Kemal", body: "message everyone from the last 50 games", tagged: false, expect: "NO recruit_blast, on EVERY route the model samples (admin_ops 13/20, question 4/20, none 3/20). An untagged mass DM is refused" },
  { id: "R4", who: "Zair", body: "@Match Time message all players who played in the last 5 matches and invite them", tagged: true, expect: "NO recruit_blast — only an admin may send one" },
  { id: "R5", who: "Kemal", body: "@Match Time who played in the last 5 matches?", tagged: true, expect: "NOT recruit — asking to LIST the recent players is not asking to message them" },

  // ── R6–R10: the four shapes the tag decision has to tell apart ────
  //
  // Added 2026-09-06 with R3b. The point of the block is that all four
  // are recruit-flavoured and only ONE of them may fire a bulk DM.
  //
  //   R6  the explicit command, UNTAGGED, and unambiguous to the router
  //       (`admin_ops` 20/20). This is the case a "fire on an
  //       unambiguous imperative" carve-out would have kept, and it is
  //       exactly why there is no carve-out: nothing in the CODE can
  //       tell it from R3b, so the 13/20 rides in on the 20/20's coat
  //       tails. Silence here is the price, and it is one message.
  //   R7  the same command with the tag on. Must still fire.
  //   R8  a plain chase nudge. Must NEVER fire a blast — measured
  //       `none` 20/20, so this is the router agreeing, not the gate.
  //   R9  the 1 Sept shape once more, in the R block so a future reader
  //       of THIS policy sees it: untagged recruit alongside a drop,
  //       still works, still drops the player. K1 is the full replay.
  //
  //       ⚠️ R9 READS UNSTABLE (13/15) AND IT IS NOT THIS CHANGE. Its
  //       route is `other_att` 15/15, which never reaches the admin
  //       branch the tag gate lives in; the split is the EXTRACTOR
  //       calling the same sentence `sideRequests: ["recruit"]` 13
  //       times and `["chase"]` twice, and a `chase` gets no PR #33
  //       waiver, so the untagged drop is then suppressed by the
  //       contract. K1 — the real incident wording, which keeps the
  //       third sentence "Can someone pls come forward" — is `recruit`
  //       15/15. So the wobble is what the shorter phrasing costs, it
  //       predates 2026-09-06, and it is worth its own ticket: a drop
  //       silently lost 2 times in 15 is the §11.1 failure, on the
  //       attendance path rather than this one.
  //  R10  the same nudge WITH a tag. Tagged does not make a chase a
  //       command — "we need more players" names nobody to message and
  //       asks MatchTime for nothing it can do deterministically.
  { id: "R6", who: "Kemal", body: "DM everyone who played in the last 5 matches and invite them", tagged: false, expect: "NO recruit_blast. Router says admin_ops 20/20 and the extractor says recruit — and it is STILL refused, because untagged is untagged" },
  { id: "R7", who: "Kemal", body: "@Match Time DM everyone who played in the last 5 matches and invite them", tagged: true, expect: "WRITE recruit_blast, lookback 5. The same sentence, tagged, must fire" },
  { id: "R8", who: "Kemal", body: "come on lads we need more players", tagged: false, expect: "NO recruit_blast — a chase nudge is the scheduler's job, never a mass DM (router: none 20/20)" },
  { id: "R9", who: "Kemal", body: "Najib is out. We need one more player", fullSquad: true, expect: "DROP Najib untagged (PR #33 side-request path, UNTOUCHED by the blast tag gate). No recruit_blast write here — the side request is reported by attendance-engine-batch, not the engine. MEASURED 13/15; the other 2 extract `chase` instead of `recruit` and the drop is then suppressed — a PRE-EXISTING extractor wobble, see the note above" },
  { id: "R10", who: "Kemal", body: "@Match Time come on lads we need more players", tagged: true, expect: "NO recruit_blast — a tag does not turn a nudge into a bulk-DM command" },

  // ── B: THE STATS BLAST, and the 2026-09-10 near-miss ──────────────
  //
  // At 18:38 Kemal posted an ordinary reminder to his players and
  // MatchTime queued 69 personal stats-link DMs, off three keyword tests
  // ANDed together in `analyze/route.ts`. The regex is deleted; the ask
  // is now `AdminFacts.action = "stats_blast"`, gated by the engine
  // (admin + an EXPLICIT @-mention) and fired by the route.
  //
  // B1 IS THE ACCEPTANCE CASE OF THE WHOLE CHANGE and it must come back
  // "no stats_blast write" on every run. Note `tagged: true` on it: the
  // sentence contains the bare word "Matchtime", so `messageTagsBot`
  // — and therefore production — calls it tagged. The gate that refuses
  // it is the stricter `messageMentionsBotExplicitly`, which this
  // harness feeds through `taggedExplicitly`.
  //
  // B2–B5 are the natural variants that mention ratings, players and
  // DMs without instructing the bot: the shapes a keyword conjunction
  // cannot tell from a command, measured against a model that can.
  // B6–B8 are the controls — the real command, tagged (must fire),
  // untagged (must not), and from a non-admin (must not).
  {
    id: "B1",
    who: "Kemal",
    body:
      "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
      "the more accurate ratings, the more balanced teams next time",
    tagged: true,
    taggedExplicitly: false,
    expect: "THE 10 SEPT NEAR-MISS, VERBATIM. NO stats_blast write, on every run. 69 DMs is the alternative",
  },
  {
    id: "B2",
    who: "Kemal",
    body: "lads don't forget to rate the players from tuesday, the link is in your DMs",
    expect: "NOT a command. It instructs the PLAYERS; MatchTime is not asked for anything",
  },
  {
    id: "B3",
    who: "Kemal",
    body: "the more of you that rate, the more accurate everyone's stats get",
    expect: "NOT a command — a remark about ratings",
  },
  {
    id: "B4",
    who: "Zair",
    body: "did everyone get their stats link? mine came through last night",
    expect: "NOT a command — a question, and from a non-admin",
  },
  {
    id: "B5",
    who: "Kemal",
    body: "@Match Time can you remind everyone to rate the players",
    tagged: true,
    taggedExplicitly: true,
    expect: "TAGGED, and still NOT a stats blast: it asks for a REMINDER about rating, not for the stats links to be sent",
  },
  {
    id: "B6",
    who: "Kemal",
    body: "@Match Time send everyone their stats",
    tagged: true,
    taggedExplicitly: true,
    expect: "WRITE stats_blast. The feature is not deleted — this is the command it exists for",
  },
  {
    id: "B7",
    who: "Kemal",
    body: "send everyone their stats",
    tagged: false,
    taggedExplicitly: false,
    expect: "NO stats_blast — untagged is untagged, however unambiguous the imperative (RECRUIT_BLAST_REQUIRES_TAG's argument)",
  },
  {
    id: "B8",
    who: "Zair",
    body: "@Match Time send everyone their stats",
    tagged: true,
    taggedExplicitly: true,
    expect: "NO stats_blast — only an admin may DM the whole club",
  },

  // ── W: the 2026-09-07 incident — an admin's UNTAGGED third-party OUT
  //
  // Kemal posted "@Shahrokh🐔 Sutton Football Club is out due to
  // unforeseen issue at work" at 21:11 with Shahrokh CONFIRMED at
  // position 10, and MatchTime did nothing: a third-party OUT required a
  // tag, and that message tags no BOT — the "@" in it is on the PLAYER.
  // The squad read 13/14 with a player in it who was not coming.
  // `ADMIN_REPORTED_OUT_IS_TAG_FREE` is the fix.
  //
  // ⚠️ EVERY CASE HERE CARRIES `confirm: ["Shahrokh"]` because the live
  // row has since been corrected BY HAND and he is DROPPED in prod. On
  // the real state a drop case would pass by doing nothing.
  //
  // W1–W4 are the acceptance cases and W5–W8 are the controls; the
  // controls are the half that matters, because this change makes it
  // possible to remove a player without tagging the bot, so a false
  // positive now costs somebody their place.
  { id: "W1", who: "Kemal", body: "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue at work", confirm: ["Shahrokh"], expect: "THE 7 SEPT INCIDENT, VERBATIM. Admin, no BOT tag => DROP Shahrokh" },
  { id: "W2", who: "Kemal", body: "Shahrokh can't make it", confirm: ["Shahrokh"], expect: "DROP Shahrokh — the shortest natural phrasing" },
  { id: "W3", who: "Kemal", body: "Shahrokh is out tomorrow", confirm: ["Shahrokh"], expect: "DROP Shahrokh — 'tomorrow' is the match, not a future fixture" },
  { id: "W4", who: "Kemal", body: "@Wasim is out", confirm: ["Wasim"], expect: "DROP Wasim — a player @-mention with nothing else in the message" },
  // ── the controls ──────────────────────────────────────────────────
  { id: "W5", who: "Kemal", body: "Shahrokh was unreal last week, best player on the pitch", confirm: ["Shahrokh"], expect: "THE BANTER CONTROL. Names a player, reports nobody out => NO write, silent. A drop here is the failure this whole change risks" },
  { id: "W5b", who: "Kemal", body: "Shahrokh is out of form at the moment", confirm: ["Shahrokh"], expect: "THE ADVERSARIAL CONTROL: contains the literal words 'Shahrokh is out' inside a sentence that means the opposite of an absence. NO write" },
  { id: "W6", who: "Wasim", body: "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue at work", confirm: ["Shahrokh"], expect: "THE LIMIT. The same message from a NON-admin => NO write. Only Kemal holds an OWNER/ADMIN seat on this org" },
  { id: "W7", who: "Kemal", body: "put Shahrokh on the bench", confirm: ["Shahrokh"], expect: "BENCH is NOT waived => NO write. The waiver covers removal, never a demote" },
  { id: "W8", who: "Kemal", body: "Shahrokh is out, Rashad can take his spot", confirm: ["Shahrokh"], expect: "the SWAP shape: DROP Shahrokh and register Rashad. The OUT half is waived, the IN half was already tag-free" },
  // W9/W10 are the pair that pins the guard the waiver had to move.
  // `banterRefusal` used to exempt every ADMIN from its joke-marker
  // refusal, which was only safe while an admin's drop necessarily
  // carried a tag. Now the exemption hangs off THE TAG.
  { id: "W9", who: "Kemal", body: "Shahrokh is out 😂😂 vote him out lads", confirm: ["Shahrokh"], expect: "NO write. Untagged + banter markers => refused, even from the owner (the moved banterRefusal)" },
  { id: "W10", who: "Kemal", body: "@Match Time Shahrokh is out 😂 gutted for him", tagged: true, confirm: ["Shahrokh"], expect: "DROP Shahrokh. The SAME markers WITH a tag are still honoured — unchanged behaviour, and the control for W9" },

  // ── V: the 2026-09-08 incident — ONE REFUSED CLAUSE ATE THE MESSAGE
  //
  // Kemal posted, untagged, on match day:
  //
  //   "David is OUT voluntarily to switch to 5aside.
  //
  //    Either @Mojib Jalali or @Najib can be in the main squad and the
  //    other can go to bench"
  //
  // MatchTime recorded NOTHING. `ADMIN_REPORTED_OUT_IS_TAG_FREE` waives
  // the tag for an admin only when every entry is IN or OUT, the bench
  // clause failed that `every`, and the gate was taken ONCE FOR THE
  // WHOLE MESSAGE — so a clean "David is OUT" from the one person
  // entitled to say it died with it. David played on and the owner
  // corrected the squad by hand, twice.
  //
  // The bench rule is NOT reversed: a demote still needs a tag from
  // everybody. The gate is now asked PER CLAIM.
  //
  // ⚠️ THESE ARE THE EXTRACTION-DEPENDENT HALF. The split itself is
  // deterministic and unit-tested; what a REPEAT sweep settles is
  // whether the extractor reads two separate claims out of a two-clause
  // message, and what it does with the either/or sentence — which names
  // nobody definitively and must therefore register nobody.
  //
  // V5 is the adversarial control and it is the half that matters: this
  // change makes MatchTime act on PART of a message it previously
  // ignored whole, so a false positive now costs somebody their place.
  { id: "V1", who: "Kemal", body: "David is OUT voluntarily to switch to 5aside.\n\nEither @Mojib Jalali or @Najib can be in the main squad and the other can go to bench", confirm: ["David", "Mojib"], expect: "THE 8 SEPT INCIDENT, VERBATIM. DROP David. Mojib and Najib UNCHANGED (an either/or names nobody, and a bench needs a tag). MatchTime should SAY what it left alone if it refuses a named bench" },
  { id: "V2", who: "Kemal", body: "David is out, put Mojib on the bench", confirm: ["David", "Mojib"], expect: "the incident's shape with both clauses unambiguous: DROP David, Mojib STAYS CONFIRMED, and a sentence naming the half that needs a tag" },
  { id: "V3", who: "Kemal", body: "David can't make it tonight. Mojib drops to the bench", confirm: ["David", "Mojib"], expect: "the same two clauses phrased naturally: DROP David, Mojib unchanged" },
  { id: "V4", who: "Wasim", body: "David is out, put Mojib on the bench", confirm: ["David", "Mojib"], expect: "THE LIMIT. A NON-admin: NOTHING applied, and MatchTime stays silent. Both clauses are refused, so there is no turn for a refusal sentence to ride" },
  { id: "V5", who: "Kemal", body: "David is out of form since he switched to 5aside. Either Mojib or Najib would walk into the main squad ahead of him", confirm: ["David", "Mojib"], expect: "THE ADVERSARIAL CONTROL. Contains the literal words 'David is out' inside a sentence about FORM, and an either/or about the squad. NO write, nobody dropped, nobody benched" },
  { id: "V6", who: "Kemal", body: "@Match Time David is out, put Mojib on the bench", tagged: true, confirm: ["David", "Mojib"], expect: "the same message TAGGED: DROP David and BENCH Mojib. The control for V2 — the tag is what the bench clause was always missing" },
];

/**
 * ── THE TAGGED-QUESTION TABLE (`QUESTIONS=1`) ─────────────────────────
 *
 * Twenty-four phrasings a Sunday-league group actually sends, all
 * @-tagged (step 7 requires a tag unconditionally, so an untagged
 * question is out of scope by construction and is covered by the
 * interaction-contract tests instead).
 *
 * They are run through `runAnswerBatch` — the thing PRODUCTION would run
 * with the flags on — and not through `runPipeline`. That distinction is
 * the whole reason this block exists. `runPipeline` has no ownership
 * layer and no analyzer behind it, so a message step 7 deliberately
 * declines shows up there as "(silent)" and looks identical to a defect.
 * The 2026-09-06 measurement that started this change read seven
 * silences off `runPipeline` for exactly that reason; four were a real
 * defect (topic `fixture` did not exist) and three were the carve-outs
 * working. Here they are scored apart:
 *
 *   ANSWERED     step 7 owns it and composed a reply
 *   HANDED BACK  step 7 declined it AND SAID WHY
 *   SILENT       neither. This column must read 0. Anything in it is
 *                §9's signature failure: "message understood, action
 *                silently not taken".
 *
 * ⚠️ WHAT "HANDED BACK" IS WORTH CHANGED WITH §10 STEP 8 (2026-09-06).
 * This block used to say "in production the mega-prompt then answers it,
 * so this is not a silence". It is deleted. A hand-back now goes to
 * `route.ts`'s catch-all: NOTHING is said in the group, and one deduped
 * operator DM is sent (`lib/operator-note.ts`). So the HANDED BACK column
 * is no longer free — it is the number of tagged questions a real group
 * would ask and get no answer to, and the two columns should be read
 * together rather than only checking that SILENT is 0.
 *
 * THAT COLUMN WAS FOUR AND IS NOW ONE (2026-09-09). Q22 (stats) and Q23
 * (options) were built answers refused for a composed-FORMAT reason and
 * both now speak; Q12 (money) had no data in `SquadState` and now has a
 * targeted loader. The measured sweep over Q1-Q24 × 2 went 38/48 → 46/48
 * answered with SILENT still 0.
 *
 * Q20 is the last one, it is in this column BY DESIGN, and it is the one
 * that should stay: "is my mate down for tuesday" names nobody, so
 * nothing in the system can answer it and a confident guess would be the
 * §3.2 S16 failure class. Anything else appearing here is a regression.
 *
 * `expect` is what a human decided the right column is. The harness
 * prints both and marks a mismatch; it does not fail the process, for
 * the same reason the C/D/K/P table does not.
 */
type QuestionCase = {
  id: string;
  who: string;
  body: string;
  expect: "ANSWERED" | "HANDED BACK";
  /** What the answer has to contain to be right, when it is answered. */
  wants?: RegExp;
  why: string;
};

const QUESTION_CASES: QuestionCase[] = [
  // ── The twelve from the 2026-09-06 sweep, verbatim ────────────────
  { id: "Q1", who: "Ali", body: "@Match Time how many do we need?", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count" },
  { id: "Q2", who: "Ali", body: "@Match Time who's in?", expect: "ANSWERED", wants: /Playing:/, why: "roster, not a count" },
  { id: "Q3", who: "Ali", body: "@Match Time whats the score situation", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count — 'score' here means the tally, not a result" },
  { id: "Q4", who: "Ali", body: "@Match Time are we playing tuesday?", expect: "ANSWERED", wants: /\d{1,2}:\d{2}/, why: "fixture" },
  { id: "Q5", who: "Ali", body: "@Match Time how many spots left", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count" },
  { id: "Q6", who: "Ali", body: "@Match Time list the players", expect: "ANSWERED", wants: /Playing:/, why: "roster" },
  { id: "Q7", who: "Ali", body: "@Match Time what time is kickoff", expect: "ANSWERED", wants: /\d{1,2}:\d{2}/, why: "fixture" },
  { id: "Q8", who: "Ali", body: "@Match Time where are we playing", expect: "ANSWERED", wants: /at \S/, why: "fixture — the venue" },
  { id: "Q9", who: "Ali", body: "@Match Time do we have enough?", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count" },
  { id: "Q10", who: "Ali", body: "@Match Time show me the squad", expect: "ANSWERED", wants: /Playing:/, why: "roster — NOT the team line-ups" },
  { id: "Q11", who: "Ali", body: "@Match Time is the game still on", expect: "ANSWERED", wants: /\d{1,2}:\d{2}/, why: "fixture" },
  { id: "Q12", who: "Ali", body: "@Match Time who hasn't paid", expect: "ANSWERED", wants: /still to pay|all settled|don't track|no payments|settled match/i, why: "payments — a COUNT, never a name (buildUnpaidTail's rule). Was the last unanswerable one on this list" },

  // ── More of the same shapes, phrased as the group phrases them ────
  { id: "Q13", who: "Zair", body: "@Match Time whos playing tonight", expect: "ANSWERED", wants: /Playing:/, why: "roster" },
  { id: "Q14", who: "Zair", body: "@Match Time how many are we", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count" },
  { id: "Q15", who: "Zair", body: "@Match Time we're 9/14 right?", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count with a stated number — S24 fact-check" },
  { id: "Q16", who: "Zair", body: "@Match Time who's on the bench?", expect: "ANSWERED", why: "bench" },
  { id: "Q17", who: "Zair", body: "@Match Time same place as usual?", expect: "ANSWERED", wants: /at \S/, why: "fixture — the venue" },
  { id: "Q18", who: "Zair", body: "@Match Time what time we kicking off", expect: "ANSWERED", wants: /\d{1,2}:\d{2}/, why: "fixture" },
  { id: "Q19", who: "Amir", body: "@Match Time is Zair in?", expect: "ANSWERED", wants: /Zair/, why: "person_status, resolvable" },
  { id: "Q20", who: "Amir", body: "@Match Time is my mate down for tuesday", expect: "HANDED BACK", why: "person_status that cannot resolve to one member" },
  { id: "Q21", who: "Amir", body: "@Match Time anyone in the squad without a number?", expect: "ANSWERED", why: "phones" },
  { id: "Q22", who: "Amir", body: "@Match Time who's been most consistent this season?", expect: "ANSWERED", wants: /—\s\d+\smatch/, why: "stats — the leaderboard row shape must survive displaysSquadState (2026-05-14)" },
  { id: "Q23", who: "Amir", body: "@Match Time we're short, what are our options?", expect: "ANSWERED", wants: /\bof \d+\b/, why: "options — the lead spells the count out so rule (c) cannot fire" },
  { id: "Q24", who: "Elvin", body: "@Match Time show me the teams", expect: "ANSWERED", why: "balancer/show — a real post if teams exist, the shipped 'no teams generated yet' if not" },

  // ── THE RESULT OF THE LAST MATCH (topic `score`) ──────────────────
  //
  // Q3 ("whats the score situation") is the AMBIGUOUS one and it stays
  // where it is, expecting a count. These four settle what the
  // UNAMBIGUOUS phrasings do, so Q3's reading can be measured against
  // something rather than asserted.
  { id: "Q25", who: "Zair", body: "@Match Time what was the score last week", expect: "ANSWERED", wants: /\d+ - \d+/, why: "score — unambiguously the RESULT" },
  { id: "Q26", who: "Zair", body: "@Match Time did we win on tuesday?", expect: "ANSWERED", wants: /\d+ - \d+/, why: "score — the result, phrased as a yes/no" },
  { id: "Q27", who: "Ali", body: "@Match Time what was the final score", expect: "ANSWERED", wants: /\d+ - \d+/, why: "score — the result" },
  { id: "Q28", who: "Ali", body: "@Match Time how did we get on last night", expect: "ANSWERED", wants: /\d+ - \d+/, why: "score — the result, phrased the way the group phrases it" },

  // ── WHO HAS NOT PAID (topic `payments`) ───────────────────────────
  { id: "Q29", who: "Elvin", body: "@Match Time who hasn't paid", expect: "ANSWERED", why: "payments — the question that started this, from the money collector" },
  { id: "Q30", who: "Ali", body: "@Match Time has everyone paid for last week", expect: "ANSWERED", why: "payments — the same question from an ordinary member" },
  { id: "Q31", who: "Zair", body: "@Match Time how many still owe for tuesday", expect: "ANSWERED", why: "payments — asked as a number rather than as names" },
  { id: "Q32", who: "Elvin", body: "@Match Time any payments outstanding?", expect: "ANSWERED", why: "payments — the collector's phrasing" },

  // ── NEGATIVE CONTROLS ─────────────────────────────────────────────
  //
  // Two questions that must NOT be answered from payment data, and one
  // that must not be answered at all. Q34 is the sharp one: it carries
  // the word "pay" and asks something MatchTime cannot answer from
  // `Attendance.paidAt` — the FEE is a number no field in `SquadState`
  // holds. A payments answer here would be a confident non sequitur.
  { id: "Q33", who: "Ali", body: "@Match Time who's in for tuesday", expect: "ANSWERED", wants: /Playing:/, why: "NEGATIVE CONTROL — a roster question phrased near payment vocabulary must stay a roster question" },
  { id: "Q34", who: "Ali", body: "@Match Time how much do we pay each", expect: "HANDED BACK", why: "NEGATIVE CONTROL — the FEE, which is not in SquadState. Naming who has not paid would be answering a different question" },
  { id: "Q35", who: "Amir", body: "@Match Time is my mate down for tuesday", expect: "HANDED BACK", why: "TIER 4 CONTROL — an unresolvable person_status. Nothing can answer it; the hand-back is correct and must survive this change" },
];

/**
 * ── THE GENERATE-TEAMS TABLE (`TEAMS=1`) ──────────────────────────────
 *
 * §10 step 8's own route, and the only one in this file whose owner has
 * an APPLY LAYER THAT WRITES. Read `runTeams` before changing anything
 * here.
 *
 * The bodies are not invented. `team-ops-engine-batch.ts`'s header
 * records the measurement: over 120 days of production `AnalyzedMessage`
 * rows on Sutton FC, `generate_teams_request` occurred **23 times** —
 * the single most common tagged command to MatchTime, more common than
 * every question shape put together. These are the shapes that traffic
 * takes, including the three that are NOT owned, because "the club's
 * most-used command sometimes does nothing" is the finding this table
 * exists to surface.
 *
 * `expect` is what a human decided the right answer is. As with the
 * C/D/K/P table the harness prints it beside what happened and marks a
 * mismatch; it does not grade and it does not fail the process.
 */
type TeamCase = {
  id: string;
  who: string;
  body: string;
  /** Default true. `false` is a real case: the tag is REQUIRED. */
  tagged?: boolean;
  expect: "GENERATES" | "HANDED BACK" | "NOT OWNED";
  why: string;
};

const TEAM_CASES: TeamCase[] = [
  // ── The plain form, ×8 in the measured corpus ─────────────────────
  {
    id: "T1",
    who: "Kemal",
    body: "@Match Time generate the teams",
    expect: "GENERATES",
    why: "the most common tagged command in the group, verbatim",
  },
  // ── A pairing. `TeamFacts.pairings`, added 2026-09-06 ─────────────
  {
    id: "T2",
    who: "Kemal",
    body: "@Match Time generate the teams, put me and Ehtisham to the same team",
    expect: "GENERATES",
    why:
      "pairing, not a colour: `pairings` must carry [me, Ehtisham] and `swaps` must be " +
      "empty. Before that field existed the only way to express this was to make the " +
      "model invent a colour",
  },
  // ── Fun names: OWNED, but the names are LOST. Stated, not hidden. ─
  {
    id: "T3",
    who: "Kemal",
    body: "@Match Time generate the teams now, come up with fun team names",
    expect: "GENERATES",
    why:
      "the line-ups have to be worked out again so this extracts `generate` and IS owned " +
      "— but the teams come out Red/Yellow. `team-ops-engine-batch.ts`'s \"what did not " +
      "come across\" section: the extractor is told it never picks a name, so a request to " +
      "INVENT names is silently answered without them. The one real loss on this route",
  },
  // ── Absolute pins, plus the word `regenerate` ─────────────────────
  {
    id: "T4",
    who: "Kemal",
    body: "@Match Time regenerate the teams, put David and Kemal together in Red team",
    expect: "GENERATES",
    why:
      "`regenerate` must still extract as `generate`, and \"in Red team\" is an ABSOLUTE " +
      "pin — `swaps`, not `pairings`",
  },
  // ── `show`: owned by the OTHER owner, handed back by this one ─────
  {
    id: "T5",
    who: "Kemal",
    body: "@Match Time show us the teams again without regenerating replacing Ehtisham with Najib",
    expect: "HANDED BACK",
    why:
      "the 2026-06-18 incident (c408649) as one sentence: `show` belongs to " +
      "`answer-batch.ts` and re-running the balancer over hand-swapped line-ups is the " +
      "exact thing that split `show` from `generate`. If this ever extracts `generate`, " +
      "that incident is back",
  },
  // ── `swap`: already has a deterministic owner upstream ────────────
  {
    id: "T6",
    who: "Kemal",
    body: "@Match Time swap the colors and keep the same squad",
    expect: "HANDED BACK",
    why:
      "`route.ts`'s `handleColorSwapIfApplicable` owns this on the RAW BODY before any " +
      "model runs, so this path must decline it. Two deciders on one message is the " +
      "failure being avoided; in production the pre-peel answers it and the group sees a " +
      "reply this harness does not model",
  },
  // ── UNTAGGED. The tag is required, unconditionally. ───────────────
  {
    id: "T7",
    who: "Kemal",
    body: "Make the teams",
    tagged: false,
    expect: "NOT OWNED",
    why:
      "measured in the corpus and deliberately not owned: `generate_teams_request` is in " +
      "ACTIONY_INTENTS, so the shipped interaction contract already refuses an untagged " +
      "one. Since §10 step 8 that refusal means SILENCE plus an operator note rather than " +
      "the mega-prompt answering — which is why it is in this table rather than assumed",
  },
];

/** The two lines above every case, so the model sees a group mid-chase. */
const HISTORY = [
  { author: "MatchTime", body: "🗓 Squad update\n\nWe're short for Tuesday 7-a-side — need more bodies." },
  { author: "Kemal Ediz", body: "come on lads, need a few more for Tuesday" },
];

// ── Roster lookup, by name ────────────────────────────────────────────

/**
 * Find a member by display name. Exact match first, then a unique
 * case-insensitive prefix — "Ali" and "Abid Kazmi" are how the group
 * writes them, and neither is a user id.
 *
 * Fails LOUDLY and by name. Hardcoded cuids in the scratch version of
 * this script would have silently attributed a message to whoever
 * inherited the id after a merge; a missing name must stop the run.
 */
function memberByName(roster: Member[], name: string): Member {
  const exact = roster.filter((m) => m.name === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `roster has ${exact.length} members called "${name}" — disambiguate the case table`,
    );
  }
  const lower = name.toLowerCase();
  const prefix = roster.filter((m) => m.name.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new Error(
      `"${name}" is ambiguous in the roster — matches ${prefix
        .map((m) => `"${m.name}"`)
        .join(", ")}. Use the full name in the case table.`,
    );
  }
  throw new Error(
    `no roster member matches "${name}". The roster has ${roster.length} members: ` +
      roster
        .map((m) => m.name)
        .sort()
        .join(", "),
  );
}

/**
 * Fill the squad to `maxPlayers`, then park one player on the bench. For
 * replaying an incident that only reproduces at 14/14.
 *
 * `include` goes in FIRST and is the load-bearing part: every incident
 * replay in this table is about one named player being dropped, and he
 * has to be in the squad the fill produces or the case silently tests
 * nothing. The rest is topped up in roster order.
 *
 * Purely in-memory — `state` is structuredCloned and never persisted.
 */
/**
 * Put named roster members in the squad on the CLONED state. In memory
 * only — see the `confirm` field on `Case` for why it exists and why
 * `fullSquad` cannot stand in for it.
 */
function forceConfirmed(s: SquadState, names: string[]): void {
  for (const n of names) {
    const m = memberByName(s.roster, n);
    const row = s.rows.find((r) => r.userId === m.userId);
    if (row) {
      row.status = "CONFIRMED";
      continue;
    }
    if (s.rows.filter((r) => r.status === "CONFIRMED").length >= s.maxPlayers) {
      throw new Error(`confirm: no room for "${n}" — the squad is already ${s.maxPlayers}/${s.maxPlayers}`);
    }
    s.rows.push({ userId: m.userId, status: "CONFIRMED", position: s.rows.length + 1 });
  }
}

function fillSquad(state: SquadState, include: string[], benchName: string): SquadState {
  const s = structuredClone(state);
  const taken = new Set(s.rows.map((r) => r.userId));
  const bench = memberByName(s.roster, benchName);
  const seed = include.map((n) => memberByName(s.roster, n));

  for (const m of [...seed, ...s.roster]) {
    if (s.rows.length >= s.maxPlayers) break;
    if (taken.has(m.userId) || m.userId === bench.userId) continue;
    taken.add(m.userId);
    s.rows.push({ userId: m.userId, status: "CONFIRMED", position: s.rows.length + 1 });
  }
  if (s.rows.length < s.maxPlayers) {
    throw new Error(
      `fullSquad needs ${s.maxPlayers} players but the roster only has ${s.roster.length}`,
    );
  }
  for (const m of seed) {
    if (!taken.has(m.userId)) {
      throw new Error(
        `fullSquad could not fit "${m.name}" into ${s.maxPlayers} slots — ` +
          `the squad already had ${state.rows.length} rows, so the replay would test nothing`,
      );
    }
  }
  if (!taken.has(bench.userId)) {
    s.rows.push({ userId: bench.userId, status: "BENCH", position: s.rows.length + 1 });
  }
  return s;
}

// ── Reporting ─────────────────────────────────────────────────────────

const nameOf = (state: SquadState, userId: string): string =>
  state.roster.find((m) => m.userId === userId)?.name ?? userId;

function describeSquad(state: SquadState): string {
  const confirmed = state.rows.filter((r: AttendanceRow) => r.status === "CONFIRMED");
  const bench = state.rows.filter((r: AttendanceRow) => r.status === "BENCH");
  return (
    `${confirmed.length}/${state.maxPlayers} confirmed` +
    (bench.length ? `, ${bench.length} on the bench` : "") +
    `\n  squad: ${confirmed.map((r) => nameOf(state, r.userId)).join(", ") || "(empty)"}` +
    (bench.length ? `\n  bench: ${bench.map((r) => nameOf(state, r.userId)).join(", ")}` : "")
  );
}

/** Kinds whose whole purpose is the countdown — they MUST name the
 *  kickoff time. PR #47 pins the same three in the prompt. */
const KICKOFF_TIME_REQUIRED: ChaseKind[] = [
  "chase-pre-kickoff",
  "pre-kickoff-full",
  "pre-kickoff-short",
];

/**
 * Compose all five scheduled chases and check the copy reads as English.
 *
 * The checks are the shapes the 2026-09-05 dry run actually produced:
 * "for on Tue 8 Sept 21:30's 7-a-side" (a preposition doubled by
 * `enforceProximity`) and "on Tue 8 Sept 21:30 at 21:30" (the kickoff
 * time printed twice, because the "day label" carried it). Plus the
 * regression direction: three kinds must still state the kickoff time.
 *
 * Read-only. `composeChaseText` reads the match and returns text; the
 * scheduler and WhatsApp are not involved.
 */
async function runChases(groupId: string): Promise<void> {
  const KINDS: ChaseKind[] = [
    "daily-in-list",
    "match-day-morning",
    "chase-pre-kickoff",
    "pre-kickoff-full",
    "pre-kickoff-short",
  ];
  /** A preposition immediately followed by another one. */
  const DOUBLED_PREPOSITION = /\b(?:for|at|on|by|from|until|before|after)\s+on\s/i;
  let failures = 0;

  for (const kind of KINDS) {
    const text = await composeChaseText({ groupId, kind });
    console.log(`══════════════════ ${kind} ══════════════════\n${text ?? "(null — fell back to static text)"}\n`);
    if (!text) {
      console.log("  ⚠️  null — the scheduler would post the STATIC fallback\n");
      failures++;
      continue;
    }
    const problems: string[] = [];
    const doubled = text.match(DOUBLED_PREPOSITION);
    if (doubled) problems.push(`doubled preposition: ${JSON.stringify(doubled[0].trim())}`);
    // Only the LEAD is checked for a repeated time — the roster block
    // below it never contains one.
    const lead = text.split(/\n\s*\*?Playing/)[0];
    for (const [time, hits] of Object.entries(
      [...lead.matchAll(/\b\d{1,2}:\d{2}\b/g)].reduce<Record<string, number>>(
        (acc, m) => ({ ...acc, [m[0]]: (acc[m[0]] ?? 0) + 1 }),
        {},
      ),
    )) {
      if (hits > 1) problems.push(`"${time}" appears ${hits}× in the lead`);
    }
    if (KICKOFF_TIME_REQUIRED.includes(kind) && !/\b\d{1,2}:\d{2}\b/.test(lead)) {
      problems.push("no kickoff time, and this kind requires one");
    }
    if (problems.length) {
      failures++;
      console.log(`  ❌ ${problems.join(" | ")}\n`);
    } else {
      console.log("  ✅ reads as English, kickoff time as expected\n");
    }
  }
  console.log(
    failures === 0
      ? "All five chase kinds pass. Writes performed: 0."
      : `⚠️  ${failures} of ${KINDS.length} chase kinds have a problem. Writes performed: 0.`,
  );
}

/**
 * Run the tagged-question table through §10 step 7's owner.
 *
 * READ-ONLY, twice over: `runAnswerBatch` proposes no writes at all
 * (`__tests__/zero-writes.test.ts` scans its whole directory on every
 * build, and the function refuses the batch if the engine ever hands it
 * one), and the state it decides against is injected here from a single
 * `loadSquadState` read that is then handed to every case unchanged.
 *
 * The router runs per case rather than once over all of them, because a
 * real WhatsApp window carries one or two messages and a batch of
 * twenty-four questions is a context the router will never see in
 * production. It costs one extra call per case and buys a number that
 * means something.
 */
async function runQuestions(orgId: string, state: SquadState, now: Date): Promise<void> {
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1));
  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const selected = QUESTION_CASES.filter((c) => !only || only.includes(c.id));
  if (only) {
    const unknown = only.filter((id) => !QUESTION_CASES.some((c) => c.id === id));
    if (unknown.length) throw new Error(`ONLY names no such question case: ${unknown.join(", ")}`);
  }
  const features = await getOrgFeatures(orgId);
  const model = anthropicModel();
  const senders = new Map(selected.map((c) => [c.id, memberByName(state.roster, c.who)]));

  let answered = 0;
  let handedBack = 0;
  let silent = 0;
  let wrongAnswer = 0;
  let mismatched = 0;
  let runs = 0;
  let totalUsd = 0;

  for (const c of selected) {
    const sender = senders.get(c.id)!;
    console.log(`\n${"─".repeat(72)}\n${c.id}  ${sender.name} [@tagged]: ${JSON.stringify(c.body)}\n  expect : ${c.expect} (${c.why})`);

    for (let n = 0; n < repeat; n++) {
      const id = `${c.id}-${n}`;
      const routed = await routeBatch(model, [{ id, authorName: sender.name, body: c.body }]);
      const route: Route = routed.routes[0]?.route ?? "unsure";
      totalUsd += routed.usage?.costUsd ?? 0;

      const res = await runAnswerBatch({
        orgId,
        now,
        messages: [
          {
            waMessageId: id,
            body: c.body,
            authorName: sender.name,
            senderUserId: sender.userId,
            senderName: sender.name,
            tagged: true,
            route,
            gated: false,
          },
        ],
        history: HISTORY,
        expectedMatchId: state.matchId,
        enabled: new Set<Route>(["question", "balancer"]),
        // Injected so the whole sweep decides against ONE state read.
        deps: { model, loadState: async () => state, loadFeatures: async () => features },
      });
      totalUsd += res.cost.usd;
      runs++;

      const outcome = res.outcomes.get(id);
      const reply = outcome?.reply ?? null;
      // The three columns. A message the ROUTER sent somewhere step 7
      // does not own is counted as a hand-back too, because step 7
      // declining a route it never claimed is a decision rather than a
      // fault — that is why the route is printed beside every verdict.
      // What happens NEXT is no longer "the analyzer decides it": since
      // §10 step 8 it is either another owner or silence, so read this
      // column with the header's warning in mind.
      const routeIsOurs = route === "question" || route === "balancer";
      const gaveAReason = res.degradations.some((d) => d.includes(id)) || !routeIsOurs;
      const verdict = reply ? "ANSWERED" : gaveAReason ? "HANDED BACK" : "SILENT";
      if (verdict === "ANSWERED") answered++;
      else if (verdict === "HANDED BACK") handedBack++;
      else silent++;

      const wrong = verdict === "ANSWERED" && c.wants !== undefined && !c.wants.test(reply!);
      if (wrong) wrongAnswer++;
      if (verdict !== c.expect) mismatched++;

      console.log(
        `  ${repeat > 1 ? `run ${n + 1}/${repeat}  ` : ""}route=${route.padEnd(9)} ` +
          `${verdict}${verdict !== c.expect ? `  ⚠️ expected ${c.expect}` : ""}` +
          `${wrong ? `  ⚠️ answer does not match ${c.wants}` : ""}`,
      );
      if (reply) console.log(`  says   : ${JSON.stringify(reply.slice(0, 160))}`);
      else if (!routeIsOurs) console.log(`  reason : the router sent it to "${route}", which step 7 does not own`);
      else if (res.degradations.length) console.log(`  reason : ${res.degradations.join(" | ")}`);
    }
  }

  console.log(
    `\n${"═".repeat(72)}\n` +
      `${selected.length} question(s) × ${repeat} = ${runs} run(s).\n` +
      `  ANSWERED    ${answered} of ${runs}\n` +
      `  HANDED BACK ${handedBack} of ${runs}  (⚠️ since §10 step 8 nobody answers these — ` +
      `the group hears nothing and an operator is DM'd)\n` +
      `  SILENT      ${silent} of ${runs}${silent === 0 ? "  ✅" : "  ❌ this must be 0"}\n` +
      `  answers not matching their wants-pattern: ${wrongAnswer}\n` +
      `  verdicts differing from expect:           ${mismatched}\n` +
      `Total cost: $${totalUsd.toFixed(4)}. Writes performed: 0 (this harness cannot write).`,
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * Run the generate-teams table through §10 step 8's REAL owner.
 *
 * ── WHY THIS ONE NEEDED AN ARGUMENT, AND THE OTHER MODES DID NOT ─────
 *
 * Every other mode in this file is read-only for free. `runPipeline` is
 * dry-run by design and `runAnswerBatch` has no apply layer at all
 * (`__tests__/zero-writes.test.ts` scans its whole directory on every
 * build). `runTeamOpsBatch` is different: it is the first thing this
 * script touches that ends in `applyGenerateTeams`, which force-confirms
 * attendance rows, rewrites every `TeamAssignment` on the match and
 * moves `Match.status`. On a customer's live squad. So the read-only
 * property has to be ARGUED rather than inherited.
 *
 * ── THE ARGUMENT: THE APPLY LAYER'S ONLY I/O IS THREE INJECTED FNS ───
 *
 * `TeamOpsApplyDeps` is the entire surface through which the apply layer
 * can touch the world — `selectTeamsMatch`, `forceConfirm`,
 * `generateTeams` — and `runTeamOpsBatch` takes it as an argument.
 * Two of the three are replaced here by recorders that perform no I/O
 * and return; nothing else in `team-ops-engine.ts` or
 * `team-ops-engine-batch.ts` opens a Prisma client of its own.
 *
 *   selectTeamsMatch  THE REAL ONE, from `buildTeamOpsApplyDeps`. It is
 *                     a single `db.match.findFirst` — a READ, and the
 *                     shipped selector (`route.ts:3553-3560`). Using the
 *                     real one matters: substituting `SquadState.matchId`
 *                     would make the run pick a different match from
 *                     production, and `team-ops-engine.ts`'s header says
 *                     in terms that the two must never be swapped.
 *   forceConfirm      RECORDER. Never writes. Production would flip an
 *                     `Attendance` row to CONFIRMED inside a transaction
 *                     with an `AttendanceEvent`; here the call is logged
 *                     and the proposal printed.
 *   generateTeams     RECORDER. Never writes, and NEVER RUNS THE
 *                     BALANCER. Production would rewrite every
 *                     `TeamAssignment` and return the group post; here
 *                     the call is logged and a clearly-marked synthetic
 *                     post is returned so the shipped reply-shaping
 *                     around it still executes.
 *
 * WHY IT STOPS AT THE DEPS RATHER THAN BEFORE `runTeamOpsBatch`: the
 * interesting half of this route is the OWNERSHIP decision — tagged or
 * not, `generate` or `show` or `swap`, one generate per batch and it is
 * the last one, the write assertion that refuses a foreign write kind.
 * Reimplementing that here to "stop earlier" would mean grading a copy
 * of the rule instead of the rule. Injecting the deps runs the real one
 * and cuts the wire at the only place I/O can happen.
 *
 * A CONSEQUENCE, STATED: because `generateTeams` never runs, the reply
 * printed under `says :` is NOT the group post production would send —
 * only its wrapper. This mode grades the DECISION and the PROPOSED
 * WRITE. Whether the balancer picks good teams is `teams-post.test.ts`'s
 * question, not this file's.
 *
 * If you ever need the real post, that is a different script and it
 * needs a test org, not `ORG_GROUP` pointed at a customer.
 * ═══════════════════════════════════════════════════════════════════════
 */
async function runTeams(orgId: string, state: SquadState, now: Date): Promise<void> {
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1));
  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const selected = TEAM_CASES.filter((c) => !only || only.includes(c.id));
  if (only) {
    const unknown = only.filter((id) => !TEAM_CASES.some((c) => c.id === id));
    if (unknown.length) throw new Error(`ONLY names no such team case: ${unknown.join(", ")}`);
  }
  const features = await getOrgFeatures(orgId);
  const model = anthropicModel();
  const senders = new Map(selected.map((c) => [c.id, memberByName(state.roster, c.who)]));
  // The real, READ-ONLY match selector. Only `selectTeamsMatch` is taken
  // from it; the two writing deps are replaced below.
  const realDeps = buildTeamOpsApplyDeps({ orgId });

  const DRY_RUN_POST =
    "[DRY RUN — the balancer was NOT run and no TeamAssignment row was written. " +
    "In production this is where the real team post would be.]";

  let generated = 0;
  let handedBack = 0;
  let notOwned = 0;
  let mismatched = 0;
  let runs = 0;
  let totalUsd = 0;

  for (const c of selected) {
    const sender = senders.get(c.id)!;
    const tagged = c.tagged ?? true;
    console.log(
      `\n${"─".repeat(72)}\n${c.id}  ${sender.name}${tagged ? " [@tagged]" : " [UNTAGGED]"}: ` +
        `${JSON.stringify(c.body)}\n  expect : ${c.expect} (${c.why})`,
    );

    for (let n = 0; n < repeat; n++) {
      const id = `${c.id}-${n}`;
      const routed = await routeBatch(model, [{ id, authorName: sender.name, body: c.body }]);
      const route: Route = routed.routes[0]?.route ?? "unsure";
      totalUsd += routed.usage?.costUsd ?? 0;

      // Fresh per run: a recorder that accumulated across runs would
      // make run 3 look like it proposed run 1's writes too.
      const forced: Array<{ userId: string; ref: string }> = [];
      const balancerCalls: Array<{
        matchId: string;
        pinnedToTeam: Record<string, "RED" | "YELLOW">;
        teamNames: [string, string] | null;
      }> = [];

      const res = await runTeamOpsBatch({
        orgId,
        now,
        messages: [
          {
            waMessageId: id,
            body: c.body,
            authorName: sender.name,
            senderUserId: sender.userId,
            senderName: sender.name,
            tagged,
            route,
            gated: false,
          },
        ],
        history: HISTORY,
        enabled: new Set<Route>(["balancer"]),
        deps: {
          model,
          // Injected so the whole sweep decides against ONE state read.
          loadState: async () => state,
          loadFeatures: async () => features,
          // READ. The shipped selector, unmodified.
          selectTeamsMatch: realDeps.selectTeamsMatch,
          // RECORDERS. No I/O. See this function's header.
          forceConfirm: async ({ userId, ref }) => {
            forced.push({ userId, ref });
          },
          generateTeams: async (matchId, opts) => {
            balancerCalls.push({
              matchId,
              pinnedToTeam: opts.pinnedToTeam ?? {},
              teamNames: opts.teamNames ?? null,
            });
            return { ok: true, groupPost: DRY_RUN_POST };
          },
        },
      });
      totalUsd += res.cost.usd;
      runs++;

      const outcome = res.outcomes.get(id);
      // The three columns.
      //   GENERATES   owned AND the balancer would have been called
      //   HANDED BACK owned by nobody here, WITH a reason — `show`,
      //               `rename` and `swap` all land here on purpose and
      //               each has another owner or a stated refusal
      //   NOT OWNED   no reason either. Untagged is the designed case;
      //               anything else in this column since §10 step 8 is
      //               a message the group sent and nobody answered.
      const verdict =
        balancerCalls.length > 0
          ? "GENERATES"
          : res.degradations.length > 0 || outcome
            ? "HANDED BACK"
            : "NOT OWNED";
      if (verdict === "GENERATES") generated++;
      else if (verdict === "HANDED BACK") handedBack++;
      else notOwned++;
      if (verdict !== c.expect) mismatched++;

      console.log(
        `  ${repeat > 1 ? `run ${n + 1}/${repeat}  ` : ""}route=${route.padEnd(9)} ` +
          `${verdict}${verdict !== c.expect ? `  ⚠️ expected ${c.expect}` : ""}`,
      );
      if (outcome) {
        console.log(
          `  owned  : intent=${outcome.intent} action=${outcome.action} ` +
            `match=${outcome.matchId ?? "(none)"} generated=${outcome.teamsGenerated} ` +
            `writeFailed=${outcome.writeFailed}`,
        );
        console.log(`  reasons: ${outcome.reasoning}`);
        console.log(`  react  : ${outcome.react ?? "(none)"}`);
      }
      for (const w of balancerCalls) {
        console.log(
          `  WOULD WRITE: generateTeamsForMatch(${w.matchId}, ` +
            `pinned=${JSON.stringify(w.pinnedToTeam)} names=${JSON.stringify(w.teamNames)})`,
        );
      }
      for (const f of forced) {
        console.log(
          `  WOULD WRITE: force-confirm ${nameOf(state, f.userId)} (as "${f.ref}") + AttendanceEvent`,
        );
      }
      if (res.degradations.length) console.log(`  reason : ${res.degradations.join(" | ")}`);
      if (outcome?.reply) {
        console.log(
          `  says   : ${JSON.stringify(outcome.reply.replace(DRY_RUN_POST, "<the real team post>").slice(0, 200))}`,
        );
      }
    }
  }

  console.log(
    `\n${"═".repeat(72)}\n` +
      `${selected.length} team case(s) × ${repeat} = ${runs} run(s).\n` +
      `  GENERATES   ${generated} of ${runs}\n` +
      `  HANDED BACK ${handedBack} of ${runs}  (another owner, or a stated refusal)\n` +
      `  NOT OWNED   ${notOwned} of ${runs}  (silence + one operator note in production)\n` +
      `  verdicts differing from expect: ${mismatched}\n` +
      `Total cost: $${totalUsd.toFixed(4)}. ` +
      `Writes performed: 0 — the apply layer's two writing deps are recorders ` +
      `(see runTeams' header); every "WOULD WRITE" line above is a projection.`,
  );
}

async function main(): Promise<void> {
  const groupId = process.env.ORG_GROUP ?? DEFAULT_GROUP;
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId },
    select: { id: true, name: true },
  });
  if (!org) throw new Error(`no organisation with whatsappGroupId ${groupId}`);

  if (process.env.CHASES === "1") {
    await runChases(groupId);
    await db.$disconnect();
    return;
  }

  const now = new Date();
  const base = await loadSquadState(org.id, now);
  console.log(
    `ORG   : ${org.name}\n` +
      `MATCH : ${base.matchId ?? "(none)"} — ${base.kickoffLabel} at ${base.venue}\n` +
      `STATE : ${describeSquad(base)}\n`,
  );

  if (process.env.QUESTIONS === "1") {
    await runQuestions(org.id, base, now);
    await db.$disconnect();
    return;
  }

  if (process.env.TEAMS === "1") {
    await runTeams(org.id, base, now);
    await db.$disconnect();
    return;
  }

  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1));
  const showFacts = process.env.FACTS === "1" || repeat === 1;
  let totalUsd = 0;
  let unstable = 0;
  let ran = 0;

  // Resolve every sender up front so a stale name fails before any
  // money is spent, not two minutes into a 15-repeat sweep.
  const selected = CASES.filter((c) => !only || only.includes(c.id));
  if (only) {
    const unknown = only.filter((id) => !CASES.some((c) => c.id === id));
    if (unknown.length) throw new Error(`ONLY names no such case: ${unknown.join(", ")}`);
  }
  const senders = new Map(selected.map((c) => [c.id, memberByName(base.roster, c.who)]));

  for (const c of selected) {
    const sender = senders.get(c.id)!;
    /** The acceptance signal: writes + whether the group heard anything. */
    const decisions: string[] = [];
    /** Diagnostics only — an LLM route is a distribution, not a value. */
    const routesSeen: string[] = [];
    // THE CLAUSE PEEL, run exactly where the route runs it: before the
    // router, on the raw body. What goes down the pipeline is the
    // RESIDUAL — the half no fast path claimed.
    const peeled = c.peel ? peelClause(c.body, c.peel) : null;
    const bodyForPipeline = peeled && peeled.residual ? peeled.residual : c.body;
    console.log(
      `\n${"─".repeat(72)}\n${c.id}  ${sender.name}` +
        `${c.tagged ? " [@tagged]" : ""}${c.fullSquad ? " [FULL SQUAD]" : ""}` +
        `: ${JSON.stringify(c.body)}\n  expect : ${c.expect}`,
    );
    if (c.peel) {
      console.log(
        peeled && peeled.residual
          ? `  peel   : took ${JSON.stringify(peeled.consumed)} — the pipeline sees ${JSON.stringify(peeled.residual)}`
          : `  peel   : NO residual (${peeled ? "one clause" : "predicate declined"}) — the pipeline sees the whole body`,
      );
    }

    for (let n = 0; n < repeat; n++) {
      const state = c.fullSquad
        ? fillSquad(
            base,
            c.squadIncludes ?? FULL_SQUAD_INCLUDES,
            c.benched ?? FULL_SQUAD_BENCH,
          )
        : structuredClone(base);
      if (c.alreadyAskedForGuestName) state.guestAskedUserIds = [sender.userId];
      if (c.confirm) forceConfirmed(state, c.confirm);
      let r;
      try {
        r = await runPipeline({
          messages: [
            {
              id: `${c.id}-${n}`,
              body: bodyForPipeline,
              authorName: c.as ?? sender.name,
              senderUserId: sender.userId,
              senderName: c.as ?? sender.name,
              tagged: c.tagged ?? false,
              taggedExplicitly: c.taggedExplicitly ?? c.tagged ?? false,
            },
          ],
          history: HISTORY,
          state,
          now,
        });
      } catch (err) {
        console.log(`  💥 THREW: ${(err as Error).message}`);
        decisions.push("threw");
        routesSeen.push("threw");
        continue;
      }
      ran++;
      totalUsd += r.cost.totalUsd;

      const writes = r.engine.writes.map((w) =>
        w.kind === "attendance"
          ? `${w.status} ${w.name}${w.explicitBench ? " (explicit bench)" : ""} — ${w.reason}`
          : // The lookback is the number a MODEL read out of a sentence
            // and the only thing that can widen a mass DM, so it is
            // printed rather than inferred from the absence of a "clamped
            // to" reason. `null` means the ask named none and
            // `inviteRecentPlayers` uses its default of 5.
            w.kind === "recruit_blast"
            ? `recruit_blast lookback=${w.lookbackMatches ?? "null (default 5)"} — ${w.reason}`
            : `${w.kind} — ${w.reason}`,
      );
      if (repeat > 1) console.log(`  ── run ${n + 1}/${repeat}`);
      console.log(`  route  : ${r.routes[0]?.route ?? "?"}`);
      if (showFacts) {
        const claim = (r.facts[0]?.facts as { claims?: Array<Record<string, unknown>> })?.claims?.[0];
        console.log(
          claim
            ? `  claim  : basis=${claim.basis} contingent=${claim.contingent} ` +
                `conditionOn=${claim.conditionOn} polarity=${claim.polarity} ` +
                `conf=${claim.confidence} -> ${r.engine.writes.length ? "WRITE" : "no write"}`
            : `  facts  : ${JSON.stringify(r.facts[0]?.facts ?? null)}`,
        );
      }
      console.log(`  reasons: ${r.engine.outcomes[0]?.reasons.join(" | ") ?? "(none)"}`);
      console.log(`  writes : ${writes.length ? writes.join(" | ") : "(none)"}`);
      console.log(
        `  says   : ${
          r.composed.utterances.length
            ? r.composed.utterances.map((u) => JSON.stringify(u.text)).join(" | ")
            : "(silent)"
        }`,
      );
      if (r.composed.reacts.length) {
        console.log(`  reacts : ${r.composed.reacts.map((x) => x.emoji).join(" ")}`);
      }
      if (r.degradations.length) {
        console.log(`  DEGRADED: ${r.degradations.map((d) => d.detail).join(" | ")}`);
      }
      if (r.composed.operatorNotes.length) {
        console.log(`  opnotes: ${r.composed.operatorNotes.join(" | ")}`);
      }
      console.log(`  cost   : $${r.cost.totalUsd.toFixed(5)}`);

      // ── TWO SIGNATURES, NOT ONE (2026-09-06) ────────────────────────
      //
      // R3b is why. The router is an LLM at the SDK's default
      // temperature of 1, so its ROUTE for a genuinely ambiguous
      // sentence is a distribution, not a value — "message everyone
      // from the last 50 games" comes back `admin_ops` 13/20,
      // `question` 4/20, `none` 3/20 — and no amount of prompt work
      // makes that a guarantee. Folding the route into one signature
      // meant every such case read UNSTABLE, which said nothing about
      // whether the thing that MATTERS wobbled.
      //
      // What matters is the DECISION: what got written, and whether the
      // group heard anything. That is what a defect is measured in and
      // what a customer sees. R3b's whole fix is that its decision is
      // now invariant ACROSS a route that still is not, and a harness
      // that cannot express that cannot show the fix worked.
      //
      // So: `decisions` is the acceptance signal and drives the
      // UNSTABLE count; `routes` is reported beside it as diagnostics.
      decisions.push(
        JSON.stringify({
          writes: r.engine.writes
            .map((w) => `${w.kind}:${"name" in w ? w.name : ""}:${"status" in w ? w.status : ""}`)
            .sort(),
          spoke: r.composed.utterances.length > 0,
        }),
      );
      routesSeen.push(r.routes[0]?.route ?? "?");
    }

    if (decisions.length > 1) {
      const variants = [...new Set(decisions)];
      const stable = variants.length === 1;
      if (!stable) unstable++;
      console.log(
        `  DECISION : ${stable ? "✅ STABLE" : "⚠️  UNSTABLE"} across ${decisions.length} runs` +
          ` — ${variants.length} distinct outcome(s)`,
      );
      if (!stable) {
        variants
          .map((v) => ({ v, n: decisions.filter((s) => s === v).length }))
          .sort((a, b) => b.n - a.n)
          .forEach(({ v, n }, i) =>
            console.log(`     variant ${i + 1} (${n}/${decisions.length}): ${v}`),
          );
      }
      const spread = [...new Set(routesSeen)]
        .map((rt) => ({ rt, n: routesSeen.filter((x) => x === rt).length }))
        .sort((a, b) => b.n - a.n)
        .map(({ rt, n }) => `${rt} ${n}/${routesSeen.length}`)
        .join(" · ");
      console.log(
        `  ROUTE    : ${new Set(routesSeen).size === 1 ? "one route" : "SPLIT"} — ${spread}`,
      );
    }
  }

  console.log(
    `\n${"═".repeat(72)}\n` +
      `${selected.length} case(s) × ${repeat} = ${ran} run(s). ` +
      `${unstable === 0 ? "No unstable cases." : `⚠️  ${unstable} UNSTABLE case(s).`}\n` +
      `Total cost: $${totalUsd.toFixed(4)}. Writes performed: 0 (this harness cannot write).`,
  );
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
