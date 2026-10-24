/**
 * BEFORE A RECRUIT BLAST FROM THE ATTENDANCE PATH: IS IT THE POOL THAT WAS
 * ASKED FOR? (local player pool L10, manager review of #410).
 *
 * In the players' group the router sends "@Match Time ask the pool for a
 * player" (and "find someone nearby", "from the app", "havuzdan bir oyuncu
 * bul") to `offer`, measured on the dev key 2026-10-24, and the attendance
 * extractor reports a bare `recruit` side request: for a tagged admin that
 * is the recruit blast, a DM to the club's past players. That extractor has
 * no word for where the players come from; the shared admin extractor does
 * (`playersFrom`). So the analyze route asks it once, only for a recruit
 * that came from the attendance path, before the mass DM: the pipeline's
 * own reader of the same words, no new prompt, no phrase matching.
 *
 * Kept free of pool modules (it calls the model; `pool/__tests__/
 * source-guard.test.ts`). A failed call is "not the pool": today's
 * behaviour stands.
 */
import { extractForRoute } from "./pipeline/extractors";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";

export async function recruitWantsPool(args: {
  id: string;
  body: string;
  authorName: string | null;
  now: Date;
  /** Injected in tests only. */
  model?: PipelineModel;
}): Promise<boolean> {
  try {
    const model = args.model ?? extractorStubFromEnv() ?? anthropicModel();
    // Tagged: the engine's recruit gate already required an explicit tag.
    const extracted = await extractForRoute(model, "admin_ops", {
      id: args.id,
      body: args.body,
      authorName: args.authorName,
      tagged: true,
      history: [],
      lastBotPost: null,
      now: args.now,
    });
    const f = extracted.facts;
    return f.kind === "admin" && f.action === "recruit" && f.pool === true;
  } catch (err) {
    console.error(`[recruit-source] ${args.id}: the source could not be read (the recruit stands):`, err instanceof Error ? err.message : "failed");
    return false;
  }
}
