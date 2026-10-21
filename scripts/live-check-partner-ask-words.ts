/**
 * PARTNER CLUBS ASKED IN AN ORGANISER'S OWN WORDS: THE PAID CHECK (slice
 * S6, 2026-10-21). Plan: MDs/cross-club-player-ask-plan-2026-10-16.md,
 * section 6. Dev key only, each case once (the cheap plan).
 *
 *   A. The players' group (an admin's message shown the club's partner
 *      clubs, `partnerClubsLine`) and HQ (its turn unchanged; for a
 *      partnered club, ask_group is read by the admin extractor too),
 *      exactly as production does: the
 *      real router must say admin_ops,
 *      the rewritten admin extractor `recruit` with `partnerClubs` and the
 *      club as written (`clubRef`), and the code's lookup
 *      (`resolvePartnerRef`) the right partner, or every partner when none
 *      is named. Near misses ("Sutton were great last week") must ask
 *      nobody. The club's own "find us a player" stays ask_group / offer.
 *   B. A DM: the rewritten DM classifier says partner_ask (never
 *      recruit_blast, which would DM the club's own players), and the
 *      admin extractor confirms the club.
 *   C. The club's OWN players ("round some up", "the last 5 matches")
 *      stay the recruit blast: no partner clubs read into them.
 *
 * Every existing behaviour of the two rewritten prompts and of the HQ
 * turn is the other suites, run once beside this: free-places (the admin
 * extractor's actions), admin-group, hq-chatter, hq-questions, hq-score,
 * hq-mom, reply-to-matchtime, router-teams-time, group-reply-context, and
 * the DM context spec.
 *
 *   ANTHROPIC_API_KEY_DEV=... npx tsx scripts/live-check-partner-ask-words.ts
 *
 * No database, sends nothing. Prints each case, the calls made and the
 * cost. Stops at MAX_USD.
 */
import { config as loadEnv } from "dotenv";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { HAIKU_CALL, anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "../src/lib/models.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { resolvePartnerRef, type PartnerChoice } from "../src/lib/partner-ask-words-rules.ts";
import { DM_INTENT_SYSTEM_PROMPT, buildDmIntentUserTurn, parseDmIntent, type DmIntent } from "../src/lib/dm-intent.ts";
import type { AdminFacts, Route } from "../src/lib/pipeline/types.ts";

loadEnv();
const MAX_USD = 1;
spendDevApiKeyOrExit("the partner ask words live check");

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

const PARTNERS: PartnerChoice[] = [
  { partnershipId: "p1", partnerOrgId: "sutton", name: "Sutton FC" },
  { partnershipId: "p2", partnerOrgId: "friday", name: "Friday MT Community" },
];
const NAMES = PARTNERS.map((p) => p.name);
/** Which partners the case must ask: a name, "all", or none. */
type Want = "Sutton FC" | "Friday MT Community" | "all" | "none";

interface Case {
  text: string;
  hq: boolean;
  /** Routes that are fine for a "none" case (nobody asked). */
  routes?: Route[];
  want: Want;
  why: string;
}

const CASES: Case[] = [
  // The brief's own words.
  { text: "@Match Time search for players from our partner groups", hq: false, want: "all", why: "Kemal's words, no club named: every partner" },
  { text: "@Match Time ask Friday MT Community if anyone can play", hq: false, want: "Friday MT Community", why: "a named partner, players' group" },
  { text: "@Match Time Sutton'a sor bakalım oynayan var mı", hq: false, want: "Sutton FC", why: "TR, a case ending on the name" },
  { text: "ask Sutton if anyone can play tonight", hq: true, want: "Sutton FC", why: "HQ, untagged, named" },
  { text: "can you try the other clubs for a player", hq: true, want: "all", why: "HQ, the other clubs: every partner" },
  { text: "diğer gruplara sor, oynayacak biri var mı", hq: true, want: "all", why: "HQ, TR, other groups" },
  { text: "@Match Time ask the partner clubs, we need one more", hq: false, want: "all", why: "the multi-partner case" },
  { text: "Friday MT'ye sorar mısın, bir kişi eksik", hq: true, want: "Friday MT Community", why: "HQ, TR, a shortened name" },
  // Near misses: nobody asked.
  { text: "Sutton were great last week", hq: true, routes: ["none", "question"], want: "none", why: "talk about another club" },
  { text: "Sutton geçen hafta çok iyi oynadı", hq: true, routes: ["none", "question"], want: "none", why: "TR, talk about another club" },
  { text: "did Sutton ever get back to us?", hq: true, routes: ["none", "question", "unsure"], want: "none", why: "a question about an ask" },
  { text: "we're one short, can you find us a player", hq: true, routes: ["ask_group"], want: "none", why: "the club's own group: still ask_group" },
  // The club's OWN players' group, in HQ, for a partnered club: still the
  // players' group ask (the admin_ops ask_group cases of admin-group).
  { text: "@Match Time ask in the group if anyone is available", hq: true, routes: ["ask_group"], want: "none", why: "own group" },
  { text: "we're short, can you put a message out in the group", hq: true, routes: ["ask_group"], want: "none", why: "own group" },
  { text: "gruba sor, oynayabilecek var mı", hq: true, routes: ["ask_group"], want: "none", why: "own group, TR" },
  { text: "bir oyuncu eksiğimiz var, ana gruba yazar mısın", hq: true, routes: ["ask_group"], want: "none", why: "own group, TR, the main group" },
  { text: "@Match Time we need one more, anyone?", hq: false, routes: ["offer", "other_att", "unsure"], want: "none", why: "the players' group asked: still attendance" },
];

function asksFor(facts: AdminFacts | null): Want | "nobody" {
  if (!facts || facts.action !== "recruit" || !facts.partnerClubs) return "nobody";
  const r = resolvePartnerRef({ clubRef: facts.clubRef ?? null, partners: PARTNERS, askWhen: "on-request" });
  if (r.kind !== "ask") return "nobody";
  return r.partners.length === PARTNERS.length && !facts.clubRef ? "all" : (r.partners[0].name as Want);
}

interface DmCase {
  text: string;
  want: DmIntent;
  ask?: Want;
  why: string;
}
const DMS: DmCase[] = [
  { text: "ask Sutton if anyone can play tonight", want: "partner_ask", ask: "Sutton FC", why: "named" },
  { text: "can you ask the partner clubs for a player", want: "partner_ask", ask: "all", why: "every partner" },
  { text: "Sutton'a sor bakalım oynayan var mı", want: "partner_ask", ask: "Sutton FC", why: "TR, named" },
  { text: "ask Friday MT Community if anyone can play", want: "partner_ask", ask: "Friday MT Community", why: "named, was recruit_blast before" },
  { text: "Sutton were great last week", want: "other", why: "near miss" },
  // The DM classifier's existing table (scripts/dryrun-pipeline.ts N1 to
  // N8), since its prompt was rewritten: every one must read as before.
  { text: "DM everyone who played in the last 5 matches and invite them", want: "recruit_blast", why: "N1, the club's own blast is unchanged" },
  { text: "who hasn't rated yet?", want: "rating_progress", why: "N2" },
  {
    text: "please do not forget to rate the players via the link from Matchtime DM'ed to you. the more accurate ratings, the more balanced teams next time",
    want: "other",
    why: "N3, the 10 Sept near miss",
  },
  { text: "Najib is out. We need one more player.", want: "other", why: "N4, the 1 Sept incident sentence" },
  { text: "the lads keep asking me to DM them the ratings link", want: "other", why: "N5" },
  { text: "cheers for sorting the players out last week", want: "other", why: "N6" },
  { text: "I'm out tuesday sorry", want: "other", why: "N7" },
  { text: "we're short for tuesday, can you message the recent lads and ask them", want: "recruit_blast", why: "N8" },
  { text: "eksiğimiz var, birkaç oyuncu topla", want: "recruit_blast", why: "TR own players" },
  { text: "kim daha puan vermedi?", want: "rating_progress", why: "TR rating progress" },
];

const OWN = [
  "@Match Time we need more players, can you round some up",
  "@Match Time message all players who played in the last 5 matches and invite them",
  "@Match Time ask the regulars if they can play",
  "@Match Time eksiğimiz var, birkaç oyuncu topla",
];

async function dmCall(system: string, user: string): Promise<string> {
  // What `dm-intent.ts`'s live call sends: Haiku 5.5, adaptive thinking
  // at the house effort, the short-answer budget.
  const r = await model.complete({ ...HAIKU_CALL, system, user, maxTokens: HAIKU_SHORT_ANSWER_MAX_TOKENS, label: "dm-intent-live" });
  return r.text;
}

async function main() {
  let pass = 0;
  let fail = 0;
  const ctx = organisersContext({ pending: [], recent: [] });
  console.log(`\n== A. Groups: ${CASES.length} cases, each once (partners: ${NAMES.join(", ")}) ==\n`);
  for (const [i, c] of CASES.entries()) {
    const id = `s${i}`;
    const r = await routeBatch(
      model,
      [{ id, authorName: "Raihan", body: c.text, ...(c.hq ? { organisers: { context: ctx } } : { partnerClubs: NAMES }) }],
      { floor: true },
    );
    const route = r.routes[0]?.route;
    let facts: AdminFacts | null = null;
    // As production: admin_ops anywhere; in HQ, ask_group too, for a club
    // with partner clubs (`admin-group-understand.ts`).
    if (route === "admin_ops" || (c.hq && route === "ask_group")) {
      const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Raihan", tagged: true, history: [], lastBotPost: null });
      facts = ex.facts.kind === "admin" ? ex.facts : null;
    }
    const got = asksFor(facts);
    const ok =
      c.want === "none"
        ? got === "nobody" && (!c.routes || (!!route && c.routes.includes(route)))
        : (route === "admin_ops" || (c.hq && route === "ask_group")) && got === c.want;
    ok ? pass++ : fail++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.hq ? "HQ" : "PG"} ${JSON.stringify(c.text)}  routed ${route}  facts ${JSON.stringify(facts && { action: facts.action, partnerClubs: facts.partnerClubs, clubRef: facts.clubRef })}  asks ${got}   (${c.why}; want ${c.want})`,
    );
  }

  console.log(`\n== B. DMs: ${DMS.length} cases, each once ==\n`);
  for (const [i, c] of DMS.entries()) {
    const cls = parseDmIntent(await dmCall(DM_INTENT_SYSTEM_PROMPT, buildDmIntentUserTurn(c.text, { clubName: "FNF", senderName: "Raihan", partnerClubs: NAMES })));
    let got: Want | "nobody" | null = null;
    if (cls.intent === "partner_ask" && c.ask) {
      const ex = await extractForRoute(model, "admin_ops", { id: `d${i}`, body: c.text, authorName: "Raihan", tagged: true, history: [], lastBotPost: null });
      got = asksFor(ex.facts.kind === "admin" ? ex.facts : null);
    }
    const ok = cls.intent === c.want && (!c.ask || got === c.ask);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  DM ${JSON.stringify(c.text)}  ${cls.intent} (${cls.confidence})${got ? ` asks ${got}` : ""}   (${c.why}; want ${c.want}${c.ask ? `, ${c.ask}` : ""})`);
  }

  console.log(`\n== C. The admin extractor: the club's OWN players stay the recruit blast (${OWN.length} cases, each once) ==\n`);
  for (const [i, text] of OWN.entries()) {
    const ex = await extractForRoute(model, "admin_ops", { id: `o${i}`, body: text, authorName: "Kemal", tagged: true, history: [], lastBotPost: null });
    const f = ex.facts.kind === "admin" ? ex.facts : null;
    const ok = !!f && f.action === "recruit" && !f.partnerClubs && !f.clubRef;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(text)}  ${JSON.stringify(f)}   (own players: recruit, no partner clubs)`);
  }

  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
