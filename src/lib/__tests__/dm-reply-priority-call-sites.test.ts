/**
 * SOURCE GUARD: which BotJobs are conversational replies
 * (src/lib/dm-reply-priority.ts, FNF 2026-10-16).
 *
 * `REPLY_PRIORITY` marks a DM that answers something a person has JUST
 * sent. While DM_REPLY_PRIORITY_ENABLED is on such a DM takes the next of
 * the Pi's one-a-minute DM slots, ahead of every pay link and reminder.
 * That is only fair while it stays rare: a bulk path marked by mistake
 * would jump every queue it is in. So the marked sites are an ALLOWLIST,
 * counted per file: adding one means editing this file, on purpose, in
 * review. The bulk senders are pinned unmarked.
 *
 * The behaviour of the order itself is in dm-reply-priority.test.ts and
 * dm-reply-priority-scheduler.test.ts; the payment-claim path end to end in
 * e2e/api/dm-reply-priority.spec.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const uses = (src: string) => (stripComments(src).match(/\.\.\.REPLY_PRIORITY\b/g) ?? []).length;

/** File → how many BotJob creates in it are conversational replies. */
const MARKED: Record<string, number> = {
  // Every reply the dm-reply route queues itself: the bench-offer
  // clarification and ack, the DM-subscription ack, the tentative re-ask
  // and ack, the collector's fee-reply answer, the admin-command answer,
  // the scoped Q&A answer, the roster-survey clarification and
  // confirmation. (The recruit BLAST the admin command triggers is
  // queued by recruit.ts, unmarked.) And the owner's answer to the
  // partner-club pairing notice (2026-10-21).
  "app/api/whatsapp/dm-reply/route.ts": 11,
  // "DM me <question>" answered privately, and the stats link a player
  // asked for. (The stats BLAST to every member stays unmarked.)
  "app/api/whatsapp/analyze/route.ts": 2,
  // "Thanks Akram, I've told Raihan..." (the FNF case).
  "lib/payment-claim.ts": 1,
  // The collector's notice about a claim ("says they've paid you
  // directly"), from a "Paid" DM or the pay page's button.
  "lib/direct-payment.ts": 1,
  // The collector's "links sent" ack to his ✅ REACTION on the fee
  // confirm prompt (the same ack the dm-reply route queues for a typed yes).
  "lib/fee-confirm-reaction.ts": 1,
  // The owner's ack to a ✅/👍 REACTION on the pairing notice (2026-10-21).
  "lib/pairing-reply.ts": 1,
  // Monthly squad: the player's claim ack, and the collector's answer
  // to their own "PAID ..." reply. (The daily claims digest is unmarked.)
  "lib/month-payment.ts": 2,
  // The organiser's pick reply: the answer to them, and the line to the
  // other organisers about it.
  "lib/organiser-pick.ts": 2,
  // "help" by DM.
  "lib/dm-help.ts": 1,
  // The guest's "which game?" question after his OUT by DM.
  "lib/partner-guest-dm.ts": 1,
  // The guest's ack after he withdrew by DM.
  "lib/partner-guest.ts": 1,
  // The ack to a player's own IN/OUT by DM or reaction.
  "lib/out-of-band-self-attendance.ts": 1,
};

/** Bulk and scheduled senders: never marked. */
const NEVER_MARKED = [
  "lib/payment-flow.ts", // the pay links
  "lib/recruit.ts", // recruit blasts
  "lib/seed-nudge.ts",
  "lib/month-signup.ts",
  "lib/month-close.ts",
  "lib/admin-channel.ts", // sendAdminNotice: digests, summaries, notices
  "lib/bot-scheduler.ts",
  "lib/stats-blast.ts",
  "lib/squad-announce.ts",
  "lib/team-proposal.ts",
];

describe("REPLY_PRIORITY call sites", () => {
  const files = walk(SRC);

  it("exactly the allowlisted files mark replies, with the allowlisted counts", () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      if (rel(f) === "lib/dm-reply-priority.ts") continue;
      const n = uses(readFileSync(f, "utf8"));
      if (n > 0) found[rel(f)] = n;
    }
    expect(found).toEqual(MARKED);
  });

  it("the bulk senders are never marked", () => {
    for (const f of NEVER_MARKED) {
      const full = path.join(SRC, f);
      let src = "";
      try {
        src = readFileSync(full, "utf8");
      } catch {
        continue; // a file that does not exist cannot be marked
      }
      expect(uses(src), f).toBe(0);
    }
  });
});
