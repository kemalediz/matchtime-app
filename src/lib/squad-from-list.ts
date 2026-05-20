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
 *   1. One LLM call (Sonnet, ≤1×/30min/match) over the last 3 days of
 *      stored `GroupMessage` rows for the org → returns which messages
 *      are squad-list-shaped + the parsed numbered names + reserves.
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
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { normalisePhone } from "./phone";

const MODEL = "claude-sonnet-4-5";

/** Default lookback for the squad-extraction LLM call. The group's
 *  ritual is "re-paste with your name appended each time someone signs
 *  in" so the SAME list typically appears many times over the course of
 *  a week. 3 days is enough to span the typical "list seeded → squad
 *  filled" arc without burning context on unrelated banter. */
export const WINDOW_DAYS = 3;

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

const SYSTEM_PROMPT = `You parse WhatsApp group messages from amateur sports groups that maintain their squad by re-pasting a numbered list with each new sign-in.

For EACH message you are given, decide whether it is a squad list. A squad list:
  - has multiple lines that LOOK numbered ("1. Name", "1) Name", "1.⁠ ⁠Name", "1️⃣ Name"). The numbers may be plain digits or emoji digits; the separator may be ".", ")", or unusual unicode spacing/word-joiners (U+2060) common when copied from WhatsApp.
  - names a roster of people for a single upcoming game.
  - may include a separate "Reserves:" / "Subs:" / "Standby:" block of additional numbered names.

A message is NOT a squad list when:
  - it is a leaderboard / stats answer (percentages, "wins", "votes", "MoM").
  - it is generic numbered prose ("1. yes 2. no").
  - it is a Red vs Yellow team breakdown (two parallel lists for the same match).
  - it is short freeform chatter mentioning a number.

For each squad list, extract the playing names IN ORDER (one per slot) and the reserves IN ORDER. Strip the leading number, any unusual unicode spacing, and surrounding decoration. Keep the name as written by the user (don't normalise case — we want "youssef" preserved if that's what they typed).

Return JSON ONLY in this exact schema:

{
  "lists": [
    { "waMessageId": "<id>", "isList": true, "names": ["Ehtisham", "Amir", ...], "reserves": ["Martin"] }
  ]
}

- Omit non-list messages from "lists".
- "names" must contain ONLY the playing-squad entries (positions 1..N), not reserves.
- "reserves" is [] when there are no reserves.
- If you see the same list pasted twice (re-paste with one new line) emit BOTH as separate list entries; the diff is computed downstream.`;

interface LLMResponse {
  lists: Array<{
    waMessageId: string;
    isList: boolean;
    names?: string[];
    reserves?: string[];
  }>;
}

function getAnthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key ? new Anthropic({ apiKey: key }) : null;
}

/** Normalise a name for diffing / alias storage:
 *   - NFD + drop combining diacritics
 *   - lowercase
 *   - drop zero-width / word-joiner / non-breaking space (whatsapp
 *     copy-paste emits U+2060 / U+00A0 / U+200B liberally)
 *   - collapse whitespace
 *   - strip leading "~" (whatsapp prefixes pushnames of unsaved contacts) */
export function normaliseName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ ​-‏‪-‮⁠﻿]/g, " ")
    .replace(/^~+\s*/, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
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

  const anthropic = getAnthropic();
  if (!anthropic) {
    console.warn("[squad-from-list] ANTHROPIC_API_KEY missing — skipping extraction");
    return [];
  }

  const input = messages.map((m) => ({
    waMessageId: m.waMessageId,
    body: m.body.slice(0, 4000),
  }));

  let parsed: LLMResponse | null = null;
  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            `Inspect these ${input.length} WhatsApp messages and return the squad lists in the JSON shape above.\n\n` +
            JSON.stringify(input),
        },
      ],
    });
    const block = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!block) return [];
    const json = block.text.slice(block.text.indexOf("{"), block.text.lastIndexOf("}") + 1);
    parsed = JSON.parse(json) as LLMResponse;
  } catch (err) {
    console.error("[squad-from-list] LLM extraction failed:", err);
    return [];
  }

  if (!parsed?.lists?.length) return [];

  // Re-join the LLM's parsed names back onto the source messages (so we
  // recover senderPhone / senderPushname / timestamp which the LLM never
  // saw). Drop any list it produced that isn't actually a list, or whose
  // waMessageId doesn't match anything in the window.
  const byId = new Map(messages.map((m) => [m.waMessageId, m]));
  const out: ParsedList[] = [];
  for (const l of parsed.lists) {
    if (!l.isList) continue;
    const src = byId.get(l.waMessageId);
    if (!src) continue;
    const names = (l.names ?? []).map((s) => s.trim()).filter(Boolean);
    if (names.length < 2) continue; // a "list" with one slot is almost certainly noise
    out.push({
      waMessageId: l.waMessageId,
      senderPhone: src.senderPhone,
      senderPushname: src.senderPushname,
      timestamp: src.timestamp,
      names,
      reserves: (l.reserves ?? []).map((s) => s.trim()).filter(Boolean),
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
    const allAdded = [...addedNames, ...addedReserves];

    // Identify which (if any) addition is the sender themselves. Match
    // the normalised pushname against each addition by:
    //   - exact equality, or
    //   - one side is a startsWith-prefix of the other and the longer
    //     side is ≥ 3 chars (handles "Nabeel" ↔ "NABEEL", "youssef" ↔
    //     "Youssef", and the all-important pushname-shorter case
    //     "T" → "Tharan" we DO want to bridge here).
    //
    // The "T" → "Tharan" bridge is intentional and unique to this
    // pass: in normal sender-resolution we require pushname ≥ 2 / 3 to
    // avoid creating ghosts, but here the diff itself is the ground
    // truth — the single addition by sender ~T IS Tharan. We don't
    // need a length floor because we're not guessing: the sender's
    // addition is by construction theirs (unless they added multiple,
    // which we handle below).
    let selfAddition: string | null = null;
    const guestAdditions: string[] = [];

    const pushNorm = cur.senderPushname ? normaliseName(cur.senderPushname) : "";
    if (pushNorm && allAdded.length > 0) {
      // Score each addition: best-match wins. Equal score → prefer
      // longer match. Score thresholds:
      //  3 = exact match
      //  2 = pushname startsWith addition or vice versa (longer ≥ 3)
      //  1 = single-addition with no other signal (the ~T → "Tharan"
      //      case — only credited when there's exactly ONE addition)
      let best: { name: string; score: number } | null = null;
      for (const name of allAdded) {
        const n = normaliseName(name);
        let score = 0;
        if (n === pushNorm) score = 3;
        else if (
          (n.startsWith(pushNorm) && n.length >= 3) ||
          (pushNorm.startsWith(n) && pushNorm.length >= 3)
        )
          score = 2;
        if (score > 0 && (!best || score > best.score || (score === best.score && n.length > normaliseName(best.name).length))) {
          best = { name, score };
        }
      }
      // No string-overlap match found but there's exactly ONE addition:
      // by the group's ritual, that's overwhelmingly likely to be the
      // sender themselves under a different name (the "~T → Tharan"
      // scenario). Credit it as a tentative self-addition.
      if (!best && allAdded.length === 1) {
        best = { name: allAdded[0], score: 1 };
      }
      if (best) {
        selfAddition = best.name;
        for (const name of allAdded) {
          if (name !== best.name) guestAdditions.push(name);
        }
      } else {
        // No match at all + multiple additions: all guests. Sender is
        // an organiser signing in others. Their own alias will be
        // learned later when THEY appear as an addition in someone
        // else's diff (or when they themselves sign in solo).
        guestAdditions.push(...allAdded);
      }
    } else {
      // No pushname (privacy mode + no saved contact): can't bridge.
      // All additions are guests for now; they'll get aliased when
      // someone with a known pushname adds them.
      guestAdditions.push(...allAdded);
    }

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
      await db.attendance.upsert({
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
      await db.attendance.upsert({
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
  /** Defaults to now - WINDOW_DAYS. */
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
}> {
  const since =
    args.since ??
    new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const lists = await extractSquadListsFromWindow(args.orgId, since);
  if (lists.length === 0) {
    return { lists: 0, attributions: 0, aliasesLearned: 0, usersProvisioned: 0 };
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
    };
  }

  return {
    lists: lists.length,
    attributions: attributions.length,
    aliasesLearned,
    usersProvisioned,
  };
}
