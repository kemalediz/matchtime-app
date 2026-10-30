/**
 * THE ORGANISERS' OWN CONVERSATION IN HQ STAYS THEIRS: THE PAID CHECK
 * (2026-10-17; the HQ squad reader since 2026-10-30).
 *
 * FNF HQ, 2026-10-16 23:49 London: organisers talking about NEXT week ("Imti
 * Rafi AH back", a reply to another organiser) got a ✅ and "I don't know AH
 * yet...". A reply to another organiser without a tag is their conversation
 * (`hqAddressing`, a fact). Since 2026-10-30 (Kemal: "I don't want any
 * string parsing at all") whether the rest is an instruction is the HQ
 * squad reader's to say, a model, not EN and TR word lists in code.
 *
 * This runs each case ONCE through the real router (organisers' context,
 * as production renders it) and, for a route about the squad, the real HQ
 * squad reader (`readHqSquadMessage`, the production prompt and checks),
 * then decides as `admin-group-understand.ts` does. The verdict is what HQ
 * would see:
 *
 *   silent   no write, no reply, no tick
 *   acts     the reader reads a change (or the squad): the engine applies it
 *   reply    one line back and nothing written
 *
 *   ANTHROPIC_API_KEY_DEV=... npx tsx scripts/live-check-hq-chatter.ts
 *   ONLY="@Match Time AH back" ...   one case
 *   FIRST=1 ...                      the first case only (measure one)
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { quoteFromPi } from "../src/lib/reply-context.ts";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { hqAddressing, organisersContext } from "../src/lib/admin-group-context.ts";
import { readHqSquadMessage } from "../src/lib/hq-squad-reader.ts";
import type { HqSquadReaderContext } from "../src/lib/hq-squad-reader-prompt.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 2;

const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("the HQ chatter live check") });

let calls = 0;
let usd = 0;
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

// The club's members. Anyone else is a name nobody in the club has. All of
// them are playing the next game except Imti and Rafi (who are "back").
const MEMBERS = ["Bilal", "Sam", "Tom", "Kai", "Imti", "Rafi", "Ali", "Mehmet", "Mojib", "Habib", "Shehryar", "Hamzah", "Wasim", "Raihan"];
const CTX: HqSquadReaderContext = {
  orgId: "check",
  game: { label: "Fri 23 Oct, 19:30", places: 18 },
  members: MEMBERS.map((name, i) => ({ ref: `p${i + 1}`, userId: `u-${name.toLowerCase()}`, name, aliases: [] })),
  squad: { playing: MEMBERS.filter((n) => n !== "Imti" && n !== "Rafi").map((n) => `u-${n.toLowerCase()}`), bench: [] },
  teams: null,
};

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
  /** One verdict, or the verdicts that are each right. */
  want: Verdict | Verdict[];
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
  // Since 2026-10-30 the reader may read a tagged "AH back" as an instruction
  // to put AH in (a new player), or not (one line): both are right.
  { text: "@Match Time AH back", want: ["acts", "reply"], why: "tagged, a stranger: put in, or one line" },
  // One-line and short lists (2026-10-30: no shape gate, no name-list parser).
  { text: "Imti\nRafi\nAH\n\nIn", want: "acts", why: "the 17 Oct list of names with In" },
  { text: "Yaseen, Mo, Feroz and Ali out", want: "acts", why: "a one-line list" },
  { text: "Glazers, Imti out", want: "acts", why: "a one-line list (B2)" },
];

const SQUAD_ROUTES = new Set<Route>(["self_att", "other_att"]);

async function verdictOf(c: Case, id: string): Promise<{ verdict: Verdict; route: string; detail: string }> {
  const quoted = c.quoted ?? null;
  const quotedIsMatchTime = quoted?.fromMatchTime === true;
  const { addressed, toAnotherOrganiser } = hqAddressing({ text: c.text, quoted, quotedIsMatchTime });
  const context = organisersContext({ pending: [], recent: (c.recent ?? []).slice(-5) });
  const quotedReply = quoted ? quoteFromPi({ id: null, ...quoted }) : null;
  const r = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context, senderIsOrganiser: true }, reply: quotedReply }], { floor: false });
  const route = r.routes[0]?.route ?? "nowhere";
  const squadRoute = SQUAD_ROUTES.has(route as Route);
  const read = () =>
    readHqSquadMessage(
      {
        body: c.text,
        sender: { userId: "u-raihan", name: "Raihan" },
        history: (c.recent ?? []).map((m) => ({ author: m.fromMatchTime ? "MatchTime" : "Hamzah", body: m.text })),
        reply: quotedReply,
        addressed,
        now: new Date("2026-10-21T19:00:00Z"),
      },
      CTX,
      { model },
    );
  // `admin-group-understand.ts`, in order.
  if (toAnotherOrganiser && route !== "approve" && route !== "score") {
    if (!squadRoute) return { verdict: "silent", route, detail: "reply to another organiser" };
    const reading = await read();
    return { verdict: reading.kind === "squad" ? "acts" : "silent", route, detail: `reply to another organiser; reader ${reading.kind}` };
  }
  if (route === "unsure" && !addressed) return { verdict: "silent", route, detail: "" };
  if (route === "question" || route === "help") return { verdict: "reply", route, detail: "question answering" };
  if (!squadRoute && route !== "unsure") {
    return { verdict: route === "none" || route === "offer" ? "silent" : "reply", route, detail: "not a squad route" };
  }
  const reading = await read();
  const detail =
    reading.kind === "change"
      ? `change ${reading.changes.map((x) => `${x.name}${x.userId ? "" : "(new)"}:${x.to}`).join(", ")}${reading.alsoAsks ? " +asks" : ""}`
      : reading.kind === "other"
        ? `other (${reading.why})`
        : reading.kind;
  if (reading.kind === "change" || reading.kind === "squad") return { verdict: "acts", route, detail };
  return { verdict: addressed ? "reply" : "silent", route, detail };
}

async function main() {
  let pass = 0;
  let fail = 0;
  // ONLY="@Match Time AH back" runs that one case.
  const only = process.env.ONLY?.trim();
  const cases = only ? CASES.filter((c) => c.text === only) : process.env.FIRST ? CASES.slice(0, 1) : CASES;
  console.log(`\n== HQ: organisers' chatter and instructions, ${cases.length} cases, each once ==\n`);
  for (const [i, c] of cases.entries()) {
    const v = await verdictOf(c, `hc${i}`);
    const ok = (Array.isArray(c.want) ? c.want : [c.want]).includes(v.verdict);
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
