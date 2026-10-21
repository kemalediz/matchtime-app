/**
 * LIVE check for answering the partner-club pairing notice in WhatsApp
 * (2026-10-21). Kemal's rule (2026-10-18): every LLM change gets real
 * paid tests on the dev key, the cheap plan, calls and cost reported.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-pairing-reply.ts
 *
 * Two parts, each case ONCE:
 *
 *   1. the new pairing classifier (`classifyPairingReply`, Haiku 5.5): a
 *      bare "1" or "2" swipe-replied to the notice, yes / no / evet /
 *      hayır, a ✅, and the replies that must change nothing (a question
 *      about it, "no worries", a "1" whose newest message is something
 *      else), in English and Turkish, with the notice's real words from
 *      the string tables;
 *   2. the SHARED ROUTER, unchanged, shown the new WAITING line in the
 *      admin group: a YES to the pairing still routes `approve`, and the
 *      organisers' own chat around it does not.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Stops at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { classifyPairingReplyDetailed, type PairingIntent } from "../src/lib/pairing-reply.ts";
import { t } from "../src/lib/i18n/t.ts";
import { pickRecentBotMessages, type ContextMessage, type ReplyContext } from "../src/lib/reply-context.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { organisersContext, type PendingWithLabel } from "../src/lib/admin-group-context.ts";
import type { Route } from "../src/lib/pipeline/types.ts";
import { HAIKU_CLASSIFIER_ARM, meter } from "./dm-dryrun-meter.ts";

const MAX_USD = 0.6;
const NOW = new Date("2026-10-21T15:10:00Z");
const SENT = new Date("2026-10-21T15:00:00Z");

const notice = (lang: "en" | "tr", inGroup = false) =>
  t(lang).pc_paired_notice_asker({ club: "Friday MT Community", other: "MT Test", link: "https://matchtime.example/s/abc", inGroup });
const msg = (text: string, at = SENT): ContextMessage => ({ at, text, topic: null, match: null });
const quoting = (m: ContextMessage): ReplyContext => ({ now: NOW, quoted: m, recent: [], earlier: null });
const recent = (...m: ContextMessage[]): ReplyContext => ({ now: NOW, quoted: null, ...pickRecentBotMessages(m, NOW) });
const RATING = msg("⭐ Rate your teammates from Tuesday's game: https://matchtime.example/r/xyz", new Date("2026-10-21T15:05:00Z"));

interface Case {
  text: string;
  want: PairingIntent;
  ctx: ReplyContext;
  why: string;
}

const CASES: Case[] = [
  // The case this change exists for: a bare number swipe-replied to the notice.
  { text: "1", want: "accept", ctx: quoting(msg(notice("en"))), why: "bare 1, quoted (EN)" },
  { text: "2", want: "decline", ctx: quoting(msg(notice("en"))), why: "bare 2, quoted (EN)" },
  { text: "1", want: "accept", ctx: quoting(msg(notice("tr"))), why: "bare 1, quoted (TR)" },
  { text: "2", want: "decline", ctx: quoting(msg(notice("tr"))), why: "bare 2, quoted (TR)" },
  { text: "1", want: "accept", ctx: recent(msg(notice("en"))), why: "bare 1, the notice is the newest DM" },
  // The words Kemal named: yes, accept, evet, no, a tick.
  { text: "yes", want: "accept", ctx: quoting(msg(notice("en"))), why: "yes" },
  { text: "accept", want: "accept", ctx: recent(msg(notice("en"))), why: "accept, unquoted" },
  { text: "✅", want: "accept", ctx: quoting(msg(notice("en"))), why: "a tick typed" },
  { text: "evet", want: "accept", ctx: quoting(msg(notice("tr"))), why: "evet" },
  { text: "tamam kabul ediyorum", want: "accept", ctx: recent(msg(notice("tr"))), why: "TR go-ahead" },
  { text: "no", want: "decline", ctx: quoting(msg(notice("en"))), why: "no" },
  { text: "no thanks, we're fine on our own", want: "decline", ctx: recent(msg(notice("en"))), why: "a plain refusal" },
  { text: "hayır", want: "decline", ctx: quoting(msg(notice("tr"))), why: "hayır" },
  // Must change nothing.
  { text: "what does this mean?", want: "neither", ctx: quoting(msg(notice("en"))), why: "a question about it" },
  { text: "who runs MT Test?", want: "neither", ctx: recent(msg(notice("en"))), why: "a question about the other club" },
  { text: "no worries mate, thanks", want: "neither", ctx: recent(msg(notice("en"))), why: "the no in no worries" },
  { text: "let me think about it", want: "neither", ctx: quoting(msg(notice("en"))), why: "deciding later" },
  { text: "bir düşüneyim", want: "neither", ctx: quoting(msg(notice("tr"))), why: "deciding later (TR)" },
  { text: "1", want: "neither", ctx: recent(msg(notice("en")), RATING), why: "a 1 whose newest message is the rating DM" },
  { text: "I'm in for Friday", want: "neither", ctx: recent(msg(notice("en"))), why: "attendance, not an answer" },
];

// ── The shared router in HQ, with the new WAITING line ──
const PAIRING_WAITING: PendingWithLabel[] = [
  { ref: "pairing:p1:friday", kind: "pairing", day: null, club: "MT Test", ownClub: "Friday MT Community", askedAt: SENT },
];
const HQ: Array<{ text: string; want: Route[]; recent?: Array<{ fromMatchTime: boolean; text: string }>; why: string }> = [
  { text: "yes", want: ["approve"], recent: [{ fromMatchTime: true, text: notice("en", true) }], why: "a yes, the next message" },
  { text: "1", want: ["approve"], recent: [{ fromMatchTime: true, text: notice("en", true) }], why: "a bare 1, the next message" },
  { text: "accept", want: ["approve"], recent: [{ fromMatchTime: true, text: notice("en", true) }], why: "accept" },
  { text: "evet", want: ["approve"], recent: [{ fromMatchTime: true, text: notice("tr", true) }], why: "evet" },
  { text: "who's bringing the bibs on friday?", want: ["none"], recent: [{ fromMatchTime: true, text: notice("en", true) }], why: "organisers' own chat must stay none" },
  { text: "has anyone heard of MT Test before?", want: ["none", "question"], recent: [{ fromMatchTime: true, text: notice("en", true) }], why: "talk about it is not a yes" },
];

async function main() {
  const m = meter("the pairing-reply dry run", HAIKU_CLASSIFIER_ARM, MAX_USD);
  let pass = 0;
  let fail = 0;
  console.log(`\n== Pairing classifier: ${CASES.length} cases, each once ==\n`);
  for (const c of CASES) {
    const r = await classifyPairingReplyDetailed(c.text, { pairings: [{ club: "Friday MT Community", other: "MT Test" }], replyContext: c.ctx }, m.call);
    const ok = r.intent === c.want;
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text).padEnd(40)} -> ${r.intent} (${r.confidence.toFixed(2)})  want ${c.want}  [${c.why}]  ${r.reasoning}`);
  }
  console.log(`\nclassifier: ${m.summary()}`);

  spendDevApiKeyOrExit("the pairing-reply dry run (router)");
  let rCalls = 0;
  let rUsd = 0;
  const inner = anthropicModel();
  const model: PipelineModel = {
    name: "metered",
    async complete(req) {
      if (rUsd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
      const r = await inner.complete(req);
      rCalls++;
      rUsd += r.costUsd ?? 0;
      return r;
    },
  };
  console.log(`\n== Shared router in the admin group, pairing waiting: ${HQ.length} cases, each once ==\n`);
  for (const [i, c] of HQ.entries()) {
    const context = organisersContext({ pending: PAIRING_WAITING, recent: c.recent ?? [] });
    const r = await routeBatch(model, [{ id: `hq${i}`, authorName: "Kemal", body: c.text, organisers: { context } }], { floor: true });
    const route = r.routes[0]?.route;
    const ok = !!route && c.want.includes(route);
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text).padEnd(40)} routed ${route}  want ${c.want.join("|")}  [${c.why}]`);
  }
  console.log(`\nrouter: ${rCalls} calls, $${rUsd.toFixed(4)}`);
  console.log(`\nTOTAL: ${pass} pass, ${fail} fail; ${m.calls() + rCalls} model calls`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
