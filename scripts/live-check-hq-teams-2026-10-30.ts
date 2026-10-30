/**
 * LIVE CHECK: FNF HQ's teams on 29 Oct, as decided by Kemal on 2026-10-30,
 * each case ONCE.
 *
 * What production runs for an HQ message about the teams: the shared router
 * (with the organisers' context and, for a reply, the message it quotes),
 * then, on a squad route, the HQ squad reader, then the teams extractor
 * (with the members it names and the truth about the tag). Each case is
 * graded on what CODE then does with the reading (`decide`, the same rules
 * as `admin-group-understand.ts`):
 *
 *   - a build (generate, or show with no teams) only when addressed by fact;
 *   - untagged, a single change only when the extractor reads it as an
 *     instruction to MatchTime (`toMatchTime`);
 *   - a YES-like reply quoting an earlier stored sheet (route approve)
 *     brings that sheet back; restore read on a reply does the same;
 *   - a pasted sheet is "set" with both sides.
 *
 * The writes themselves are pinned by the unit and e2e tests. Spends
 * ANTHROPIC_API_KEY_DEV only (refuses without it). No database, sends
 * nothing. Stops at MAX_USD.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-hq-teams-2026-10-30.ts
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import type { TeamFacts } from "../src/lib/pipeline/types.ts";
import { membersNamedIn } from "../src/lib/pipeline/identity.ts";
import { organisersContext, type PendingWithLabel } from "../src/lib/admin-group-context.ts";
import { teamCommandFromFacts } from "../src/lib/team-proposal-rules.ts";
import { readHqSquadMessage } from "../src/lib/hq-squad-reader.ts";
import type { HqReaderMember, HqSquadReaderContext } from "../src/lib/hq-squad-reader-prompt.ts";

spendDevApiKeyOrExit("scripts/live-check-hq-teams-2026-10-30.ts");

const MAX_USD = 0.2;
let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: inner.name,
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

const NOW = new Date("2026-10-29T17:35:00Z");
// Tuesday's sheet, never approved; Thursday's, after Raihan's message.
const TUE_RED = ["Feroz", "Alamgir", "Rafi", "Hamza", "Mo", "Uncle Najib", "Abdul-Hafeez", "Mojib", "Yaseen"];
const TUE_YELLOW = ["Yorel", "Maj", "Imz", "Hamzah", "Akram", "Mahir", "Shehryar", "Habib", "Ali"];
const THU_RED = ["Feroz", "Uncle Najib", "Yorel", "Akram", "Alamgir", "Shehryar", "Abdul-Hafeez", "Ali", "Habib"];
const THU_YELLOW = ["Rafi", "Mo", "Imz", "Maj", "Hamza", "Mahir", "Hamzah", "Mojib", "Yaseen"];
const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");
const sheet = (red: string[], yellow: string[]) =>
  `📝 *Proposed teams*: 20:30 at Harris Merton\n\n*Non Bibs*:\n${list(red)}\n\n*Bibs*:\n${list(yellow)}\n\n` +
  "To change them, just tell me in your own words (for example *swap Feroz and Yorel* or *move Feroz to the other team*). For brand new teams, tag me (*@Match Time shuffle them again*).\n" +
  "Reply *YES* when they are final. I won't post them in the players' group.";
const TUE = sheet(TUE_RED, TUE_YELLOW);
const THU = sheet(THU_RED, THU_YELLOW);
const PENDING: PendingWithLabel[] = [{ ref: "teams:m1", kind: "teams", day: "Fri 30 Oct", askedAt: new Date("2026-10-29T17:30:00Z") }];
const ALL = [...TUE_RED, ...TUE_YELLOW];
const ROSTER = [...ALL, "Raihan"].map((name) => ({ name, aliases: name === "Uncle Najib" ? ["Uncle"] : [] }));
const uid = (n: string) => `u-${n.toLowerCase().replace(/[^a-z]/g, "")}`;
const MEMBERS: HqReaderMember[] = [...ALL, "Raihan"].map((name, i) => ({ ref: `p${i + 1}`, userId: uid(name), name, aliases: name === "Uncle Najib" ? ["Uncle"] : [] }));
const READER_CTX: HqSquadReaderContext = {
  orgId: "fnf",
  game: { label: "Fri 30 Oct, 20:30", places: 18 },
  members: MEMBERS,
  squad: { playing: ALL.map(uid), bench: [] },
  teams: { state: "proposed", sides: [{ label: "Non Bibs", userIds: THU_RED.map(uid) }, { label: "Bibs", userIds: THU_YELLOW.map(uid) }] },
};

/** What HQ does with the reading, by the rules in `admin-group-understand.ts`. */
type Did = "nothing" | "build" | "change" | "suggest" | "show" | "restore-quoted" | "restore" | "set" | "graphic" | "unclear" | "other-route";

function decide(route: string, addressed: boolean, quotesSheet: boolean, facts: TeamFacts | null): { did: Did; detail: string } {
  if (route === "team_sheet") return { did: addressed ? "graphic" : "nothing", detail: "" };
  if (route === "approve") return { did: quotesSheet ? "restore-quoted" : "other-route", detail: "" };
  if (!facts) return { did: route === "none" ? "nothing" : "other-route", detail: "" };
  if (!addressed && facts.action !== "show" && facts.toMatchTime !== true) return { did: "nothing", detail: `${facts.action}, toMatchTime false` };
  const c = teamCommandFromFacts(facts);
  const detail = JSON.stringify(c);
  if (c.kind === "unclear") return { did: "unclear", detail };
  if (c.kind === "reshuffle") return { did: addressed ? "build" : "nothing", detail };
  if (c.kind === "change") return { did: "change", detail };
  return { did: c.kind as Did, detail };
}

interface Case {
  id: string;
  text: string;
  tagged?: boolean;
  /** A WhatsApp reply to this post of MatchTime's (a stored sheet). */
  quotes?: string;
  ok: (did: Did, facts: TeamFacts | null) => boolean;
  why: string;
}

const lc = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase().trim()).sort();
const same = (a: string[] | undefined, b: string[]) => JSON.stringify(lc(a)) === JSON.stringify(lc(b));
const PASTED = `Use these teams\n\nNon Bibs\n${list(TUE_RED)}\n\nBibs\n${list(TUE_YELLOW)}`;
const PASTED_BARE = `These are the teams\n\nNon Bibs\n${list(TUE_RED)}\n\nBibs\n${list(TUE_YELLOW)}`;

const CASES: Case[] = [
  {
    id: "K1",
    text: "Stick keeper. Ali and Habib on one team",
    // Never a reshuffle. Read as an instruction: the pairing as a change;
    // read as the organisers' own talk (route none, or toMatchTime false):
    // nothing. Both follow Kemal's rule; which one the model chose is reported.
    ok: (d, f) => d === "nothing" || (d === "change" && (f?.pairings ?? []).some((g) => same(g, ["Ali", "Habib"]))),
    why: "untagged pairing on proposed teams: never a reshuffle (17:35)",
  },
  { id: "K2", text: "These are the final teams", quotes: TUE, ok: (d) => d === "restore-quoted" || d === "restore", why: "a reply to Tuesday's sheet: those teams back, nothing approved" },
  { id: "K3", text: "Make teams and the graphic", ok: (d) => d === "nothing" || d === "unclear", why: "untagged: no build, no picture" },
  { id: "K3t", text: "@Match Time make teams and the graphic", tagged: true, ok: (d) => d === "graphic" || d === "build", why: "tagged: the picture or the teams, asked" },
  { id: "K4", text: PASTED, ok: (d, f) => d === "set" && same(f?.sides?.red, TUE_RED) && same(f?.sides?.yellow, TUE_YELLOW), why: "Hamzah pastes the old teams back" },
  {
    id: "K4b",
    text: PASTED_BARE,
    ok: (d, f) => d === "nothing" || (d === "set" && same(f?.sides?.red, TUE_RED)),
    why: "a sheet pasted with no word to use it: set, or their own talk (reported)",
  },
  { id: "K5", text: "use these", quotes: TUE, ok: (d) => d === "restore" || d === "restore-quoted", why: "reply to an earlier sheet, EN" },
  { id: "K6", text: "bunları kullan", quotes: TUE, ok: (d) => d === "restore" || d === "restore-quoted", why: "reply to an earlier sheet, TR" },
  { id: "K7", text: "Ali and Habib always end up on the same team lol", ok: (d) => d === "nothing", why: "a remark: nothing done" },
  { id: "K8", text: "Swap Rafi and Yorel", ok: (d, f) => d === "change" && same(f?.moves, ["Rafi", "Yorel"]), why: "untagged single swap still works" },
  { id: "K9", text: "Recommend swaps", ok: (d) => d === "suggest", why: "untagged suggest still works (F7u)" },
  { id: "K10", text: "Make teams", ok: (d) => d === "nothing", why: "untagged build: nothing" },
];

async function main() {
  const only = process.env.ONLY?.split(",");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  let failed = 0;
  for (const c of cases) {
    const recent = [{ fromMatchTime: true, text: THU }];
    const context = organisersContext({ pending: PENDING, recent });
    const reply = c.quotes ? { at: new Date("2026-10-27T18:09:00Z"), text: c.quotes, topic: null, match: null, author: null } : null;
    const addressed = !!c.tagged || !!c.quotes;
    const r = await routeBatch(
      model,
      [{ id: c.id, authorName: "Hamzah", body: c.text, organisers: { context, senderIsOrganiser: true }, ...(reply ? { reply } : {}) }],
      { floor: true },
    );
    let route = r.routes[0]?.route ?? "nowhere";
    let reading = "";
    // A squad route: the HQ squad reader first; "teams" goes to the teams extractor.
    if (route === "other_att" || route === "self_att" || (route === "unsure" && addressed)) {
      const read = await readHqSquadMessage(
        { body: c.text, sender: { userId: uid("Hamzah"), name: "Hamzah" }, history: [{ author: "MatchTime", body: THU }], reply, addressed, now: NOW },
        READER_CTX,
        { model },
      );
      reading = read.kind;
      if (read.kind === "teams") route = "balancer";
    }
    let facts: TeamFacts | null = null;
    if (route === "balancer") {
      const ex = await extractForRoute(model, "balancer", {
        id: c.id,
        body: c.text,
        authorName: "Hamzah",
        tagged: !!c.tagged,
        history: [{ author: "MatchTime", body: THU }],
        lastBotPost: THU,
        reply,
        members: membersNamedIn(c.text, ROSTER, 30),
        now: NOW,
      });
      facts = ex.facts.kind === "teams" ? ex.facts : null;
    }
    const { did, detail } = decide(route, addressed, !!c.quotes, facts);
    const ok = c.ok(did, facts);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.id.padEnd(4)} routed ${route.padEnd(9)}${reading ? ` (reader: ${reading})` : ""} -> ${did} ${detail}   (${c.why})`);
    if (facts) console.log(`       facts ${JSON.stringify(facts)}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed. ${calls} model call(s), $${usd.toFixed(4)}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
