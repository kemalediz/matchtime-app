/**
 * ASKING THE MATCHTIME PLAYER POOL FROM HQ: THE PAID CHECK (local player
 * pool L10, 2026-10-24).
 *
 * Each case ONCE through the real router (the organisers' header, as
 * production renders it, with the pool notice's WAITING line where shown)
 * and, on ask_group and admin_ops, the real admin extractor, told truly
 * whether the bot was tagged. What HQ would do, by the same rule as
 * `admin-group-understand.ts`:
 *
 *   pool      ask_group or admin_ops, read as recruit from the pool, and
 *             tagged or spoken to MatchTime: the pool is asked
 *   group     ask_group, the club's own players: the players' group
 *   partners  recruit from a partner club
 *   approve   the router heard a YES (the safe-YES rule then decides)
 *   quiet     nothing leaves HQ (the organisers' own conversation)
 *   other     another route (a squad change, a question...)
 *
 * The rest of what the rewritten admin prompt already did is the existing
 * suites, one pass each: live-check-hq-outward, live-check-partner-ask-words,
 * live-check-free-places, live-check-hq-cancel, live-check-players-cancel;
 * and for the router's context, live-check-admin-group, hq-chatter,
 * hq-questions.
 *
 *   npx tsx --env-file=.env scripts/live-check-hq-pool.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext, type PendingWithLabel } from "../src/lib/admin-group-context.ts";
import { messageMentionsBotExplicitly } from "../src/lib/interaction-contract.ts";

const MAX_USD = 0.5;
spendDevApiKeyOrExit("the HQ pool live check");

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

type Got = "pool" | "group" | "partners" | "approve" | "quiet" | "other";
const ASKED = new Date("2026-10-27T15:30:00Z");
const NOTICE =
  "📋 *Squad for FNF, Tue 27 Oct at 20:00*: 6 of 7 in, 1 space.\nKickoff is getting close and the squad is still short.\n\n🔎 Or I can ask nearby players from the MatchTime pool (a few near you): reply YES here, or open the match page: https://matchtime.ai/matches/m1";
const POOL: PendingWithLabel = { ref: "pool-ask:m1", kind: "pool-ask", day: "Tue 27 Oct, 20:00", askedAt: ASKED };
const TEAMS: PendingWithLabel = { ref: "teams:m1", kind: "teams", day: "Tue 27 Oct", askedAt: ASKED };
const poolWaiting = { pending: [POOL], recent: [{ fromMatchTime: true, text: NOTICE }] };
const nothing = { pending: [] as PendingWithLabel[], recent: [] as Array<{ fromMatchTime: boolean; text: string }> };

const CASES: Array<{ text: string; ctx?: typeof nothing; want: Got[]; why: string }> = [
  // Asking the pool, in any wording (none of these is a worked example word for word).
  { text: "@Match Time ask the pool for a player", want: ["pool"], why: "the plain ask (an example)" },
  { text: "@Match Time can you ask the MatchTime pool, we're one short tonight", want: ["pool"], why: "the pool, the shortage stated" },
  { text: "@Match Time find someone nearby who can play tonight", want: ["pool"], why: "someone nearby" },
  { text: "@Match Time get us one from the app", want: ["pool"], why: "a player from the app" },
  { text: "can you get us a player from the MatchTime pool", want: ["pool"], why: "untagged instruction to MatchTime" },
  { text: "@Match Time try the player pool for Tuesday", want: ["pool"], why: "the player pool, a day named" },
  { text: "@Match Time havuza sor, bir kişi eksiğiz", want: ["pool"], why: "TR, the pool, the shortage" },
  // "yakında" alone reads as "soon"; "yakınlarda" / "yakındaki" is nearby.
  { text: "@Match Time yakınlarda oynayabilecek birini bul", want: ["pool"], why: "TR, someone nearby" },
  { text: "@Match Time uygulamadan bir oyuncu ayarla", want: ["pool"], why: "TR, a player from the app" },
  // Near misses: talk about the pool, questions to the others, a person asked.
  { text: "shall we try the pool?", want: ["quiet"], why: "the sender asks the others (an example)" },
  { text: "should we use the MatchTime pool this week or wait?", want: ["quiet"], why: "a discussion" },
  { text: "havuzu deneyelim mi?", want: ["quiet"], why: "TR, asks the others" },
  // The sender is Raihan: the person asked is someone else.
  { text: "@Hamzah can you ask the pool for one?", want: ["quiet"], why: "asks a person by tag" },
  { text: "the lad from the pool last week was decent", want: ["quiet"], why: "talk about the pool" },
  { text: "geçen haftaki havuz oyuncusu iyiydi", want: ["quiet"], why: "TR, talk about the pool (an example)" },
  // Other sources stay theirs.
  { text: "@Match Time ask the group if anyone can play", want: ["group"], why: "the players' group, unchanged" },
  { text: "@Match Time ask Sutton if anyone can play", want: ["partners"], why: "a partner club, unchanged" },
  { text: "@Match Time find us a player for Friday", want: ["group"], why: "no source named: the club's own group" },
  // A YES with the pool notice waiting (the router hears approve; code decides).
  { text: "yes", ctx: poolWaiting, want: ["approve"], why: "a bare yes" },
  { text: "go on then", ctx: poolWaiting, want: ["approve"], why: "natural yes" },
  { text: "yes please, ask them", ctx: poolWaiting, want: ["approve", "pool"], why: "yes with the ask restated" },
  { text: "evet sor", ctx: poolWaiting, want: ["approve"], why: "TR yes" },
  { text: "olur, sorun", ctx: poolWaiting, want: ["approve"], why: "TR yes, natural" },
  { text: "send it", ctx: poolWaiting, want: ["approve"], why: "send it" },
  { text: "yes", ctx: { pending: [TEAMS, POOL], recent: [{ fromMatchTime: true, text: NOTICE }] }, want: ["approve"], why: "two items waiting: approve, code asks which" },
  // While it waits, everything else is what it always was.
  { text: "who is bringing the bibs?", ctx: poolWaiting, want: ["quiet"], why: "chatter while it waits" },
  { text: "Tom out", ctx: poolWaiting, want: ["other"], why: "a squad change while it waits" },
  { text: "nah let's wait till the morning", ctx: poolWaiting, want: ["quiet"], why: "a no between organisers" },
];

async function main() {
  let pass = 0;
  let fail = 0;
  // ONLY=<substring>: re-run just the cases whose text contains it.
  const only = process.env.ONLY;
  for (const [i, c] of CASES.entries()) {
    if (only && !c.text.includes(only)) continue;
    const id = `p${i}`;
    const tagged = messageMentionsBotExplicitly({ body: c.text });
    const ctx = c.ctx ?? nothing;
    const context = organisersContext({ pending: ctx.pending, recent: ctx.recent });
    const r = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context, senderIsOrganiser: true } }], { floor: true });
    const route = r.routes[0]?.route ?? null;
    let got: Got = route === "approve" ? "approve" : route === "none" || route === null ? "quiet" : "other";
    let detail = "";
    if (route === "ask_group" || route === "admin_ops") {
      const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Raihan", tagged, history: [], lastBotPost: null });
      const f = ex.facts.kind === "admin" ? ex.facts : null;
      detail = ` -> ${f?.action ?? ex.facts.kind}${f?.pool ? " pool" : f?.partnerClubs ? ` partners "${f.clubRef ?? ""}"` : ""}, toMatchTime ${f?.toMatchTime === true}`;
      const asked = tagged || f?.toMatchTime === true;
      got = !asked
        ? "quiet"
        : f?.action === "recruit" && f.pool
          ? "pool"
          : f?.action === "recruit" && f.partnerClubs
            ? "partners"
            : route === "ask_group"
              ? "group"
              : "other";
    }
    const ok = c.want.includes(got);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}${c.ctx ? " (pool notice waiting)" : ""}  routed ${route}${detail}  => ${got}   (${c.why}; want ${c.want.join("|")})`);
  }
  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
