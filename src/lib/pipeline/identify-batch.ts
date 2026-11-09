/**
 * THE WHO-IS-WHO STEP OF A BATCH (2026-11-09): after the extractors and
 * before anything resolves a name, every name the batch's facts quote is
 * put to the model in ONE call (`who-is-who.ts`), and each message
 * carries its answers (`EngineMessage.people`). A batch that quotes no
 * name makes no call. Shared by every batch that runs the engine, so the
 * players' group, HQ and the dry run look names up the same way.
 */
import { extractorStubFromEnv } from "./extractor-stub";
import { anthropicModel, type PipelineModel } from "./llm";
import { isSelfRef, parsePendingSet } from "./engine";
import type { EngineMessage, Facts, Member, TeamFacts } from "./types";
import {
  modelPersonPicker,
  PERSON_PICKER_STUB_ENV,
  personRefsIn,
  refKey,
  stubPersonPicker,
  whoRosterOf,
  type PersonPick,
  type PersonPicker,
  type PersonPicks,
} from "./who-is-who";

/**
 * Which picker a batch uses: the one it was given (tests), the stand-in
 * when the extractor stub seam is set (the stubbed e2e suite, never
 * production), otherwise the real model.
 */
export function personPickerFor(deps: { identify?: PersonPicker; model?: PipelineModel } = {}): PersonPicker {
  if (deps.identify) return deps.identify;
  if (process.env[PERSON_PICKER_STUB_ENV] === "1" || extractorStubFromEnv()) return stubPersonPicker();
  return modelPersonPicker(deps.model ?? anthropicModel());
}

/** One message to look names up for. */
export interface IdentifyItem {
  id: string;
  body: string;
  author: string | null;
  senderUserId: string | null;
  facts: Facts;
  teamsReading?: TeamFacts | "unreadable" | null;
  /** Names the caller already knows (HQ's squad reader picked them):
   *  not asked again. */
  known?: PersonPicks | null;
}

export interface Identified {
  /** message id → its picks (known ones included). */
  people: Map<string, PersonPicks>;
  costUsd: number;
  calls: number;
  degradations: string[];
}

/**
 * The names a message's facts (and its teams reading) quote. A bare
 * "Confirmed" (no claims, affirmation "yes") is about the names in
 * MatchTime's own last pending list (§3.2 S25, `parsePendingSet`), so
 * those are asked too: the engine resolves them like any other name.
 */
export function factRefs(
  facts: Facts,
  teamsReading?: TeamFacts | "unreadable" | null,
  lastBotPost?: string | null,
): string[] {
  const refs = personRefsIn(facts, isSelfRef);
  if (teamsReading && teamsReading !== "unreadable") refs.push(...personRefsIn(teamsReading, isSelfRef));
  if (facts.kind === "attendance" && facts.claims.length === 0 && facts.affirmation === "yes") {
    refs.push(...parsePendingSet(lastBotPost ?? null).map(refKey).filter(Boolean));
  }
  return [...new Set(refs)];
}

/** Never throws: a failed call leaves those names unidentified, which
 *  resolves nobody. */
export async function identifyFacts(args: {
  picker: PersonPicker;
  items: IdentifyItem[];
  roster: ReadonlyArray<Member>;
  where?: string;
  /** MatchTime's last post, for a bare "Confirmed" (`factRefs`). */
  lastBotPost?: string | null;
}): Promise<Identified> {
  const people = new Map<string, PersonPicks>();
  const asked: Array<{ item: IdentifyItem; refs: string[] }> = [];
  for (const item of args.items) {
    const known = item.known ?? new Map<string, PersonPick>();
    if (known.size > 0) people.set(item.id, known);
    const refs = factRefs(item.facts, item.teamsReading, args.lastBotPost).filter((r) => !known.has(r));
    if (refs.length > 0) asked.push({ item, refs });
  }
  if (asked.length === 0) return { people, costUsd: 0, calls: 0, degradations: [] };
  const res = await args.picker({
    roster: whoRosterOf(args.roster),
    where: args.where,
    messages: asked.map(({ item, refs }) => ({
      id: item.id,
      body: item.body,
      author: item.author,
      senderUserId: item.senderUserId,
      refs,
    })),
  });
  for (const [id, picks] of res.picks) {
    people.set(id, new Map([...(people.get(id) ?? new Map()), ...picks]));
  }
  return { people, costUsd: res.usage?.costUsd ?? 0, calls: res.usage ? 1 : 0, degradations: res.degradations };
}

/**
 * ONE MESSAGE'S NAMES, for a caller outside the engine (HQ's fee waiver
 * and Man of the Match): the names as quoted, the message they came from,
 * and the members they may be (the match's players, the squad). One call;
 * none when there is no name. Never throws.
 */
export async function identifyRefs(args: {
  picker: PersonPicker;
  refs: string[];
  body: string;
  author: string | null;
  senderUserId: string | null;
  roster: ReadonlyArray<Member>;
  where?: string;
}): Promise<{ people: PersonPicks; costUsd: number; calls: number; degradations: string[] }> {
  const refs = [...new Set(args.refs.map((r) => r.trim()).filter((r) => r && !isSelfRef(r)))];
  if (refs.length === 0) return { people: new Map(), costUsd: 0, calls: 0, degradations: [] };
  const id = "m";
  const res = await args.picker({
    roster: whoRosterOf(args.roster),
    where: args.where,
    messages: [{ id, body: args.body, author: args.author, senderUserId: args.senderUserId, refs }],
  });
  for (const d of res.degradations) console.warn(`[who-is-who] ${d}`);
  return {
    people: res.picks.get(id) ?? new Map(),
    costUsd: res.usage?.costUsd ?? 0,
    calls: res.usage ? 1 : 0,
    degradations: res.degradations,
  };
}

/** `identifyFacts` over engine messages: each comes back with `people`
 *  set when it quotes a name (or already had some). */
export async function identifyPeople(args: {
  picker: PersonPicker;
  messages: EngineMessage[];
  roster: ReadonlyArray<Member>;
  where?: string;
  lastBotPost?: string | null;
}): Promise<{ messages: EngineMessage[]; costUsd: number; calls: number; degradations: string[] }> {
  const res = await identifyFacts({
    picker: args.picker,
    roster: args.roster,
    where: args.where,
    lastBotPost: args.lastBotPost,
    items: args.messages.map((m) => ({
      id: m.id,
      body: m.body,
      author: m.senderName ?? null,
      senderUserId: m.senderUserId,
      facts: m.facts,
      teamsReading: m.teamsReading ?? null,
      known: m.people ?? null,
    })),
  });
  const messages = args.messages.map((m) => {
    const p = res.people.get(m.id);
    return p ? { ...m, people: p } : m;
  });
  return { messages, costUsd: res.costUsd, calls: res.calls, degradations: res.degradations };
}
