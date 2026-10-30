/**
 * NO CODE READS WHAT A PLAYER MEANT IN THE PLAYERS' GROUP'S FAST PATHS
 * (Kemal, 2026-10-30: "I don't want any string parsing at all").
 *
 * Deleted that day, each replaced by a model reading or by nothing:
 *   - "@Match Time clear the teams" (`isClearTeamsRequest`) and the build
 *     word gate (`isExplicitTeamBuildRequest`): the teams extractor reads
 *     the ask; a build is gated on facts (match day, an @ tag);
 *   - the colour swap (`team-colour-swap.ts`) and "swap A with B"
 *     (`parseSwapNames` in the route): the teams extractor's `swap` facts,
 *     applied by `team-swap-apply.ts`;
 *   - the bench-prompt yes/no allowlist (`bench-prompt-answer.ts`): dead;
 *   - the pasted roster's numbered-list arithmetic
 *     (`decidePastedRosterRegistration`): the squad reader, `place: "players"`;
 *   - the clause splitter (`splitClauses`, `peelClause`) and "DM me";
 *   - the squad-from-list reserves backstop (`parseReservesFromBody`);
 *   - the engine's swap guard regexes (`parseSwapNames`, `parseSwapRequest`,
 *     `SWAP_STOP`, `senderStatesAttendance`, `isSwapParty`): the guard reads
 *     the teams extractor's reading (`EngineMessage.teamsReading`);
 *   - the pasted-roster shape test (`pasted-roster.ts`, `parsePastedRoster`,
 *     `pasted-roster-registration.ts`): the engine clamps a list on the
 *     router's `pasted_list` flag (`clampPastedListFacts`).
 *
 * Pinned by reading the sources: the deleted modules and functions stay
 * gone, the analyze route and the team modules import no text parser, and
 * the new team module splits, matches or tests no text.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { codeOf } from "./hq-squad-paste-no-parsing.source.test";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const ROUTE = "src/app/api/whatsapp/analyze/route.ts";
const TEAM_OPS = "src/lib/team-ops-engine-batch.ts";
const SWAP_APPLY = "src/lib/team-swap-apply.ts";
const TEAM_REQUESTS = "src/lib/team-requests.ts";
const CLAUSE_PEEL = "src/lib/pipeline/clause-peel.ts";
const SQUAD_FROM_LIST = "src/lib/squad-from-list.ts";
const SLOT_SWAP = "src/lib/team-slot-swap.ts";
const ENGINE = "src/lib/pipeline/engine.ts";
const ENGINE_BATCH = "src/lib/attendance-engine-batch.ts";
const DRY_RUN = "src/lib/pipeline/run.ts";

describe("the deleted readers stay deleted", () => {
  it("their modules are gone", () => {
    for (const f of [
      "src/lib/team-colour-swap.ts",
      "src/lib/bench-prompt-answer.ts",
      "src/lib/pasted-roster.ts",
      "src/lib/pasted-roster-registration.ts",
    ]) {
      expect(existsSync(path.join(ROOT, f)), f).toBe(false);
    }
  });

  it("their functions are defined nowhere they were", () => {
    const gone: Array<[string, RegExp]> = [
      [TEAM_REQUESTS, /\bfunction\s+(isExplicitTeamBuildRequest|isClearTeamsRequest)\b/],
      [CLAUSE_PEEL, /\bfunction\s+(splitClauses|peelClause)\b/],
      [SQUAD_FROM_LIST, /\bfunction\s+parseReservesFromBody\b/],
      [SLOT_SWAP, /\b(function\s+(parseSwapNames|parseSwapRequest|senderStatesAttendance|isSwapParty)\b|SWAP_STOP|SENDER_STATEMENT|TR_SWAP)/],
    ];
    for (const [file, re] of gone) expect(codeOf(read(file)), file).not.toMatch(re);
  });
});

describe("the players' group paths import no text parser", () => {
  const PARSER_IMPORT =
    /["'](?:@\/lib|\.\.?)\/(?:lib\/)?(?:team-colour-swap|bench-prompt-answer|pasted-roster|pasted-roster-registration|admin-group-name-list)["']/;
  for (const file of [ROUTE, TEAM_OPS, SWAP_APPLY, ENGINE, ENGINE_BATCH, DRY_RUN]) {
    it(`${file} imports none`, () => {
      expect(read(file)).not.toMatch(PARSER_IMPORT);
    });
  }

  it("the route no longer reads the swap names, the clause or 'DM me' from the words", () => {
    const code = codeOf(read(ROUTE));
    expect(code).not.toMatch(/\b(parseSwapNames|parseSwapRequest|senderStatesAttendance|peelClause|readBenchPromptAnswer|isClearTeamsRequest)\b/);
    expect(code).not.toMatch(/\bDM_ME\b/);
  });

  it("the team-ops batch no longer gates a build on the words", () => {
    expect(codeOf(read(TEAM_OPS))).not.toMatch(/isExplicitTeamBuildRequest/);
  });

  it("the swap apply layer and the trimmed modules split, match or test no text", () => {
    for (const file of [SWAP_APPLY, TEAM_REQUESTS, CLAUSE_PEEL]) {
      expect(codeOf(read(file)), file).not.toMatch(/\.(split|match|matchAll|test|search)\(|\bRegExp\b/);
    }
  });

  it("a pasted list in the players' group is read by the squad reader", () => {
    const code = read(ROUTE);
    expect(code).toMatch(/readHqSquadMessage\(/);
    expect(code).toMatch(/place:\s*"players"/);
  });
});

describe("the attendance engine reads facts for a swap and a pasted list", () => {
  it("the swap guard is asked with the teams extractor's reading, never the body", () => {
    const code = codeOf(read(ENGINE));
    expect(code).toMatch(/swapGuardFor\(m\.teamsReading/);
    expect(code).not.toMatch(/swapGuardFor\([^)]*\.body/);
  });

  it("the pasted-list clamp is asked of the router's flag, never the body", () => {
    for (const file of [ENGINE_BATCH, DRY_RUN]) {
      const code = codeOf(read(file));
      expect(code, file).toMatch(/clampPastedListFacts\(/);
      expect(code, file).not.toMatch(/clampPastedListFacts\([^)]*body/);
      expect(code, file).not.toMatch(/\b(parsePastedRoster|isPastedRoster|clampPastedRosterFacts)\b/);
    }
  });
});
