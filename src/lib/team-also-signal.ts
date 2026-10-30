/**
 * WHICH ATTENDANCE MESSAGES ALSO ASK FOR A TEAM CHANGE (2026-10-30).
 *
 * "@Match Time swap X with Y, and I'm out": one message, one route. When
 * the router sends it to attendance, the attendance engine applies the
 * sender's OUT, and the swap half must not be lost. The attendance
 * extractor says so (a "teams" side request, P1 of the "no string parsing"
 * sweep), the engine reports it on its outcome, and the analyze route hands
 * those ids to `runTeamOpsBatch({ alsoTeams })`, which reads the swap with
 * the teams extractor and adds its line to the engine's one reply. Same
 * shape as "I'm out, what's the list?" (`alsoAsksQuestion`).
 *
 * THE SEAM. Until P1's field exists nothing sets it and this returns no
 * ids. When it lands, only `engineSaysAlsoTeams` changes. The e2e suite
 * flags messages through `MT_TEST_TEAM_ALSO_STUB_FILE` (ids or bodies).
 */
import { readFileSync } from "node:fs";

export const TEAM_ALSO_STUB_FILE_ENV = "MT_TEST_TEAM_ALSO_STUB_FILE";

/** PURE. TODO(P1): the field name is confirmed when P1 lands. */
export function engineSaysAlsoTeams(outcome: Record<string, unknown> | undefined): boolean {
  return outcome?.alsoChangesTeams === true;
}

export function alsoTeamsIds(
  messages: Array<{ waMessageId: string; body: string }>,
  outcomes: Iterable<{ waMessageId: string }>,
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const out = new Set<string>();
  for (const o of outcomes) if (engineSaysAlsoTeams(o as unknown as Record<string, unknown>)) out.add(o.waMessageId);
  const file = env[TEAM_ALSO_STUB_FILE_ENV];
  if (file) {
    let stub: { ids?: string[]; bodies?: string[] } = {};
    try {
      stub = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      stub = {};
    }
    for (const m of messages) {
      if ((stub.ids ?? []).includes(m.waMessageId) || (stub.bodies ?? []).includes(m.body.trim())) out.add(m.waMessageId);
    }
  }
  return out;
}
