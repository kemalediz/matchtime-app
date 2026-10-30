/**
 * LIVE dry run for the pick reader (2026-10-30): an organiser's reply to
 * MatchTime's numbered bench list, read by a model (`organiser-pick-reader.ts`)
 * since Kemal's "I don't want any string parsing at all". The unit and e2e
 * tests stub the model; only the real model proves it reads "2 3", "1-3",
 * "all", "hiçbiri", a first name, an @tag, YES with and without a waiting
 * question, and chat that is not a pick. Each case ONCE, through the exact
 * production call and checks (`readPickReply`).
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-organiser-pick-reader.ts [--first]
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Hard stop at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { readPickReply, type PickReaderContext, type PickReply } from "../src/lib/organiser-pick-reader.ts";

const MAX_USD = 0.05;

const P = (ref: string, name: string) => ({ ref, userId: `u-${name.split(" ")[0].toLowerCase()}`, name });
const LIST = [P("p1", "Wasim Khan"), P("p2", "Sam Stone"), P("p3", "Ali Khan"), P("p4", "Deniz Kaya")];
const CONFIRMED = [P("p5", "Bilal Ahmed"), P("p6", "Ali Demir")];
const OTHERS = [P("p7", "Tom Third")];

const ctx = (over: Partial<PickReaderContext> = {}): PickReaderContext => ({
  orgId: "dry",
  door: "admin-group",
  list: LIST,
  confirmed: CONFIRMED,
  others: OTHERS,
  asked: "Reply with the number, the name or a tag of who should come in, ALL or NONE.",
  pending: null,
  tags: [],
  ...over,
});

type Check = (r: PickReply) => string | null;
const kind = (k: PickReply["kind"]): Check => (r) => (r.kind === k ? null : `kind ${r.kind}`);
const pick = (positions: number[], userIds: string[] = []): Check => (r) => {
  if (r.kind !== "pick") return `kind ${r.kind}`;
  const got = `${[...r.positions].sort().join(",")}|${[...r.userIds].sort().join(",")}`;
  const want = `${[...positions].sort().join(",")}|${[...userIds].sort().join(",")}`;
  return got === want ? null : `pick ${got} want ${want}`;
};
const picks = (userIds: string[]): Check => (r) => {
  if (r.kind !== "pick") return `kind ${r.kind}`;
  const ids = new Set([...r.positions.map((n) => LIST[n - 1].userId), ...r.userIds]);
  const want = new Set(userIds);
  return ids.size === want.size && [...want].every((x) => ids.has(x)) ? null : `picked ${[...ids].join(",")}`;
};

interface Case {
  body: string;
  ctx: PickReaderContext;
  check: Check;
}
const C = (body: string, check: Check, over: Partial<PickReaderContext> = {}): Case => ({ body, ctx: ctx(over), check });

const CASES: Case[] = [
  C("2", pick([2])),
  C("2 3", pick([2, 3])),
  C("2 and 3", picks(["u-sam", "u-ali"])),
  C("1-3", pick([1, 2, 3])),
  C("2 ve 3", picks(["u-sam", "u-ali"])),
  C("@Match Time 4", pick([4])),
  C("all", kind("all")),
  C("hepsi", kind("all")),
  C("none", kind("none")),
  C("hiçbiri", kind("none")),
  C("leave it", kind("none")),
  C("Wasim", picks(["u-wasim"])),
  C("Wasim and Deniz", picks(["u-wasim", "u-deniz"])),
  C("Sam gelsin", picks(["u-sam"])),
  C("@447700900123", picks(["u-deniz"]), { tags: [{ digits: "447700900123", ref: "p4", whatsappName: "D" }] }),
  C("@447700900999", kind("unresolved-tag"), { tags: [{ digits: "447700900999", ref: null, whatsappName: "Stranger" }] }),
  C("yes", kind("yes"), { pending: P("p7", "Tom Third") }),
  C("evet", kind("yes"), { pending: P("p7", "Tom Third") }),
  C("yes", kind("not-a-pick")),
  C("9", kind("not-understood"), { door: "dm" }),
  C("Wasim played well last week", kind("not-a-pick")),
  C("who's free on Friday?", kind("not-a-pick")),
  C("cuma kim boş?", kind("not-a-pick")),
];

async function main() {
  const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("dryrun-organiser-pick-reader") });
  let calls = 0;
  let usd = 0;
  let lastRaw = "";
  const model: PipelineModel = {
    name: "metered",
    complete: async (req) => {
      if (usd >= MAX_USD) throw new Error(`cost cap $${MAX_USD} reached after ${calls} calls`);
      const r = await inner.complete(req);
      calls++;
      usd += r.costUsd ?? 0.01;
      lastRaw = r.text;
      return r;
    },
  };
  const budget = <T,>(_o: string, fn: () => Promise<T>) => fn();
  const chosen = process.argv.includes("--first") ? CASES.slice(0, 1) : CASES;
  let pass = 0;
  for (const c of chosen) {
    lastRaw = "";
    const got = await readPickReply({ body: c.body, senderName: "Raihan", history: [] }, c.ctx, { model, budget });
    const why = c.check(got);
    if (why === null) pass++;
    console.log(`${why === null ? "PASS" : "FAIL"} ${JSON.stringify(c.body)} (${c.ctx.door}${c.ctx.pending ? ", YES waiting" : ""})${why ? `: ${why}\n   raw: ${lastRaw.slice(0, 400)}` : ""}`);
  }
  console.log(`\n${pass}/${chosen.length} as expected. ${calls} live calls, cost $${usd.toFixed(4)} (dev key).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
