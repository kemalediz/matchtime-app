/**
 * THE PICK READER (2026-10-30): one model call for an organiser's reply to
 * MatchTime's numbered bench list, from HQ or a DM. It says whether the
 * reply picks (list numbers, people), takes ALL or NONE, says YES to a
 * waiting question, or is something else. The prompt, schema and checks
 * are in `organiser-pick-reader-prompt.ts`; `handlePickReply` in
 * `organiser-pick.ts` acts on the checked answer.
 *
 * One Haiku call (`HAIKU_CALL`, under the club's AI budget like every
 * pipeline call). FAIL SAFE: no key, a failed call, the cap or an
 * unreadable answer is "not a pick", so HQ does nothing and a DM falls
 * through to its other handlers. It never invents a player: a person is
 * only ever a ref it was shown.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./pipeline/llm";
import {
  buildPickReaderUserTurn,
  parsePickReading,
  PICK_READER_SCHEMA,
  PICK_READER_SYSTEM,
  type PickReaderContext,
  type PickReaderInput,
  type PickReply,
} from "./organiser-pick-reader-prompt";

export type { PickReaderContext, PickReaderInput, PickReaderPerson, PickReply } from "./organiser-pick-reader-prompt";

/** Pinned. Exported for the dry run. */
export const PICK_READER_CALL: ModelCall = HAIKU_CALL;
const LABEL = "organiser-pick-reader";
/** A short answer, with Haiku's thinking. */
const MAX_TOKENS = 2_048;

type Budget = <T>(orgId: string, fn: () => Promise<T>) => Promise<T>;
const orgBudget: Budget = async (orgId, fn) => (await import("./ai-budget")).withOrgAiBudget(orgId, fn);

// ── The e2e stub ──────────────────────────────────────────────────────

/**
 * TEST-ONLY seam, as the other model steps have: what the model would have
 * said, read from a file the e2e suite writes, by the trimmed message body.
 * A body with no answer is "other" (not a pick). In a stub answer, `people`
 * and `candidates` may name a person by name as well as by ref (a spec
 * cannot know the refs the server gives): the stub turns those names into
 * refs, exactly, before the production check reads the answer.
 * `e2e/helpers/live-llm.ts` refuses a live run that can still see the file.
 */
export const PICK_READER_STUB_FILE_ENV = "MT_TEST_ORGANISER_PICK_READER_STUB_FILE";

interface ReaderStub {
  bodies?: Record<string, unknown>;
  fail?: string[];
}

function refsByName(answer: unknown, ctx: PickReaderContext): unknown {
  if (!answer || typeof answer !== "object") return answer;
  const everyone = [...ctx.list, ...ctx.confirmed, ...ctx.others];
  const refOf = (v: unknown) => (typeof v === "string" ? (everyone.find((p) => p.ref === v || p.name === v)?.ref ?? v) : v);
  const o = answer as Record<string, unknown>;
  return {
    kind: "other",
    positions: [],
    people: [],
    name: "",
    candidates: [],
    ...o,
    ...(Array.isArray(o.people) ? { people: o.people.map(refOf) } : {}),
    ...(Array.isArray(o.candidates) ? { candidates: o.candidates.map(refOf) } : {}),
  };
}

function readFromStub(file: string, input: PickReaderInput, ctx: PickReaderContext): PickReply {
  let cfg: ReaderStub = {};
  try {
    cfg = JSON.parse(readFileSync(file, "utf8")) as ReaderStub;
  } catch {
    cfg = {};
  }
  try {
    appendFileSync(`${file}.calls`, `${JSON.stringify({ label: LABEL, user: buildPickReaderUserTurn(input, ctx) })}\n`);
  } catch {
    // Recording is for the spec only.
  }
  const body = input.body.trim();
  if ((cfg.fail ?? []).includes(body)) throw new Error(`${LABEL} stub: forced failure`);
  const answer = cfg.bodies?.[body];
  return answer === undefined ? { kind: "not-a-pick" } : parsePickReading(refsByName(answer, ctx), input, ctx);
}

function defaultModel(): PipelineModel | null {
  return process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null;
}

/**
 * Read one reply to a pick round, once. `deps.model` undefined uses the
 * real model (or the e2e stub), null asserts there is none. Never throws.
 */
export async function readPickReply(
  input: PickReaderInput,
  ctx: PickReaderContext,
  deps?: { model?: PipelineModel | null; budget?: Budget },
): Promise<PickReply> {
  if (!input.body?.trim()) return { kind: "not-a-pick" };
  let reply: PickReply;
  try {
    const stubFile = deps?.model === undefined ? process.env[PICK_READER_STUB_FILE_ENV] : undefined;
    if (stubFile) {
      reply = readFromStub(stubFile, input, ctx);
    } else {
      const model = deps?.model === undefined ? defaultModel() : deps.model;
      if (!model) return { kind: "not-a-pick" };
      const resp = await (deps?.budget ?? orgBudget)(ctx.orgId, () =>
        model.complete({
          ...PICK_READER_CALL,
          system: PICK_READER_SYSTEM,
          user: buildPickReaderUserTurn(input, ctx),
          maxTokens: MAX_TOKENS,
          schema: PICK_READER_SCHEMA as unknown as Record<string, unknown>,
          label: LABEL,
        }),
      );
      reply = parsePickReading(extractJson(resp.text), input, ctx);
    }
  } catch (err) {
    // FAIL SAFE: nothing is read, so nothing is picked.
    console.error(`[${LABEL}] read failed:`, err instanceof Error ? err.message : "failed");
    return { kind: "not-a-pick" };
  }
  console.info(`[${LABEL}] org=${ctx.orgId} door=${ctx.door} kind=${reply.kind}`);
  return reply;
}
