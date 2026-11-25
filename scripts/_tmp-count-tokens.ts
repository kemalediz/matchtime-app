// Temporary: real token counts for the changed prompts (deleted before the PR).
import Anthropic from "@anthropic-ai/sdk";
import { ROUTER_SYSTEM_PROMPT } from "../src/lib/pipeline/router.ts";
import { EXTRACTOR_PROMPTS } from "../src/lib/pipeline/extractors.ts";
import { ROUTER_MODEL, EXTRACTOR_MODEL } from "../src/lib/pipeline/llm.ts";

async function main() {
  const c = new Anthropic();
  for (const [label, model, text] of [
    ["router", ROUTER_MODEL, ROUTER_SYSTEM_PROMPT],
    ["teams", EXTRACTOR_MODEL, EXTRACTOR_PROMPTS.teams],
  ] as const) {
    const r = await c.messages.countTokens({
      model,
      system: text,
      messages: [{ role: "user", content: "x" }],
    });
    console.log(label, model, "chars", text.length, "tokens", r.input_tokens);
  }
}
main();
