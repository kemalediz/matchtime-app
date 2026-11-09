/**
 * TEST SUPPORT: `decide()` with who-is-who's picks filled in by the
 * stand-in (`stubPicks`, a name-based stand-in for the model on the cases a
 * test means plainly: a member's whole name, alias or first name for one
 * member). Production never looks a name up by spelling: the batches ask
 * the model (`identify-batch.ts`). The engine tests predate that step and
 * mean "Tom" to be Tom, so they run through this; a test that sets
 * `people` on a message itself keeps exactly what it set.
 */
import { decide as realDecide, isSelfRef } from "../../engine";
import { factRefs } from "../../identify-batch";
import { stubPicks, whoRosterOf, type PersonPick } from "../../who-is-who";
import type { EngineInput, EngineMessage, EngineResult } from "../../types";

export * from "../../engine";

/** Every message with `people` from the stand-in, unless it has its own. */
export function withStubPeople(input: EngineInput): EngineInput {
  const roster = whoRosterOf(input.state.roster);
  const messages: EngineMessage[] = input.messages.map((m) => {
    if (m.people) return m;
    const refs = factRefs(m.facts, m.teamsReading ?? null, input.state.lastBotPost).filter((r) => !isSelfRef(r));
    if (refs.length === 0) return m;
    const picks = stubPicks({ roster, messages: [{ id: m.id, body: m.body, author: null, refs }] }).get(m.id);
    return picks ? { ...m, people: picks as ReadonlyMap<string, PersonPick> } : m;
  });
  return { ...input, messages };
}

export function decide(input: EngineInput): EngineResult {
  return realDecide(withStubPeople(input));
}
