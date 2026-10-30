/**
 * Squad-from-pasted-list extraction (Amir's Thursday group shape,
 * 2026-05-20).
 *
 * Some groups don't say IN/OUT — instead, every player copies the
 * latest numbered squad message, appends their own line, and re-pastes
 * the whole list. The bot derives the squad from that ritual.
 *
 * The core insight is that the group is ALREADY labelling the data for
 * the bot, for free. When `~T` posts a list and the diff vs the previous
 * one is "8. Tharan", that single message tells us: the WhatsApp account
 * whose pushname is "T" goes by "Tharan". That's a ground-truth UserAlias
 * — solved without fuzzy-matching (which could never bridge "T" → "Tharan").
 * Other additions in the same message are guests signed in by that sender.
 *
 * Pipeline (no regex on user-typed in/out anywhere; LLM extracts, code
 * attributes):
 *
 *   1. One LLM call (Haiku 5.5, ≤1×/30min/match) over the stored
 *      `GroupMessage` rows for the org SINCE the previous match
 *      ended → returns which messages are squad-list-shaped + the
 *      parsed numbered names + reserves. The "since previous match end"
 *      boundary matters because Amir's group often starts pasting the
 *      NEXT week's list within minutes of the final whistle; a fixed
 *      rolling window would either chop those off or drag in stale
 *      lists from before the previous match (which were the squad-of-
 *      record for THAT match, not the next one).
 *   2. Sort lists chronologically. For each consecutive pair, diff
 *      added names. Attribute additions to the sending phone+pushname.
 *      Self-addition (matches the sender's pushname) → ground-truth
 *      UserAlias. Other additions → guest additions, signed in by that
 *      sender (no auto-alias; provisioned only when we need to DM them
 *      at kickoff resolution).
 *   3. At kickoff: take the LATEST list, resolve each name through the
 *      existing chain (exact → fuzzy → UserAlias → provision), write
 *      Attendance rows. Unresolved with no phone surface in
 *      /admin/players where the admin can fill in numbers (same flow
 *      Sutton uses for phone-less players).
 *
 * Falls open: any LLM failure short-circuits the extraction (no
 * Attendance writes, no alias damage). Re-run on the next cron tick.
 */
import { db } from "./db";
import { recordAttendanceEvent } from "./attendance-events";
import { normalisePhone } from "./phone";
import { normaliseName } from "./name-normalise";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "@/lib/pipeline/llm";
import { withOrgAiBudget } from "./ai-budget";
export { normaliseName };

/**
 * THE MODEL: Haiku 5.5 through `pipeline/llm.ts`, adaptive thinking at
 * medium (2026-10-21; `HAIKU_CALL`), after a whole rewrite of the prompt.
 * It was Sonnet 5 with thinking off. Paid check:
 * `scripts/live-check-squad-from-list.ts`.
 */
export const SQUAD_LIST_CALL: ModelCall = HAIKU_CALL;
/** The pipeline's ceiling. A fortnight of re-pastes (20 lists up to 16
 *  names) used about 2,200 tokens, thinking included, on the live check; the rest is
 *  room for Haiku's thinking, which shares the budget. A cut-off answer
 *  throws and the reading returns no lists, as on any failure. */
const MAX_TOKENS = 4_096;

/** Hard CAP on how far back the squad-extraction window can stretch,
 *  regardless of when the previous match ended. The window normally
 *  starts at the previous match's end time (see `computeSinceForOrg`),
 *  so this cap only kicks in for first-ever matches or after a long
 *  dormant gap (org skipped weeks). 21 days is generous enough to span
 *  a fortnight-off + the build-up to the next match, while still
 *  bounding LLM context + DB scan cost on a group that's been silent
 *  for months. */
export const MAX_WINDOW_DAYS = 21;

export interface ParsedList {
  waMessageId: string;
  /** Sender's phone (E.164 without `+`, or null when @lid). */
  senderPhone: string | null;
  senderPushname: string | null;
  timestamp: Date;
  /** Numbered playing squad, in list order. */
  names: string[];
  /** Reserves / subs / standbys block, in list order. */
  reserves: string[];
}

export interface Attribution {
  waMessageId: string;
  senderPhone: string | null;
  senderPushname: string | null;
  timestamp: Date;
  /** Names this sender added vs the previous list (or the whole list
   *  if this is the seed). */
  addedNames: string[];
  addedReserves: string[];
  /** The addition that matches the sender's pushname — i.e. the sender
   *  added their own name. Becomes a UserAlias.  */
  selfAddition: string | null;
  /** Non-self additions — guests signed in by this sender. */
  guestAdditions: string[];
}

export const SQUAD_LIST_SYSTEM = `Some sports groups keep their squad by re-posting a numbered list: each player copies the latest list, adds their name (or a friend's) on the next line and posts the whole list again. You read those lists out of the group's messages so MatchTime knows who is playing.

You are given the group's MESSAGES, oldest first, each under a short id (m1, m2, ...). They may be in English or Turkish.

Return "lists": one entry for each message that is a squad list, and none for any other message.
- id: the message's id, exactly as given.
- names: the playing squad, in list order, one entry per numbered line that has a name on it.
- reserves: the names under a "Reserves", "Subs", "Standby" or "Yedekler" heading in the same message, in order. [] when there is no such heading.

A squad list is several numbered lines naming the people playing one upcoming game, often under a heading with the day, time or place. The numbers may be "1.", "1)", "1-" or emoji digits ("1️⃣"), and WhatsApp often leaves invisible spacing characters between the number and the name.

Not a squad list: stats or a leaderboard (votes, percentages, wins, man of the match); two teams for one match ("Reds" and "Yellows", "Beyaz" and "Siyah"); numbered questions or answers ("1. yes 2. no"); chat that mentions a number.

Reading a line:
- Drop the number, the invisible characters and any emoji, and keep the name as typed, spelling and case included ("youssef" stays "youssef", "NABEEL" stays "NABEEL").
- A note after the name is not part of it: "Rob (GK)" is "Rob", "Dev - 10 mins late" is "Dev", "Ash ✅" is "Ash".
- A guest stays as written: "Liam's mate Craig", "Ali'nin arkadaşı".
- A numbered line with no name on it is an empty place: leave it out.

Every re-post is its own entry, even when it differs from the one before by a single line; the comparison is done afterwards. A Reserves block belongs to the list above it in the same message, never to an entry of its own.

Examples (English / Turkish):
- "Thursday 9pm Goals\\n1. Ehtisham\\n2. Amir\\n\\nReserves:\\n1. Martin" / "Cuma 21:00 Halısaha\\n1. Erdal\\n2. Mehmet\\n\\nYedekler:\\n1. Volkan": names ["Ehtisham","Amir"], reserves ["Martin"] / names ["Erdal","Mehmet"], reserves ["Volkan"]
- "1️⃣ Kev\\n2️⃣ Jono (GK)\\n3️⃣" / "1) Burak ✅\\n2) Emre - geç gelir": names ["Kev","Jono"] / ["Burak","Emre"]
- "MoM votes:\\n1. Pete 4 (40%)\\n2. Dan 3" / "Takımlar:\\nBeyaz: Erdal, Mehmet\\nSiyah: Emre, Can": not a squad list`;


const SCHEMA = {
  type: "object",
  properties: {
    lists: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          names: { type: "array", items: { type: "string" } },
          reserves: { type: "array", items: { type: "string" } },
        },
        required: ["id", "names", "reserves"],
        additionalProperties: false,
      },
    },
  },
  required: ["lists"],
  additionalProperties: false,
} as const;

interface LLMResponse {
  lists: Array<{
    /** The short id the model was shown (m1, m2, ...). */
    id: string;
    names?: string[];
    reserves?: string[];
  }>;
}

/** The short id the model sees for the i-th message (0-based). The
 *  WhatsApp id is long and was echoed back on every list, which is
 *  output tokens for nothing; the code maps the short id back. */
const shortId = (i: number) => `m${i + 1}`;

// `normaliseName` MOVED to `lib/name-normalise.ts` (2026-09-07) and is
// re-exported at the top of this file so every existing importer is
// untouched. It is pure; this file is not (Prisma + the Anthropic SDK),
// and `pasted-roster.ts` wanted the folding rule without the database.
// Read that module's header for the failure that forced it.

/** Compute the lower bound of the extraction window for an org.
 *
 *  Rule (in priority order):
 *    1. The end time of the most recent prior match (`date +
 *       activity.matchDurationMins`). This is the right boundary
 *       because the group's copy-paste ritual for NEXT week's squad
 *       often starts within minutes of THIS week's final whistle, and
 *       any list pasted BEFORE the previous match was the squad-of-
 *       record for THAT match — pulling it in would risk overwriting
 *       the upcoming match with stale data. Excludes
 *       `isHistorical: true` matches (synthetic backfill anchors,
 *       no real end time).
 *    2. Bootstrap (no prior match for the org — first match ever):
 *       the timestamp of the earliest archived GroupMessage. This
 *       way we use everything we've stored, never less.
 *    3. Floor at `MAX_WINDOW_DAYS` back. Even if the previous match
 *       was 3 months ago (dormant group), we cap the scan so the LLM
 *       context + DB read stay bounded.
 *
 *  `cutoffDate` is the upper exclusive bound on "what counts as
 *  previous". When finalising for a specific upcoming match, pass
 *  THAT match's date (so the match we're processing doesn't end up
 *  selected as its own predecessor). Otherwise pass `new Date()`.
 */
export async function computeSinceForOrg(
  orgId: string,
  cutoffDate: Date,
): Promise<Date> {
  const minSince = new Date(Date.now() - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const previousMatch = await db.match.findFirst({
    where: {
      activity: { orgId },
      isHistorical: false,
      date: { lt: cutoffDate },
    },
    orderBy: { date: "desc" },
    include: { activity: { select: { matchDurationMins: true } } },
  });

  let since: Date;
  if (previousMatch) {
    since = new Date(
      previousMatch.date.getTime() +
        previousMatch.activity.matchDurationMins * 60_000,
    );
  } else {
    const earliest = await db.groupMessage.findFirst({
      where: { orgId },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true },
    });
    since = earliest?.timestamp ?? minSince;
  }
  return since < minSince ? minSince : since;
}

/** One stored group message, as the reading needs it. */
export interface SourceMessage {
  waMessageId: string;
  body: string;
  senderPhone: string | null;
  senderPushname: string | null;
  timestamp: Date;
}

/** PURE. The user turn: every message in the window, oldest first,
 *  under its short id, with its lines intact. */
export function pastedListUserTurn(messages: SourceMessage[]): string {
  return [
    `MESSAGES (${messages.length}, oldest first):`,
    ...messages.map((m, i) => `\n[${shortId(i)}]\n${m.body.slice(0, 4000)}`),
  ].join("\n");
}

/** Run the one-shot LLM extraction over a window of stored
 *  GroupMessage rows. Falls open (returns []) on any error so a single
 *  flaky run doesn't poison the queue — the next cron tick will retry. */
export async function extractSquadListsFromWindow(
  orgId: string,
  since: Date,
): Promise<ParsedList[]> {
  const messages = await db.groupMessage.findMany({
    where: { orgId, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
  });
  if (messages.length === 0) return [];
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.warn("[squad-from-list] ANTHROPIC_API_KEY missing — skipping extraction");
    return [];
  }
  // Spent from this club (the daily AI cap, lib/ai-budget.ts). At the
  // cap the call is refused and the reading returns no lists, like any
  // other failure; the next run tries again.
  return withOrgAiBudget(orgId, () => readSquadLists(messages));
}

/**
 * The reading itself, with no database: one model call over the
 * messages, joined back onto them. Falls open to [] on any failure.
 */
export async function readSquadLists(
  messages: SourceMessage[],
  deps?: { model?: PipelineModel },
): Promise<ParsedList[]> {
  if (messages.length === 0) return [];
  let parsed: LLMResponse | null = null;
  try {
    const model = deps?.model ?? anthropicModel();
    const resp = await model.complete({
      ...SQUAD_LIST_CALL,
      system: SQUAD_LIST_SYSTEM,
      user: pastedListUserTurn(messages),
      maxTokens: MAX_TOKENS,
      schema: SCHEMA as unknown as Record<string, unknown>,
      label: "squad-from-list",
    });
    parsed = extractJson(resp.text) as LLMResponse;
  } catch (err) {
    console.error("[squad-from-list] LLM extraction failed:", err);
    return [];
  }

  if (!parsed?.lists?.length) return [];

  // Re-join the LLM's parsed names back onto the source messages (so we
  // recover senderPhone / senderPushname / timestamp which the LLM never
  // saw). Drop any list it produced that isn't actually a list, or whose
  // waMessageId doesn't match anything in the window.
  //
  // If the LLM splits one message into multiple "lists" entries (it
  // sometimes treats the trailing "Reserves:" block as a separate list,
  // despite the prompt — flagged 2026-05-20 during the harness build),
  // merge them by waMessageId: the longest "names" wins as the playing
  // squad; everything else from that message becomes additional reserves.
  const byShortId = new Map(messages.map((m, i) => [shortId(i), m]));
  const byId = new Map(messages.map((m) => [m.waMessageId, m]));
  const groupedByWaId = new Map<string, Array<{ names: string[]; reserves: string[] }>>();
  for (const l of parsed.lists) {
    const src = typeof l.id === "string" ? byShortId.get(l.id.trim()) : undefined;
    if (!src) continue;
    const names = (l.names ?? []).map((s) => s.trim()).filter(Boolean);
    const reserves = (l.reserves ?? []).map((s) => s.trim()).filter(Boolean);
    if (names.length === 0 && reserves.length === 0) continue;
    const arr = groupedByWaId.get(src.waMessageId) ?? [];
    arr.push({ names, reserves });
    groupedByWaId.set(src.waMessageId, arr);
  }

  const out: ParsedList[] = [];
  for (const [waId, parts] of groupedByWaId) {
    const src = byId.get(waId)!;
    // Primary = entry with most names (the playing squad). Everything
    // else collapses into reserves.
    parts.sort((a, b) => b.names.length - a.names.length);
    const primary = parts[0];
    const extraNames = parts.slice(1).flatMap((p) => p.names);
    const extraReserves = parts.flatMap((p) => p.reserves);
    if (primary.names.length < 2 && extraNames.length === 0) continue; // noise
    const reserves = [...extraNames, ...extraReserves];
    const names = primary.names;

    // The reserves are the model's reading alone (SQUAD_LIST_SYSTEM's
    // `reserves`): the regex backstop over the body that stood here
    // (`parseReservesFromBody`) is deleted (2026-10-30, no string parsing).

    out.push({
      waMessageId: waId,
      senderPhone: src.senderPhone,
      senderPushname: src.senderPushname,
      timestamp: src.timestamp,
      names,
      reserves,
    });
  }
  // Sort by timestamp ascending (the LLM output order is not guaranteed).
  out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return out;
}

/** Compute diff-based attribution: for each consecutive pair of lists,
 *  which names did THIS sender add, and which one (if any) is the
 *  sender themselves? Deterministic — no LLM. */
export function attributeDiffs(lists: ParsedList[]): Attribution[] {
  const out: Attribution[] = [];
  for (let i = 0; i < lists.length; i++) {
    const cur = lists[i];
    const prev = lists[i - 1] ?? null;

    const prevSet = new Set<string>();
    if (prev) {
      for (const n of prev.names) prevSet.add(normaliseName(n));
      for (const n of prev.reserves) prevSet.add(normaliseName(n));
    }

    const addedNames = cur.names.filter((n) => !prevSet.has(normaliseName(n)));
    const addedReserves = cur.reserves.filter((n) => !prevSet.has(normaliseName(n)));

    // Identify the sender's own contribution. Restricted to additions
    // in the PLAYING squad — a sender doesn't put their own name in
    // the Reserves section, so any reserve addition is by construction
    // a guest they're signing in (e.g. Amir adding 'Martin' to
    // Reserves is Amir-signing-in-Martin, NOT Amir-aliasing-as-Martin).
    //
    // Matching logic for addedNames:
    //   - exact equality (normalised), or
    //   - one side is a startsWith-prefix of the other and the longer
    //     side is ≥ 3 chars (handles "Nabeel" ↔ "NABEEL", "youssef" ↔
    //     "Youssef"), or
    //   - the lone addition with no string overlap (the "~T → Tharan"
    //     ground-truth case where fuzzy could never bridge).
    let selfAddition: string | null = null;
    const guestAdditions: string[] = [];

    const pushNorm = cur.senderPushname ? normaliseName(cur.senderPushname) : "";
    if (pushNorm && addedNames.length > 0) {
      let best: { name: string; score: number } | null = null;
      for (const name of addedNames) {
        const n = normaliseName(name);
        let score = 0;
        if (n === pushNorm) score = 3;
        else if (
          (n.startsWith(pushNorm) && n.length >= 3) ||
          (pushNorm.startsWith(n) && pushNorm.length >= 3)
        )
          score = 2;
        if (
          score > 0 &&
          (!best ||
            score > best.score ||
            (score === best.score && n.length > normaliseName(best.name).length))
        ) {
          best = { name, score };
        }
      }
      // No string-overlap match found but there's exactly ONE
      // playing-squad addition: by the group's ritual that's
      // overwhelmingly likely to be the sender themselves under a
      // different name (the "~T → Tharan" scenario).
      if (!best && addedNames.length === 1) {
        best = { name: addedNames[0], score: 1 };
      }
      if (best) {
        selfAddition = best.name;
        for (const name of addedNames) {
          if (name !== best.name) guestAdditions.push(name);
        }
      } else {
        guestAdditions.push(...addedNames);
      }
    } else {
      // No pushname OR no playing-squad additions (e.g. sender only
      // added someone to Reserves): everything in addedNames falls to
      // guest. Their own alias will be learned later when they appear
      // as someone else's addition or sign themselves in solo.
      guestAdditions.push(...addedNames);
    }

    // Reserves are ALWAYS guests of the sender (people don't put
    // themselves in their own Reserves section).
    guestAdditions.push(...addedReserves);

    out.push({
      waMessageId: cur.waMessageId,
      senderPhone: cur.senderPhone,
      senderPushname: cur.senderPushname,
      timestamp: cur.timestamp,
      addedNames,
      addedReserves,
      selfAddition,
      guestAdditions,
    });
  }
  return out;
}

/** Learn / upsert UserAliases from the attribution pass. For each
 *  sender whose self-addition we identified:
 *    - resolve the sender to a User (by phone if known, else by
 *      pushname-as-alias if already mapped).
 *    - if no User exists yet but the sender has a known phone, create
 *      a User+Membership (provisional) so we have somewhere to attach
 *      the alias.
 *    - upsert UserAlias(orgId, alias=normalisedSelfAddition, userId,
 *      source="auto-detect").
 *
 *  Idempotent (re-running over the same window does nothing new).
 *  Never overwrites a hand-curated alias (`source != "auto-detect"`). */
export async function learnAliasesFromAttribution(
  orgId: string,
  attributions: Attribution[],
): Promise<{ aliasesLearned: number; usersProvisioned: number }> {
  let aliasesLearned = 0;
  let usersProvisioned = 0;

  for (const a of attributions) {
    if (!a.selfAddition) continue;

    // 1. Find the sender's User. Phone is the strongest signal.
    let userId: string | null = null;
    if (a.senderPhone) {
      const phone = normalisePhone(
        a.senderPhone.startsWith("+") ? a.senderPhone : `+${a.senderPhone}`,
      );
      if (phone) {
        const u = await db.user.findUnique({
          where: { phoneNumber: phone },
          select: { id: true },
        });
        if (u) userId = u.id;
      }
    }
    // 2. If still no User and we know a pushname, see if an alias for
    //    it already exists in this org (could have been learned by an
    //    earlier diff in this same pass — order-dependence is fine).
    if (!userId && a.senderPushname) {
      const aliasKey = normaliseName(a.senderPushname);
      if (aliasKey.length >= 2) {
        const alias = await db.userAlias.findUnique({
          where: { orgId_alias: { orgId, alias: aliasKey } },
        });
        if (alias) userId = alias.userId;
      }
    }
    // 3. If still no User but we DO have a phone, provision: create a
    //    User + Membership with the phone and the SELF-ADDITION as the
    //    name (since they typed it themselves, it's the most accurate
    //    label we have).
    if (!userId && a.senderPhone) {
      const phone = normalisePhone(
        a.senderPhone.startsWith("+") ? a.senderPhone : `+${a.senderPhone}`,
      );
      if (phone && a.selfAddition.trim().length >= 2) {
        try {
          // Reuse a User on this phone from another org if it exists.
          let user = await db.user.findUnique({ where: { phoneNumber: phone } });
          if (!user) {
            const emailSlug =
              a.selfAddition
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "") || "player";
            const syntheticEmail = `provisional+${emailSlug}-${Date.now().toString(36)}@matchtime.local`;
            user = await db.user.create({
              data: {
                name: a.selfAddition.trim(),
                email: syntheticEmail,
                phoneNumber: phone,
                onboarded: false,
                isActive: true,
              },
            });
            usersProvisioned++;
          }
          await db.membership.upsert({
            where: { userId_orgId: { userId: user.id, orgId } },
            create: {
              userId: user.id,
              orgId,
              role: "PLAYER",
              provisionallyAddedAt: new Date(),
            },
            update: { leftAt: null }, // someone re-appearing
          });
          userId = user.id;
        } catch (err) {
          console.error("[squad-from-list] provisional user create failed:", err);
        }
      }
    }
    if (!userId) {
      // No phone, no existing alias for the pushname — can't anchor an
      // alias to anyone. Skip; we'll learn this sender when they appear
      // as someone else's addition (or post solo with a phone).
      continue;
    }

    // 4. Upsert the alias. Unique on (orgId, alias). If an existing row
    //    points to a different userId we don't clobber — that case
    //    means two different phones both typed the same name, which is
    //    almost certainly a name clash the admin needs to resolve.
    const aliasKey = normaliseName(a.selfAddition);
    if (aliasKey.length < 2) continue;
    try {
      const existing = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: aliasKey } },
      });
      if (existing) {
        if (existing.userId !== userId && existing.source === "auto-detect") {
          // Two different senders both claimed this alias auto-detected
          // — surface a warning but don't fight ourselves.
          console.warn(
            `[squad-from-list] alias clash for "${aliasKey}" in org ${orgId}: ${existing.userId} vs ${userId}`,
          );
        }
        // Hand-curated (merge / manual) wins — leave it alone.
        continue;
      }
      await db.userAlias.create({
        data: { orgId, userId, alias: aliasKey, source: "auto-detect" },
      });
      aliasesLearned++;
      console.log(
        `[squad-from-list] learned alias "${aliasKey}" → ${userId} in org ${orgId}`,
      );
    } catch (err) {
      console.error("[squad-from-list] alias upsert failed:", err);
    }
  }

  return { aliasesLearned, usersProvisioned };
}

/** Resolve a free-text name from a squad list against the org roster.
 *  Walks the same chain `resolveOrProvisionByName` uses in the analyze
 *  route (alias-first this time since aliases are the ground truth
 *  here), but never declines on ambiguity for the resolution-day path:
 *  if there are two equally-good matches we still surface the name to
 *  the admin queue rather than silently dropping a squad slot.
 *
 *  Returns:
 *    { userId, name, provisional: false } when matched
 *    { userId, name, provisional: true }  when newly provisioned
 *    null                                 when name is empty / blocked
 */
export async function resolveOrProvisionSquadName(
  orgId: string,
  rawName: string,
): Promise<{ userId: string; name: string | null; provisional: boolean } | null> {
  const name = rawName.trim();
  if (!name || name.length < 2) return null;
  const blocked = /^(match time|matchtime|whatsapp|system|reserves?|subs?|standby)$/i;
  if (blocked.test(name)) return null;

  // 1. Alias is the strongest signal — it's either admin-curated or
  //    auto-detected from the diff pass (which is itself ground truth).
  const aliasKey = normaliseName(name);
  if (aliasKey.length >= 2) {
    const alias = await db.userAlias.findUnique({
      where: { orgId_alias: { orgId, alias: aliasKey } },
      include: { user: { select: { id: true, name: true } } },
    });
    if (alias) {
      // Make sure the membership exists / isn't soft-removed.
      await db.membership.upsert({
        where: { userId_orgId: { userId: alias.userId, orgId } },
        create: { userId: alias.userId, orgId, role: "PLAYER" },
        update: { leftAt: null },
      });
      return { userId: alias.userId, name: alias.user.name, provisional: false };
    }
  }

  // 2. Existing membership by exact name (case-insensitive, NFD).
  const candidates = await db.membership.findMany({
    where: { orgId },
    include: { user: { select: { id: true, name: true } } },
  });
  const equals = candidates.filter(
    (c) => c.user.name && normaliseName(c.user.name) === aliasKey,
  );
  if (equals.length === 1) {
    const m = equals[0];
    if (m.leftAt) {
      await db.membership.update({ where: { id: m.id }, data: { leftAt: null } });
    }
    return { userId: m.user.id, name: m.user.name, provisional: false };
  }

  // 3. First-token fuzzy. Same prefix logic as resolveOrProvisionByName.
  const pushTokens = aliasKey.split(/\s+/).filter(Boolean);
  const pushFirst = pushTokens[0] ?? "";
  const fuzzy = candidates.filter((c) => {
    if (!c.user.name) return false;
    const dbTokens = normaliseName(c.user.name).split(/\s+/).filter(Boolean);
    const dbFirst = dbTokens[0] ?? "";
    return (
      dbFirst === pushFirst ||
      (dbFirst.length >= 3 &&
        pushFirst.length >= 3 &&
        (dbFirst.startsWith(pushFirst) || pushFirst.startsWith(dbFirst)))
    );
  });
  if (fuzzy.length === 1) {
    const m = fuzzy[0];
    if (m.leftAt) {
      await db.membership.update({ where: { id: m.id }, data: { leftAt: null } });
    }
    return { userId: m.user.id, name: m.user.name, provisional: false };
  }

  // 4. Provision: create a User + Membership with no phone. Admin
  //    fills in the number at /admin/players (same flow Sutton uses
  //    for any phone-less player).
  const emailSlug =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "player";
  const syntheticEmail = `provisional+${emailSlug}-${Date.now().toString(36)}@matchtime.local`;
  try {
    const user = await db.user.create({
      data: {
        name,
        email: syntheticEmail,
        phoneNumber: null,
        onboarded: false,
        isActive: true,
      },
    });
    await db.membership.create({
      data: {
        userId: user.id,
        orgId,
        role: "PLAYER",
        provisionallyAddedAt: new Date(),
      },
    });
    console.log(
      `[squad-from-list] provisioned squad-list player "${name}" (no phone) in org ${orgId}`,
    );
    return { userId: user.id, name: user.name, provisional: true };
  } catch (err) {
    console.error("[squad-from-list] squad-player provisioning failed:", err);
    return null;
  }
}

/** Take the latest pasted list as the squad and write Attendance rows.
 *  Idempotent: if Attendance already has CONFIRMED rows for this match
 *  we leave them alone (an admin may have hand-tuned).
 *
 *  Returns a summary suitable for logging / the cron response body. */
export async function finaliseSquadForMatch(
  orgId: string,
  matchId: string,
  finalList: ParsedList,
): Promise<{
  written: number;
  skippedExisting: number;
  resolved: Array<{ name: string; userId: string; provisional: boolean; position: number }>;
  unresolved: string[];
}> {
  const existing = await db.attendance.findMany({
    where: { matchId, status: "CONFIRMED" },
    select: { userId: true },
  });
  const haveUserIds = new Set(existing.map((a) => a.userId));

  const resolved: Array<{ name: string; userId: string; provisional: boolean; position: number }> = [];
  const unresolved: string[] = [];

  for (let i = 0; i < finalList.names.length; i++) {
    const name = finalList.names[i];
    const r = await resolveOrProvisionSquadName(orgId, name);
    if (!r) {
      unresolved.push(name);
      continue;
    }
    resolved.push({ name: r.name ?? name, userId: r.userId, provisional: r.provisional, position: i + 1 });
  }

  let written = 0;
  let skippedExisting = 0;
  for (const r of resolved) {
    if (haveUserIds.has(r.userId)) {
      skippedExisting++;
      continue;
    }
    try {
      const priorRow = await db.attendance.findUnique({
        where: { matchId_userId: { matchId, userId: r.userId } },
        select: { status: true, position: true },
      });
      // Same transaction as the record of it — see lib/attendance-events.ts.
      await db.$transaction(async (tx) => {
        const row = await tx.attendance.upsert({
          where: { matchId_userId: { matchId, userId: r.userId } },
          create: {
            matchId,
            userId: r.userId,
            status: "CONFIRMED",
            position: r.position,
          },
          update: {
            status: "CONFIRMED",
            position: r.position,
          },
        });
        await recordAttendanceEvent(
          tx,
          {
            matchId,
            userId: r.userId,
            orgId,
            fromStatus: priorRow?.status ?? null,
            toStatus: row.status,
            fromPosition: priorRow?.position ?? null,
            toPosition: row.position,
          },
          {
            cause: "pasted-roster",
            actorKind: "system",
            sourceRef: "cron:extract-squads",
            note: `extracted from a posted list as "${r.name}"${r.provisional ? " (provisional player)" : ""}`,
          },
        );
      });
      written++;
    } catch (err) {
      console.error("[squad-from-list] attendance upsert failed:", err);
    }
  }

  // Reserves: write as BENCH rows so they're visible in the squad
  // sheet but DON'T receive MoM votes / rating DMs (existing post-match
  // flow filters on status:CONFIRMED).
  for (let i = 0; i < finalList.reserves.length; i++) {
    const name = finalList.reserves[i];
    const r = await resolveOrProvisionSquadName(orgId, name);
    if (!r) continue;
    try {
      const priorRow = await db.attendance.findUnique({
        where: { matchId_userId: { matchId, userId: r.userId } },
        select: { status: true, position: true },
      });
      await db.$transaction(async (tx) => {
        const row = await tx.attendance.upsert({
          where: { matchId_userId: { matchId, userId: r.userId } },
          create: {
            matchId,
            userId: r.userId,
            status: "BENCH",
            position: i + 1,
          },
          update: {
            // Don't downgrade a CONFIRMED to BENCH if they later moved
            // into the playing list. (Shouldn't happen by construction —
            // names live in EITHER playing or reserves on a single list
            // — but guard anyway.)
          },
        });
        // The empty `update` above means an existing row is UNCHANGED,
        // and recordAttendanceEvent writes nothing for a no-op — so a
        // re-run of the cron does not pad the log.
        await recordAttendanceEvent(
          tx,
          {
            matchId,
            userId: r.userId,
            orgId,
            fromStatus: priorRow?.status ?? null,
            toStatus: row.status,
            fromPosition: priorRow?.position ?? null,
            toPosition: row.position,
          },
          {
            cause: "pasted-roster",
            actorKind: "system",
            sourceRef: "cron:extract-squads",
            note: "listed as a reserve on a posted list",
          },
        );
      });
    } catch (err) {
      console.error("[squad-from-list] reserve upsert failed:", err);
    }
  }

  return { written, skippedExisting, resolved, unresolved };
}

/** Top-level orchestration used by the cron + the test harness.
 *  1. Run the LLM extraction over the window.
 *  2. Diff + attribute.
 *  3. Learn aliases.
 *  4. If a matchId is given AND we have at least one list AND the
 *     match is within `finaliseAfter` of kickoff, write the final
 *     squad. Otherwise: only the learning pass runs (alias-warming
 *     ahead of kickoff).
 */
export async function runSquadExtraction(args: {
  orgId: string;
  /** Override the auto-computed lower bound. When omitted, derived
   *  via `computeSinceForOrg` (previous match end → bootstrap → cap). */
  since?: Date;
  /** When set, finalise the squad for this match if we have a list. */
  finaliseForMatchId?: string;
}): Promise<{
  lists: number;
  attributions: number;
  aliasesLearned: number;
  usersProvisioned: number;
  finalisedMatchId?: string;
  written?: number;
  unresolved?: string[];
  /** Diagnostic: lower bound used for the window this run, ISO string.
   *  Harness + on-call debugging — confirms which rule fired
   *  (previous-match-end vs bootstrap vs cap). */
  windowSince?: string;
  /** Diagnostic: surface what we ended up with for the latest list,
   *  for harness + on-call debugging. Tiny payload. */
  latestListNames?: string[];
  latestListReserves?: string[];
}> {
  // When we're finalising for a specific upcoming match, exclude
  // that match from the "previous match" lookup by using ITS date
  // as the cutoff. Otherwise use now (any match with date < now is
  // a candidate predecessor).
  let cutoffDate: Date = new Date();
  if (args.finaliseForMatchId) {
    const forMatch = await db.match.findUnique({
      where: { id: args.finaliseForMatchId },
      select: { date: true },
    });
    if (forMatch) cutoffDate = forMatch.date;
  }
  const since = args.since ?? (await computeSinceForOrg(args.orgId, cutoffDate));

  const lists = await extractSquadListsFromWindow(args.orgId, since);
  if (lists.length === 0) {
    return {
      lists: 0,
      attributions: 0,
      aliasesLearned: 0,
      usersProvisioned: 0,
      windowSince: since.toISOString(),
    };
  }
  const attributions = attributeDiffs(lists);
  const { aliasesLearned, usersProvisioned } = await learnAliasesFromAttribution(
    args.orgId,
    attributions,
  );

  if (args.finaliseForMatchId) {
    const latest = lists[lists.length - 1];
    const { written, unresolved } = await finaliseSquadForMatch(
      args.orgId,
      args.finaliseForMatchId,
      latest,
    );
    return {
      lists: lists.length,
      attributions: attributions.length,
      aliasesLearned,
      usersProvisioned,
      finalisedMatchId: args.finaliseForMatchId,
      written,
      unresolved,
      windowSince: since.toISOString(),
      // Diagnostic — included so a failed harness can show exactly
      // what the LLM + backstop produced for the latest list. Safe
      // to keep in prod; payload size is tiny.
      latestListReserves: latest.reserves,
      latestListNames: latest.names,
    };
  }

  return {
    lists: lists.length,
    attributions: attributions.length,
    aliasesLearned,
    usersProvisioned,
    windowSince: since.toISOString(),
  };
}
