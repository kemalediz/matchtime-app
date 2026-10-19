/**
 * PICTURE READING: THE PAID CHECK. EVERY RUN NEEDS KEMAL'S APPROVAL.
 *
 * The picture prompt (src/lib/picture-prompt.ts) is new. The unit and e2e
 * tests stub the model; they prove the wiring, the filter and the caps,
 * not that Haiku reads a real poster. This does: each picture ONCE,
 * through the exact prompt, model and transcript formatting production
 * uses (`formatTranscript`). PICTURE_READING_ENABLED stays off until a run
 * has passed and Kemal has seen it.
 *
 * Proposed set (4 calls, about 2 cents in all): the two FNF posters Kemal
 * provides, one meme, one screenshot of bank details. Name each file by
 * what it should come back as:
 *
 *   poster-*.jpg   "[Picture] Poster: ..."  (names, date, time, venue)
 *   teams-*.jpg    "[Picture] Team sheet: ..."
 *   meme-*.jpg     no transcript ("Not about the game")
 *   bank-*.jpg     no transcript, and no run of 6+ digits in any case
 *
 *   # Free: what the run WOULD cost, no model call.
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-picture-reading.ts --estimate pics/*.jpg
 *
 *   # The approved run (spends ANTHROPIC_API_KEY_DEV, never the production key):
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-picture-reading.ts --approved pics/*.jpg
 *
 * Touches no database, sends nothing, stops at MAX_USD. Prints each raw
 * answer (it is the person checking who must see the text) and the call
 * count, tokens and cost. The pictures are read from disk where Kemal put
 * them and are not copied anywhere.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, costOf } from "../src/lib/pipeline/llm.ts";
import {
  PICTURE_READING_MAX_TOKENS,
  PICTURE_READING_MODEL,
  PICTURE_READING_SYSTEM_PROMPT,
  PICTURE_READING_USER_TEXT,
} from "../src/lib/picture-prompt.ts";
import { formatTranscript, MAX_PICTURE_BYTES } from "../src/lib/picture-reading.ts";

const MAX_USD = 0.1;
/** The API scales a picture to at most ~1.15 megapixels: about 1,600 tokens. */
const EST_IMAGE_TOKENS = 1_600;
const EST_OUTPUT_TOKENS = 300;

type Kind = "poster" | "teams" | "meme" | "bank";

function kindOf(file: string): Kind | null {
  const m = /^(poster|teams|meme|bank)/i.exec(path.basename(file));
  return m ? (m[1].toLowerCase() as Kind) : null;
}

function mediaTypeOf(file: string): "image/jpeg" | "image/png" | "image/webp" | null {
  const ext = path.extname(file).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : null;
}

function grade(kind: Kind, transcript: string | null): string | null {
  if (kind === "poster") return transcript?.startsWith("[Picture] Poster:") ? null : "expected a Poster transcript";
  if (kind === "teams") return transcript?.startsWith("[Picture] Team sheet:") ? null : "expected a Team sheet transcript";
  if (kind === "meme") return transcript === null ? null : "expected Not about the game";
  if (transcript !== null) return /\d{6,}/.test(transcript) ? "copied a long number from a bank screenshot" : "expected Not about the game";
  return null;
}

async function main() {
  const estimateOnly = process.argv.includes("--estimate");
  const approved = process.argv.includes("--approved");
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    console.error("Give the picture files: poster-*.jpg, teams-*.jpg, meme-*.jpg, bank-*.jpg");
    process.exit(1);
  }
  const promptTokens = Math.ceil((PICTURE_READING_SYSTEM_PROMPT.length + PICTURE_READING_USER_TEXT.length) / 3.5);
  const each =
    costOf(PICTURE_READING_MODEL, {
      inputTokens: promptTokens + EST_IMAGE_TOKENS,
      outputTokens: EST_OUTPUT_TOKENS,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }) ?? 0;
  console.log(
    `Model ${PICTURE_READING_MODEL}; prompt ~${promptTokens} tokens + <= ${EST_IMAGE_TOKENS} per picture, <= ${EST_OUTPUT_TOKENS} out.\n` +
      `Estimate: ${files.length} model calls, ~$${(each * files.length).toFixed(4)} (cap $${MAX_USD}).`,
  );
  if (estimateOnly) return;
  if (!approved) {
    console.error("\nRefusing to call the model without --approved (Kemal's approval for this run, CLAUDE.md).\n");
    process.exit(1);
  }

  spendDevApiKeyOrExit("live-check-picture-reading");
  const model = anthropicModel();
  let calls = 0;
  let spent = 0;
  const failures: string[] = [];
  for (const file of files) {
    const kind = kindOf(file);
    const mediaType = mediaTypeOf(file);
    const name = path.basename(file);
    if (!kind || !mediaType) {
      console.log(`\n━━ ${name}: skipped (name it poster-, teams-, meme- or bank-; jpg, png or webp)`);
      continue;
    }
    const bytes = readFileSync(file);
    if (bytes.length > MAX_PICTURE_BYTES) {
      console.log(`\n━━ ${name}: skipped, ${bytes.length} bytes is over the ${MAX_PICTURE_BYTES} the route takes (the Pi shrinks first)`);
      continue;
    }
    if (spent >= MAX_USD) {
      console.log(`stopped: $${spent.toFixed(4)} spent, cap $${MAX_USD}`);
      break;
    }
    calls++;
    const resp = await model.complete({
      model: PICTURE_READING_MODEL,
      system: PICTURE_READING_SYSTEM_PROMPT,
      user: PICTURE_READING_USER_TEXT,
      maxTokens: PICTURE_READING_MAX_TOKENS,
      thinking: "off", // as production (picture-reading.ts)
      label: "picture-reading-live-check",
      images: [{ mediaType, data: bytes.toString("base64") }],
    });
    spent += resp.costUsd ?? 0;
    const transcript = formatTranscript(resp.text);
    const problem = grade(kind, transcript);
    if (problem) failures.push(`${name}: ${problem}`);
    console.log(`\n━━ ${name} (${kind}, ${bytes.length} bytes) ━━`);
    console.log(`  ${resp.usage.inputTokens} in / ${resp.usage.outputTokens} out, $${(resp.costUsd ?? 0).toFixed(4)}, ${resp.ms} ms`);
    console.log(`  raw:\n${resp.text.replace(/^/gm, "    ")}`);
    console.log(`  ${problem ? `FAIL: ${problem}` : "PASS"}`);
  }
  console.log(`\n${calls} model calls, $${spent.toFixed(4)}. ${failures.length ? `FAILED:\n  ${failures.join("\n  ")}` : "All passed."}`);
  if (failures.length) process.exit(1);
}

void main();
