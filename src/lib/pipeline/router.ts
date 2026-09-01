/**
 * STAGE 1 — THE ROUTER.
 *
 * One cheap call per batch. One route per message id. Banter exits here
 * and costs nothing further: 69% of real traffic (1,194 of 1,723
 * production messages) is noise, and today every one of those costs
 * ~160 output tokens for the model to conclude that a laughing emoji is
 * a laughing emoji (§4.2).
 *
 * §11.1 CALLS ROUTER MISCLASSIFICATION THE BIGGEST RISK IN THE DESIGN,
 * and a genuine regression: a message routed `none` disappears with no
 * write, no reply, no reaction and no signal, where today's mega-call at
 * least emits something for every message. Three of the four
 * containments it specifies live in this file:
 *
 *   1. BIAS TOWARD ACTION. In the prompt, and again in the parser: a
 *      missing id becomes `unsure` (which reaches an extractor), never
 *      `none`. A false positive costs ~$0.002. A false negative costs a
 *      player their slot.
 *   2. A DETERMINISTIC FLOOR. `routeFloor` force-routes bare IN/OUT/+1
 *      whatever the model says. ⚠️ §11.1 corrects its own first draft
 *      here: the old regex fast path CANNOT serve as this floor, because
 *      it was deleted on 2026-04-21 and `handlers.ts:7-10` records that
 *      "Kemal explicitly asked for this". So the floor is BUILT NEW and
 *      kept deliberately tiny, and reintroducing one at all is a product
 *      decision that needs his sign-off before step 5 ships.
 *   3. FAIL OPEN, NOT CLOSED. Router error → everything routes to the
 *      attendance extractor (§11.4). Expensive, correct, self-limiting.
 *
 * The fourth containment — shadowing the `none` bucket forever — belongs
 * to the harness, not here.
 */
import {
  anthropicModel,
  degradation,
  extractJson,
  ROUTER_MODEL,
  type ModelRequest,
  type PipelineModel,
} from "./llm";
import type { Degradation, Route, RoutedMessage } from "./types";

/** Small on purpose: its size is the argument (§6.1). */
export const ROUTER_SYSTEM_PROMPT = `You classify WhatsApp messages from a football club group. For EVERY message id you are given, return exactly one route.

none        banter, jokes, memes, links, emoji, greetings, off-topic chat
self_att    the SENDER is joining or leaving THIS match themselves
other_att   the message adds, drops, benches, swaps or replaces SOMEONE ELSE
offer       a contingent or tentative commitment by anyone ("if you're short", "if my back holds up")
question    a question the bot could answer
balancer    asks the bot to generate, show, shuffle or rename the two teams
score       reports a final result
admin_ops   payment credit, reminder request, other bot admin instruction
unsure      attendance-shaped but you genuinely cannot tell

Rules:
1. Route on what a message DOES, not what it is about. "Great game last night" is none.
2. A completed join stated about someone else IS other_att ("Ayoub snatched that spot").
3. A relayed commitment IS other_att ("Najib said in as well").
4. Moving, benching or swapping a NAMED PLAYER is other_att, never balancer. balancer is only about the two team line-ups as a whole.
5. When in doubt between none and anything else, choose the other route.

Return JSON only: {"routes":[{"id":"<id>","route":"<route>"}]}`;

const ROUTER_MAX_TOKENS = 1_024;

const VALID: Record<string, Route> = {
  none: "none",
  self_att: "self_att",
  other_att: "other_att",
  offer: "offer",
  question: "question",
  balancer: "balancer",
  score: "score",
  admin_ops: "admin_ops",
  unsure: "unsure",
  // Aliases. §6.1's unfixed prototype failure was "move Mustafa to the
  // bench" routing `team_ops` 3/3 because "bench" reads as team-shaped
  // vocabulary; the doc's own remedy is to rename it and add a lineup
  // route. `lineup_ops` collapses to `other_att` so the engine never
  // grows a second attendance path with its own capacity rules.
  lineup_ops: "other_att",
  team_ops: "balancer",
};

export function normaliseRoute(raw: string): Route | null {
  return VALID[(raw ?? "").trim().toLowerCase()] ?? null;
}

/**
 * THE DETERMINISTIC FLOOR. Twenty lines, anchored at both ends, and it
 * only ever claims a message that is ENTIRELY a bare self-attendance
 * token. "Zeeshan is out 😂" and "I was in last week" must not match, so
 * everything except the token, optional punctuation and an emoji is a
 * disqualifier.
 */
const FLOOR_IN = /^(?:i\s*'?a?m|i\s+am|im)?\s*\+?\s*(?:in|innn+)\b/i;
const FLOOR_OUT = /^(?:i\s*'?a?m|i\s+am|im)?\s*(?:out|can'?t\s+make\s+it)\b/i;
const FLOOR_PLUS = /^\+\s*[1-5]\b/;
/** Anything left after the token that is not punctuation or an emoji
 *  means this is a sentence, not a bare declaration. */
const FLOOR_TAIL = /^[\s\p{P}\p{S}]*$/u;

export function routeFloor(body: string): Route | null {
  const t = (body ?? "").trim();
  if (!t || t.length > 24) return null;
  for (const re of [FLOOR_PLUS, FLOOR_IN, FLOOR_OUT]) {
    const m = re.exec(t);
    if (!m) continue;
    if (!FLOOR_TAIL.test(t.slice(m[0].length))) return null;
    return "self_att";
  }
  return null;
}

export interface RouterMessage {
  id: string;
  authorName: string | null;
  body: string;
}

export interface RouterResult {
  routes: RoutedMessage[];
  degradations: Degradation[];
  usage?: { costUsd: number | null; ms: number; inputTokens: number; outputTokens: number };
}

export function parseRouterResponse(text: string, ids: string[]): RouterResult {
  const degradations: Degradation[] = [];
  const byId = new Map<string, Route>();

  try {
    const parsed = extractJson(text) as { routes?: Array<{ id?: unknown; route?: unknown }> };
    const rows = Array.isArray(parsed?.routes) ? parsed.routes : [];
    for (const row of rows) {
      const id = typeof row?.id === "string" ? row.id : null;
      const route = typeof row?.route === "string" ? normaliseRoute(row.route) : null;
      if (!id) continue;
      if (!ids.includes(id)) {
        degradations.push(
          degradation("router", null, `router returned an unknown id "${id}"; dropped`),
        );
        continue;
      }
      if (!route) {
        degradations.push(
          degradation("router", id, `router returned an unknown route "${String(row.route)}"`),
        );
        continue;
      }
      byId.set(id, route);
    }
  } catch (err) {
    degradations.push(
      degradation("router", null, `router output could not be parsed: ${(err as Error).message}`),
    );
  }

  const routes: RoutedMessage[] = ids.map((id) => {
    const route = byId.get(id);
    if (route) return { messageId: id, route, source: "model" as const };
    // §3.2 S1's incident, and §11.1's asymmetry. A missing route is a
    // coverage hole; filling it with `none` would make that hole look
    // like a decision.
    degradations.push(degradation("router", id, `router returned no route; defaulting to unsure`));
    return { messageId: id, route: "unsure" as const, source: "fallback" as const };
  });

  return { routes, degradations };
}

export async function routeBatch(
  model: PipelineModel,
  messages: RouterMessage[],
): Promise<RouterResult> {
  if (messages.length === 0) return { routes: [], degradations: [] };

  const floor = new Map<string, Route>();
  for (const m of messages) {
    const f = routeFloor(m.body);
    if (f) floor.set(m.id, f);
  }

  // Every message hit the floor: there is nothing left to ask about, so
  // the batch costs nothing at all.
  if (floor.size === messages.length) {
    return {
      routes: messages.map((m) => ({
        messageId: m.id,
        route: floor.get(m.id)!,
        source: "floor" as const,
      })),
      degradations: [],
    };
  }

  const ids = messages.map((m) => m.id);
  const user = messages
    .map((m) => `[${m.id}] ${m.authorName ?? "(unknown)"}: ${m.body}`)
    .join("\n");

  const req: ModelRequest = {
    model: ROUTER_MODEL,
    system: ROUTER_SYSTEM_PROMPT,
    user,
    maxTokens: ROUTER_MAX_TOKENS,
    label: "router",
    schema: {
      type: "object",
      properties: {
        routes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              route: { type: "string", enum: Object.keys(VALID) },
            },
            required: ["id", "route"],
            additionalProperties: false,
          },
        },
      },
      required: ["routes"],
      additionalProperties: false,
    },
  };

  let result: RouterResult;
  let usage: RouterResult["usage"];
  try {
    const resp = await model.complete(req);
    result = parseRouterResponse(resp.text, ids);
    usage = {
      costUsd: resp.costUsd,
      ms: resp.ms,
      inputTokens: resp.usage.inputTokens + resp.usage.cacheReadTokens,
      outputTokens: resp.usage.outputTokens,
    };
  } catch (err) {
    // §11.4: on router failure, route EVERYTHING to the attendance
    // extractor. Expensive, correct, and self-limiting because batches
    // are small. The alternative — routing everything to `none` — is
    // the silent failure this whole design exists to remove.
    result = {
      routes: ids.map((id) => ({ messageId: id, route: "unsure" as const, source: "fallback" as const })),
      degradations: [
        degradation(
          "router",
          null,
          `router call failed (${(err as Error).message}); routing the whole batch to the extractor`,
        ),
      ],
    };
  }

  // The floor OVERRIDES the model, in both directions.
  const routes = result.routes.map((r) => {
    const f = floor.get(r.messageId);
    if (!f || f === r.route) return r;
    result.degradations.push(
      degradation(
        "router",
        r.messageId,
        `the floor overrode the router: ${r.route} → ${f} (bare self-attendance)`,
      ),
    );
    return { ...r, route: f, source: "floor" as const };
  });

  return { routes, degradations: result.degradations, usage };
}

/** Convenience for callers that do not inject a model. */
export function defaultRouterModel(): PipelineModel {
  return anthropicModel();
}
