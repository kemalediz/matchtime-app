/**
 * CONVERSATIONAL REPLIES BEFORE BULK SENDS (FNF, 2026-10-16).
 *
 * THE CASE. At 22:39 London the fee release queued 16 pay-link DMs and a
 * summary to the collector. At 22:46 a player (Akram) DMed "I've
 * transferred already"; MatchTime queued "Thanks Akram, I've told
 * Raihan..." and a notice to the collector, and both waited about ten
 * minutes behind the pay links still queued. The player saw no
 * acknowledgement.
 *
 * WHY IT WAITED (traced):
 *   - The Pi sends at most ONE DM a minute (`DM_GAP_MS` in
 *     whatsapp-bot/src/scheduler.ts, `takeDmSlot`). On each tick it walks
 *     the server's instruction list IN ORDER: the first DM takes the slot,
 *     every later DM is released back (`releaseInstruction`) and comes back
 *     on the next poll. It never reorders.
 *   - The server builds that list in `computeDuePosts`
 *     (src/lib/bot-scheduler.ts). Queued BotJobs are read
 *     `orderBy: { createdAt: "asc" }, take: 20`, so a reply queued after a
 *     bulk batch is last, and one queued behind 20 bulk rows is not read at
 *     all until they drain.
 *   - The due-posts route (src/app/api/whatsapp/due-posts/route.ts) keeps
 *     that order: the new-club DM cap keeps the first N DMs, the claim
 *     keeps list order, and only the legacy platform bridge is put first.
 *
 * THE CHANGE, behind DM_REPLY_PRIORITY_ENABLED (off unless explicitly on):
 *   1. A BotJob that answers something a person has just sent is queued
 *      with `priority: 1` (`REPLY_PRIORITY`). Everything else keeps the
 *      column default 0. The column is written whether the flag is on or
 *      not; only the ORDER reads it, so with the flag off nothing a player
 *      sees changes.
 *   2. Flag on, the scheduler also reads due priority DMs that the
 *      createdAt-ordered 20 missed, plus any older unsent DM to the same
 *      phones (per-recipient order), and merges them in createdAt order.
 *   3. Flag on, `prioritiseReplyDms` moves those replies into the first DM
 *      slots of the list. Non-DM instructions keep their positions.
 *
 * PACING IS UNTOUCHED: the Pi still sends one DM a minute; only WHICH DM
 * takes the minute changes. PER-RECIPIENT ORDER IS KEPT: a reply never
 * overtakes an earlier DM to the same phone; that earlier DM moves up with
 * it, immediately before it.
 */

export const BOTJOB_PRIORITY_DEFAULT = 0;
export const BOTJOB_PRIORITY_REPLY = 1;

/** Spread into a `db.botJob.create({ data })` that answers a person. */
export const REPLY_PRIORITY = { priority: BOTJOB_PRIORITY_REPLY } as const;

/** TEST SEAM, the same double gate as picture-reading-flag.ts: honoured
 *  only when the server was booted with MT_TEST_MODE exactly "1". */
export const DM_REPLY_PRIORITY_TEST_HEADER = "x-mt-test-dm-reply-priority";

export function isDmReplyPriorityEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.DM_REPLY_PRIORITY_ENABLED ?? "").trim());
}

export function dmReplyPriorityEnabledForApiRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MT_TEST_MODE === "1") {
    const v = request.headers.get(DM_REPLY_PRIORITY_TEST_HEADER);
    if (v === "1") return true;
    if (v === "0") return false;
  }
  return isDmReplyPriorityEnabled(env);
}

const bare = (phone: string | undefined, key: string) => (phone ? phone.replace(/^\+/, "") : `no-phone:${key}`);

/**
 * Put reply DMs into the first DM slots of the list.
 *
 * For each reply, in list order: every not-yet-placed DM to the same phone
 * that comes before it (in list order), then the reply. Then every other
 * DM, in list order. Non-DM instructions keep their indices; DMs are only
 * permuted among the DM indices. With no reply in the list, the SAME
 * array is returned untouched.
 */
export function prioritiseReplyDms<T extends { kind: string; key: string; phone?: string }>(
  instructions: T[],
  replyKeys: ReadonlySet<string>,
): T[] {
  const dmSlots: number[] = [];
  for (let i = 0; i < instructions.length; i++) if (instructions[i].kind === "dm") dmSlots.push(i);
  const dms = dmSlots.map((i) => instructions[i]);
  if (!dms.some((d) => replyKeys.has(d.key))) return instructions;

  const placed = new Array<boolean>(dms.length).fill(false);
  const ordered: T[] = [];
  for (let j = 0; j < dms.length; j++) {
    if (!replyKeys.has(dms[j].key) || placed[j]) continue;
    const phone = bare(dms[j].phone, dms[j].key);
    for (let k = 0; k <= j; k++) {
      if (!placed[k] && bare(dms[k].phone, dms[k].key) === phone) {
        placed[k] = true;
        ordered.push(dms[k]);
      }
    }
  }
  for (let j = 0; j < dms.length; j++) if (!placed[j]) ordered.push(dms[j]);

  const out = instructions.slice();
  for (let s = 0; s < dmSlots.length; s++) out[dmSlots[s]] = ordered[s];
  return out;
}

/** Union of BotJob batches: deduped by id, oldest first, ties in the
 *  order first seen (the first batch is today's query). */
export function mergeBotJobBatches<T extends { id: string; createdAt: Date }>(...batches: T[][]): T[] {
  const seen = new Set<string>();
  const all: { j: T; i: number }[] = [];
  for (const batch of batches) {
    for (const j of batch) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      all.push({ j, i: all.length });
    }
  }
  return all.sort((a, b) => a.j.createdAt.getTime() - b.j.createdAt.getTime() || a.i - b.i).map(({ j }) => j);
}
