/**
 * THE ORGANISERS' OWN CONVERSATION IN HQ STAYS THEIRS: THE PAID CHECK
 * (2026-10-17).
 *
 * FNF HQ, 2026-10-16 23:49 London: organisers talking about NEXT week ("Imti
 * Rafi AH back", a reply to another organiser) got a ✅ and "I don't know AH
 * yet...". Nothing was written. The fix is in code, not in a prompt: a reply
 * to another organiser without a tag is their conversation
 * (`hqAddressing`), and a claim the HQ vetting holds gets a line back only
 * when the message was addressed to MatchTime (`buildAdminSquadReply`).
 *
 * This runs each case ONCE through the real router (organisers' context,
 * as production renders it) and, for an attendance route, the real
 * attendance extractor, then the shipped pure code: `hqAddressing`,
 * `vetAdminGroupFacts`, `buildAdminSquadReply`. The verdict is what HQ
 * would see:
 *
 *   silent   no write, no reply, no tick
 *   acts     at least one instruction reaches the attendance engine
 *   reply    one line back and nothing written (only when addressed)
 *
 * Approved by Kemal for this change: dev key only, run once.
 *
 *   ANTHROPIC_API_KEY_DEV=... npx tsx scripts/live-check-hq-chatter.ts
 *   ONLY="@Match Time AH back" ...   one case
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { quoteFromPi } from "../src/lib/reply-context.ts";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { floorAttendanceFacts, routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { hqAddressing, organisersContext } from "../src/lib/admin-group-context.ts";
import { buildAdminSquadReply, vetAdminGroupFacts, type AdminClaimRef } from "../src/lib/admin-group-squad-rules.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 2;

spendDevApiKeyOrExit("the HQ chatter live check");

let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

// The club's members, as the engine's resolver would place them. Anyone
// else is a name nobody in the club has.
const MEMBERS = ["Bilal", "Sam", "Tom", "Kai", "Imti", "Rafi", "Ali", "Mehmet", "Mojib", "Habib", "Shehryar", "Hamzah", "Wasim", "Raihan"];
function resolve(ref: string): AdminClaimRef {
  const first = ref.trim().replace(/^@/, "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first) return { kind: "none" };
  const hit = MEMBERS.find((m) => m.toLowerCase() === first || m.toLowerCase().startsWith(first) && first.length >= 3);
  return hit ? { kind: "member", userId: `u-${hit.toLowerCase()}`, name: hit } : { kind: "unknown", name: ref.trim() };
}

// The real HQ chat around the incident (AdminGroupMessage rows, 22:47 to
// 22:49 UTC), as the router's "EARLIER HERE" lines.
const OUT_LIST = "We have the below out - \n\nYaseen\nMo\nFeroz\nWasim 50/50\nMojib \nHabib \nAli";
const INCIDENT_RECENT = [
  "Captains 👀",
  "Im hoping to be back next week 🤲🏼",
  "In’sha’Allah",
  "This MT stuff looks all good but I think its kinda long 😬",
  OUT_LIST,
  "Wasim here but his brothers gone?",
  "Just for next week? Damn session may get cancelled",
].map((text) => ({ fromMatchTime: false, text }));
const MT_SQUAD = "📋 *Fri 23 Oct, 19:30*: 16 of 18 in.\n1. Bilal\n2. Sam\n...";

type Verdict = "silent" | "acts" | "reply";
interface Case {
  text: string;
  quoted?: { text: string; fromMatchTime: boolean };
  recent?: Array<{ fromMatchTime: boolean; text: string }>;
  want: Verdict;
  why: string;
}

const CASES: Case[] = [
  // The incident, word for word, with the chat around it.
  { text: "Imti Rafi AH back", quoted: { text: OUT_LIST, fromMatchTime: false }, recent: INCIDENT_RECENT, want: "silent", why: "the incident: a reply to another organiser" },
  { text: "Maybe shehryar hamzah too", recent: INCIDENT_RECENT, want: "silent", why: "the incident: speculation" },
  { text: "Just for next week? Damn session may get cancelled", quoted: { text: OUT_LIST, fromMatchTime: false }, recent: INCIDENT_RECENT.slice(0, 6), want: "silent", why: "the incident: chat about next week" },
  { text: "Should be fine", recent: INCIDENT_RECENT, want: "silent", why: "the incident: chat" },
  // Similar organiser chatter, not a reply to anyone.
  { text: "Imti Rafi AH back", recent: INCIDENT_RECENT, want: "silent", why: "the same words, not a reply" },
  { text: "Mojib and Habib are in dw", recent: INCIDENT_RECENT, want: "silent", why: "reassuring another organiser" },
  { text: "I'll be back following week incase rafi does the same", recent: INCIDENT_RECENT, want: "silent", why: "a plan for a later week" },
  { text: "Im hoping to be back next week 🤲🏼", want: "silent", why: "a hope" },
  { text: "Tom could play if we're short", want: "silent", why: "who could play" },
  { text: "Zayn might come back the week after", want: "silent", why: "a stranger, speculation, a later week" },
  { text: "Zayn is back as well", want: "silent", why: "a stranger in passing" },
  { text: "Mo had bibs and Naim won motm", want: "silent", why: "tonight's game, past" },
  { text: "Ali belki gelir haftaya", want: "silent", why: "TR: speculation" },
  { text: "Mehmet döndü galiba", quoted: { text: "Mehmet nerede?", fromMatchTime: false }, want: "silent", why: "TR: a reply to another organiser" },
  // Clear instructions: still acted on.
  { text: "put Bilal in", want: "acts", why: "plain imperative" },
  { text: "Sam's out this week", want: "acts", why: "a squad fact, stated generally" },
  { text: "Tom to the bench", want: "acts", why: "plain imperative, bench" },
  { text: "Kai can't make it tonight", want: "acts", why: "a squad fact" },
  { text: "@Match Time Imti is back, put Imti in", want: "acts", why: "tagged instruction" },
  { text: "add Rafi", quoted: { text: MT_SQUAD, fromMatchTime: true }, want: "acts", why: "a reply to MatchTime's own squad post" },
  { text: "@Match Time put Imti in", quoted: { text: OUT_LIST, fromMatchTime: false }, want: "acts", why: "tagged, while quoting another organiser" },
  { text: "Ali'yi kadroya ekle", want: "acts", why: "TR: imperative" },
  { text: "Mehmet bu hafta yok", want: "acts", why: "TR: a squad fact" },
  // Addressed, but not an instruction MatchTime can apply: one line, no write.
  { text: "@Match Time AH back", want: "reply", why: "tagged, a stranger: says it could not tell who, and how to add someone" },
];

const SQUAD_ROUTES = new Set<Route>(["self_att", "other_att"]);

async function verdictOf(c: Case, id: string): Promise<{ verdict: Verdict; route: string; detail: string }> {
  const quoted = c.quoted ?? null;
  const quotedIsMatchTime = quoted?.fromMatchTime === true;
  const { addressed, toAnotherOrganiser } = hqAddressing({ text: c.text, quoted, quotedIsMatchTime });
  const context = organisersContext({ pending: [], recent: (c.recent ?? []).slice(-5) });
  const quotedReply = quoted ? quoteFromPi({ id: null, ...quoted }) : null;
  const r = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context }, reply: quotedReply }], { floor: true });
  const route = r.routes[0]?.route ?? "nowhere";
  // `admin-group-understand.ts`, in order.
  if (toAnotherOrganiser && route !== "approve" && route !== "score") return { verdict: "silent", route, detail: "reply to another organiser" };
  if (route === "unsure" && !addressed) return { verdict: "silent", route, detail: "" };
  if (route === "question" || route === "help") {
    // What the question answering would be asked (2026-10-19): its topic
    // and who it names, so a "reply" here says which reply.
    const q = await extractForRoute(model, "question", { id, body: c.text, authorName: "Raihan", tagged: true, history: [], lastBotPost: null, reply: quotedReply });
    const what = q.facts.kind === "question" ? `topic ${q.facts.topic}${q.facts.personRef ? `, about ${JSON.stringify(q.facts.personRef)}` : ""}` : q.facts.kind;
    return { verdict: "reply", route, detail: `question answering: ${what}` };
  }
  if (!SQUAD_ROUTES.has(route as Route) && route !== "unsure") {
    return { verdict: route === "none" || route === "offer" ? "silent" : "reply", route, detail: "not a squad route" };
  }
  const ex = await extractForRoute(model, route as Route, { id, body: c.text, authorName: "Raihan", tagged: true, history: [], lastBotPost: null });
  if (ex.facts.kind !== "attendance") return { verdict: addressed ? "reply" : "silent", route, detail: "no attendance facts" };
  console.log(`      extractor: ${JSON.stringify(ex.facts.claims)}`);
  const { facts, vetted } = vetAdminGroupFacts({
    body: c.text,
    facts: ex.facts,
    senderUserId: "u-raihan",
    senderName: "Raihan",
    bareDeclaration: floorAttendanceFacts(c.text) !== null,
    resolve,
    statusOf: () => null,
  });
  const holds = vetted.map((v) => `${v.claim.personRef || "me"}:${v.claim.polarity}:${v.hold ?? "kept"}`).join(", ");
  if (facts.claims.length > 0) return { verdict: "acts", route, detail: holds };
  const reply = buildAdminSquadReply({
    lang: "en",
    changes: [],
    failed: [],
    confirmed: 16,
    maxPlayers: 18,
    bench: [],
    benchPickMode: null,
    vetted,
    kickoffLabel: "Fri 19:30",
    senderName: "Raihan",
    addressed,
    aboutOthers: route === "other_att",
  });
  return { verdict: reply ? "reply" : "silent", route, detail: `${holds}${reply ? ` -> ${JSON.stringify(reply.text)}` : ""}` };
}

async function main() {
  let pass = 0;
  let fail = 0;
  // ONLY="@Match Time AH back" runs that one case.
  const only = process.env.ONLY?.trim();
  const cases = only ? CASES.filter((c) => c.text === only) : CASES;
  console.log(`\n== HQ: organisers' chatter and instructions, ${cases.length} cases, each once ==\n`);
  for (const [i, c] of cases.entries()) {
    const v = await verdictOf(c, `hc${i}`);
    const ok = v.verdict === c.want;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}${c.quoted ? ` (reply to ${c.quoted.fromMatchTime ? "MatchTime" : "an organiser"})` : ""}  routed ${v.route} -> ${v.verdict}  [${v.detail}]   (${c.why}; want ${c.want})`);
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
