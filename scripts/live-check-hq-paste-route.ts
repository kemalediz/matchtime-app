/**
 * DOES A SQUAD LIST PASTED IN HQ REACH THE HQ SQUAD READER? (2026-10-30)
 *
 * Since #471 the HQ squad reader runs only after the shared router sends a
 * message to the squad (`admin-group-understand.ts`: self_att, other_att,
 * or unsure when addressed). This sends real pasted lists through the real
 * router, with HQ's organisers context as production renders it, and then
 * through the real reader whatever the route, so it shows both whether the
 * door lets the list through and what the reader would say.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-hq-paste-route.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Hard stop at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { readHqSquadMessage } from "../src/lib/hq-squad-reader.ts";
import type { HqSquadReaderContext } from "../src/lib/hq-squad-reader-prompt.ts";

const MAX_USD = 0.08;

const EN = ["Feroz", "Alamgir", "Rafi", "Hamza", "Mo", "Uncle Najib", "Abdul-Hafeez", "Mojib", "Yaseen", "Yorel", "Maj", "Imz", "Hamzah", "Akram", "Mahir", "Shehryar", "Habib", "Ali"];
const EN_EXTRA = ["Raihan", "Bilal", "Naim Khan", "Tariq"];
const TR = ["Erdal", "Burak", "Volkan", "Emre", "Mehmet", "Kemal", "Can", "Deniz", "Serkan", "Okan", "Tolga", "Cem", "Hakan", "Murat"];

const ctxOf = (names: string[], playing: string[], label: string, places: number): HqSquadReaderContext => ({
  orgId: "probe",
  game: { label, places },
  members: names.map((name, i) => ({ ref: `p${i + 1}`, userId: `u-${i + 1}`, name, aliases: [] })),
  squad: { playing: names.map((n, i) => (playing.includes(n) ? `u-${i + 1}` : null)).filter((x): x is string => !!x), bench: [] },
  teams: null,
});
const EN_CTX = ctxOf([...EN, ...EN_EXTRA], EN.slice(0, 16), "Fri 6 Nov, 20:30", 18);
const TR_CTX = ctxOf(TR, TR.slice(0, 10), "Cum 6 Kas, 21:00", 10);

const numbered = (names: string[]) => names.map((n, i) => `${i + 1}. ${n}`).join("\n");
const CASES: Array<{ name: string; body: string; ctx: HqSquadReaderContext }> = [
  { name: "EN: FNF numbered 18 with a title", body: `FNF Friday 6th Nov 8:30pm\n${numbered([...EN.slice(0, 16), "Bilal", "Naim Khan"])}`, ctx: EN_CTX },
  { name: "EN: bare one name per line, 18", body: [...EN.slice(0, 17), "Bilal"].join("\n"), ctx: EN_CTX },
  { name: "EN: numbered 18 with a Bench part", body: `${numbered([...EN.slice(0, 16), "Bilal", "Naim Khan"])}\n\nBench\n1. Tariq\n2. Raihan`, ctx: EN_CTX },
  { name: "TR: Cuma kadrosu, numbered 10", body: `Cuma kadrosu\n${numbered([...TR.slice(0, 8), "Tolga", "Cem"])}`, ctx: TR_CTX },
  { name: "TR: bare one name per line, 10", body: [...TR.slice(0, 9), "Tolga"].join("\n"), ctx: TR_CTX },
  { name: "TR: numbered 10 with Yedekler", body: `${numbered([...TR.slice(0, 8), "Tolga", "Cem"])}\n\nYedekler\n1. Hakan\n2. Murat`, ctx: TR_CTX },
];

/** The routes on which `admin-group-understand.ts` asks the reader (unsure only when addressed; these are untagged). */
const READER_ROUTES = new Set(["self_att", "other_att"]);

async function main() {
  const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("live-check-hq-paste-route") });
  let calls = 0;
  let usd = 0;
  const model: PipelineModel = {
    name: "metered",
    complete: async (req) => {
      if (usd >= MAX_USD) throw new Error(`cost cap $${MAX_USD} reached after ${calls} calls`);
      const r = await inner.complete(req);
      calls++;
      usd += r.costUsd ?? 0.01;
      return r;
    },
  };
  const context = organisersContext({ pending: [], recent: [] });
  let reached = 0;
  for (const [i, c] of CASES.entries()) {
    const r = await routeBatch(model, [{ id: `q${i}`, authorName: "Raihan", body: c.body, organisers: { context, senderIsOrganiser: true } }], { floor: false });
    const route = r.routes[0]?.route ?? "nowhere";
    const reading = await readHqSquadMessage(
      { body: c.body, sender: { userId: "u-1", name: c.ctx.members[0].name }, history: [], reply: null, addressed: false, now: new Date("2026-11-02T12:00:00Z") },
      c.ctx,
      { model },
    );
    const gate = READER_ROUTES.has(route);
    if (gate && reading.kind === "squad") reached++;
    const detail = reading.kind === "squad" ? `squad, ${reading.lines.length} lines, ${reading.lines.filter((l) => l.section === "bench").length} bench, out ${reading.out.length}` : reading.kind;
    console.log(`${gate && reading.kind === "squad" ? "PASS" : "MISS"}  ${c.name}: router ${route} (${gate ? "reader asked" : "reader NOT asked"}); reader would say ${detail}`);
  }
  console.log(`\n${reached}/${CASES.length} reach the reader and are read as the squad. ${calls} live calls, cost $${usd.toFixed(4)} (dev key).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
