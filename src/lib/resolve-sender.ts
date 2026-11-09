/**
 * WHO SENT THIS MESSAGE — and therefore whether their attendance is
 * recorded at all.
 *
 * ── Why this is a module and not part of the route ───────────────────
 *
 * It used to live in the middle of `api/whatsapp/analyze/route.ts`.
 * The 2026-08-30 independent audit found a hole in it — a message with
 * no phone and no name resolves to nobody, writes no attendance, returns
 * HTTP 200, and was invisible to every mechanism built to catch exactly
 * that — and said plainly why the hole survived review:
 *
 *   "Per house TDD rules: write the failing tests first — `resolveSender`
 *    is currently untested and not exported, which is why this hole
 *    survived a review."
 *
 * It could not be tested where it was. Next.js route modules may export
 * only their HTTP handlers, so nothing in that file can be imported by a
 * test. Moving it here is what makes `__tests__/resolve-sender.test.ts`
 * possible; nothing about its behaviour changed in the move.
 *
 * ── The order of trust ───────────────────────────────────────────────
 *
 *   1. phone            — the only identity WhatsApp guarantees
 *   2. exact name       — case- and accent-insensitive
 *   3. first-name match — asymmetric prefix, must be UNIQUE in the org
 *   4. UserAlias        — admin-curated, breaks a tie the fuzzy rules
 *                         cannot ("Nunu" is Elnur; no letter-overlap
 *                         rule reaches that)
 *   5. provision        — the sender posted in the org's own monitored
 *                         group, so by construction they belong to it;
 *                         a duplicate an admin merges away is a better
 *                         failure than a silently dropped IN
 *
 * `@lid` privacy senders arrive with NO phone by construction
 * (`phoneFromAuthor` on the Pi returns "" for any JID that is not
 * `@c.us`), so for them steps 2-5 are the whole of their identity. That
 * is why the Pi now prefers `_data.notifyName`, which survives a broken
 * injected layer, over a contact lookup that does not.
 */
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { personPickerFor } from "@/lib/pipeline/identify-batch";
import { notifyPhoneAdopted } from "./possible-duplicate-notice";
import { refKey } from "@/lib/person-ref-key";
import type { PersonPicker, WhoRequest } from "@/lib/pipeline/who-is-who";
import { withAttendanceOverflow } from "@/lib/ai-budget-context";

/** The outcome of resolution. `userId: null` means nobody was found. */
export type ResolvedSender = {
  userId: string | null;
  name: string | null;
  phone: string | null;
};

/**
 * The only two fields resolution reads off an inbound message.
 *
 * Deliberately NOT the route's full `InboundMessage`: code here never
 * reads the body. Only who-is-who is shown it, as context for the model
 * (`SenderToResolve.body`).
 */
export interface SenderIdentity {
  /** Bare digits, or "" for an @lid sender / an unreadable author JID. */
  authorPhone: string;
  /** WhatsApp pushname, or null when nothing could be read. */
  authorName: string | null;
}


/**
 * Clear `leftAt` on a soft-removed membership when the player has
 * resurfaced in the chat. Preserves history (rating, attendance) and
 * silently re-activates them in the roster.
 */
export async function restoreMembership(membershipId: string, name: string | null) {
  await db.membership.update({
    where: { id: membershipId },
    data: { leftAt: null, provisionallyAddedAt: null },
  });
  console.log(`[analyze] restored soft-removed membership ${membershipId} (${name ?? "unknown"})`);
}

/** `restoreMembership` by member and club: a former member who-is-who was
 *  sure of, named back in (review of #574, round 3). Only a row that has
 *  left is touched. */
export async function restoreFormerMember(orgId: string, userId: string): Promise<void> {
  const { count } = await db.membership.updateMany({
    // Never one an organiser removed: only an organiser brings him back.
    where: { orgId, userId, leftAt: { not: null }, removedByOrganiserAt: null },
    data: { leftAt: null, provisionallyAddedAt: null },
  });
  if (count > 0) console.log(`[analyze] brought former member ${userId} back into org ${orgId} (who-is-who, sure)`);
}

/**
 * True when a "name" is really a raw phone number / numeric @lid id
 * ("447700900123", "123456789012@lid", "+44 7700 900123", "@4477…").
 * Never stamp these as display names or print them in group posts —
 * use a neutral placeholder and let an admin rename. (RC4 of the
 * 2026-06-12 Sutton Lads incident: a bare number showed up as a player
 * name in a group post.)
 */
export function isRawDigitName(raw: string): boolean {
  const cleaned = raw
    .trim()
    .replace(/@?lid$/i, "")
    .replace(/[@\s+().-]/g, "");
  return /^\d{5,}$/.test(cleaned);
}
/**
 * A WhatsApp display name fit to become a player's name, or null: trimmed,
 * 2 to 60 characters, not a raw number (RC4, see `isRawDigitName`), not
 * the bot or a system author. Used for a nameless placeholder's first
 * post and for a joiner the Pi could name (2026-09-30).
 */
export function usableWhatsAppName(raw: string | null | undefined): string | null {
  const name = raw?.trim().replace(/\s+/g, " ") ?? "";
  if (name.length < 2 || name.length > 60) return null;
  if (isRawDigitName(name)) return null;
  if (/^(match ?time|whatsapp|system)$/i.test(name)) return null;
  return name;
}

/** The phone half of resolution: the member by phone (naming a nameless
 *  placeholder from its first post), or null when the phone finds nobody
 *  or there is none. */
async function resolveSenderByPhone(msg: SenderIdentity): Promise<ResolvedSender | null> {
  if (!msg.authorPhone) return null;
  // Accept raw digits: prepend '+' if the bot didn't.
  const raw = msg.authorPhone.startsWith("+") ? msg.authorPhone : `+${msg.authorPhone}`;
  const norm = normalisePhone(raw);
  if (!norm) return null;
  const user = await db.user.findUnique({
    where: { phoneNumber: norm },
    select: { id: true, name: true },
  });
  if (user && !user.name) {
    // A nameless placeholder (added to the group by phone, 2026-09-30):
    // its first post carries the WhatsApp name, so use it. Only when
    // the row has NO name (`name: null` in the where, so a name an
    // admin typed in the meantime always wins), and never a number.
    const pushname = usableWhatsAppName(msg.authorName);
    if (pushname) {
      try {
        const res = await db.user.updateMany({ where: { id: user.id, name: null }, data: { name: pushname } });
        if (res.count > 0) {
          console.log(`[resolve-sender] named placeholder ${user.id} "${pushname}" from their first post`);
          return { userId: user.id, name: pushname, phone: norm };
        }
      } catch (err) {
        console.error(`[resolve-sender] could not name placeholder ${user.id}:`, err);
      }
    }
  }
  return user ? { userId: user.id, name: user.name, phone: norm } : null;
}

/** A message whose sender is to be resolved. `body` is shown to
 *  who-is-who only, for context; code never reads it. */
export interface SenderToResolve extends SenderIdentity {
  waMessageId: string;
  body?: string;
}

/**
 * WHO SENT EACH MESSAGE, for a batch.
 *
 * PHONE FIRST, unchanged: a phone (or a LID the Pi turned into one) is
 * the person.
 *
 * OTHERWISE THE MODEL (2026-11-09, reviews of #574). This used to match
 * the WhatsApp name by spelling (equal, first name, a first-name PREFIX,
 * alias), so a non-member David saying "I'm out" dropped the member
 * Davide. Now the WhatsApp names of the senders the phone did not find go
 * to who-is-who in ONE call for the batch, each with the first message it
 * sent, marked as a WhatsApp name so the model is strict (a self-chosen
 * name is a member only by their full name or a listed nickname, or when
 * the message makes it plain). The answer, per distinct WhatsApp name
 * (so one new sender's "IN" and "+1" make ONE person, never two):
 *
 *   - a member it is sure of: the sender (a former member brought back).
 *     When the sender came with a phone nobody has and that member is a
 *     phoneless PROVISIONAL member ("Hamzah's in" before Hamzah joined),
 *     the phone is attached, only while the member still has none.
 *   - nobody: a new provisional member, as before, once per name.
 *   - anything else (several members, not sure, no answer): an UNKNOWN
 *     sender, provisioned as nobody, which is the existing unresolved
 *     sender path (no write, the "who are you?" nudge). Failing closed:
 *     a guess would drop or register the wrong member.
 *
 * A model call rather than failing closed for every phoneless sender,
 * because under Baileys a sender whose number the Pi could not learn is
 * routine. A FAILED call is tried once more (`pickOnce`). A call REFUSED
 * by the club's daily cap is asked once more inside the attendance
 * overflow: who sent an IN is attendance's own question, it costs one
 * Haiku call for the whole batch (well under a tenth of a cent, against an
 * overflow allowance as large as the daily cap itself), and it is only
 * ever used when the cap really refused it, so it cannot starve the
 * attendance extractor, and a club crossing the cap mid-request does not
 * fail every phoneless sender closed.
 */
export async function resolveSenders(
  orgId: string,
  msgs: SenderToResolve[],
  opts: { identify?: PersonPicker } = {},
): Promise<Map<string, ResolvedSender>> {
  const out = new Map<string, ResolvedSender>();
  /** One entry per sender: the WhatsApp name PLUS the phone it came with
   *  (final review of round 3: two unknown numbers both called "Ali" are
   *  two people). Only phoneless messages share an entry by name alone.
   *  Its messages, and the first one's text shown to the model. */
  const byName = new Map<string, { pushname: string; msgs: SenderToResolve[] }>();
  for (const msg of msgs) {
    const byPhone = await resolveSenderByPhone(msg);
    if (byPhone) {
      out.set(msg.waMessageId, byPhone);
      continue;
    }
    const pushname = msg.authorName?.trim() ?? "";
    if (pushname.length >= 2 && !isRawDigitName(pushname)) {
      const raw = msg.authorPhone?.trim() ?? "";
      const phone = raw ? (normalisePhone(raw.startsWith("+") ? raw : `+${raw}`) ?? raw) : "";
      const key = `${refKey(pushname)}|${phone}`;
      const g = byName.get(key) ?? { pushname, msgs: [] };
      g.msgs.push(msg);
      byName.set(key, g);
    } else out.set(msg.waMessageId, await provisionOrNobody(orgId, msg));
  }
  if (byName.size === 0) return out;

  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true, phoneNumber: true } } } }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
  ]);
  const byUser = new Map((memberships ?? []).filter((m) => !!m.user).map((m) => [m.user.id, m]));
  const picker = opts.identify ?? personPickerFor();
  const request: WhoRequest = {
    roster: [...byUser.values()].map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      aliases: (aliases ?? []).filter((a) => a.userId === m.user.id).map((a) => a.alias),
      former: !!m.leftAt,
    })),
    where: "the club's players' group",
    messages: [...byName.entries()].map(([key, g]) => ({
      id: key,
      body: g.msgs[0].body ?? "",
      author: null,
      refs: [g.pushname],
      waNames: true as const,
    })),
  };
  let res = await picker(request);
  if (res.failed === "budget") res = await withAttendanceOverflow(() => picker(request));
  for (const d of res.degradations) console.warn(`[resolve-sender] ${d}`);

  for (const [key, g] of byName) {
    const pick = res.picks.get(key)?.get(refKey(g.pushname));
    const m = pick?.kind === "member" ? byUser.get(pick.userId) : undefined;
    let resolved: ResolvedSender;
    if (m) {
      if (m.leftAt) await restoreMembership(m.id, m.user.name);
      const phone = await adoptPhoneIfPlaceholder(orgId, m, g.msgs, g.pushname);
      resolved = { userId: m.user.id, name: m.user.name, phone };
    } else if (pick?.kind === "none") {
      // Once per WhatsApp name in the batch: "IN" then "+1" is ONE person.
      resolved = await provisionOrNobody(orgId, g.msgs[0]);
    } else {
      console.warn(
        `[resolve-sender] the WhatsApp name of a sender MatchTime could not place by phone, in org ${orgId}, could not be placed (${pick ? pick.kind : "no answer"}): an unknown sender`,
      );
      resolved = { userId: null, name: g.pushname, phone: null };
    }
    for (const msg of g.msgs) out.set(msg.waMessageId, resolved);
  }
  return out;
}

/**
 * A sender who came with a phone NOBODY has, surely placed by who-is-who
 * on a phoneless PROVISIONAL member (a placeholder made from "Hamzah's
 * in" before Hamzah joined): the member takes that phone, only while
 * still phoneless (a sign-in or an admin's edit in between is never
 * overwritten). Never by a match of names. The admins are told once
 * (`notifyPhoneAdopted`). The phone, or null.
 */
async function adoptPhoneIfPlaceholder(
  orgId: string,
  m: { user: { id: string; name: string | null; phoneNumber?: string | null }; provisionallyAddedAt?: Date | null },
  msgs: SenderToResolve[],
  whatsAppName: string,
): Promise<string | null> {
  if (m.user.phoneNumber) return null;
  if (!m.provisionallyAddedAt) return null;
  const raw = msgs.find((x) => x.authorPhone)?.authorPhone;
  if (!raw) return null;
  const phone = normalisePhone(raw.startsWith("+") ? raw : `+${raw}`);
  if (!phone) return null;
  try {
    const { count } = await db.user.updateMany({ where: { id: m.user.id, phoneNumber: null }, data: { phoneNumber: phone } });
    if (count === 1) {
      console.log(`[resolve-sender] placeholder ${m.user.id} takes the phone of the sender it is (who-is-who, sure)`);
      // Permanent: the admins are told once, so a wrong one can be undone.
      await notifyPhoneAdopted(orgId, { userId: m.user.id, name: m.user.name, whatsAppName });
      return phone;
    }
  } catch (err) {
    // A unique clash: another row claimed this number in a race. Not ours.
    console.error(`[resolve-sender] could not attach a phone to placeholder ${m.user.id}:`, err);
  }
  return null;
}

/** One sender: `resolveSenders` for a batch of one. */
export async function resolveSender(
  orgId: string,
  msg: SenderIdentity & { body?: string },
  opts: { identify?: PersonPicker } = {},
): Promise<ResolvedSender> {
  return (await resolveSenders(orgId, [{ ...msg, waMessageId: "sender" }], opts)).get("sender")!;
}

/**
 * Nobody in the club: a provisional member, as it always was. The message
 * came from the club's monitored group, so by construction the sender is
 * in the roster; silently dropping their IN or OUT is worse than a
 * duplicate an admin merges (`Membership.provisionallyAddedAt` shows it).
 */
async function provisionOrNobody(orgId: string, msg: SenderIdentity): Promise<ResolvedSender> {
  const provisional = await createProvisionalMember(orgId, msg);
  if (provisional) return provisional;
  // Never surface a raw numeric id as a display name — downstream
  // replies address the sender by this field.
  const fallbackName = msg.authorName && !isRawDigitName(msg.authorName) ? msg.authorName : null;
  return { userId: null, name: fallbackName, phone: null };
}
export async function createProvisionalMember(
  orgId: string,
  msg: SenderIdentity,
): Promise<ResolvedSender | null> {
  return createProvisionalByName(orgId, msg.authorName?.trim() ?? null, msg.authorPhone);
}
/**
 * Can a name an ADMIN typed on purpose (a pasted squad list confirmed with
 * YES) become a new player? The same rule as a usable WhatsApp name: 2 to
 * 60 characters, not a raw number, not the bot or a system author. The
 * paste's preview asks this BEFORE the YES and the provisioner applies the
 * same rule at the YES, so a name the preview promised is never refused.
 */
export function isDeliberateNameProvisionable(raw: string | null | undefined): boolean {
  return usableWhatsAppName(raw) !== null;
}

export async function createProvisionalByName(
  orgId: string,
  rawName: string | null,
  rawPhone: string | null,
  opts: {
    /** An admin typed this name on purpose and confirmed it (a pasted
     *  squad list's YES): `isDeliberateNameProvisionable` decides, so a
     *  short real name ("Mo") is added. Without it the name is a
     *  pushname or a third party's mention, held to the stricter rule. */
    deliberate?: boolean;
  } = {},
): Promise<ResolvedSender | null> {
  const trimmed = rawName?.trim();
  if (opts.deliberate && !isDeliberateNameProvisionable(trimmed)) return null;
  // Never stamp a raw phone number / @lid numeric id as a display name
  // (RC4, 2026-06-12): provision under a neutral placeholder instead
  // and let the admin rename from the dashboard — the membership is
  // flagged provisional either way, and group posts must never show
  // bare digits as a player.
  const name = trimmed && isRawDigitName(trimmed) ? "New player" : trimmed;
  // Require ≥3 chars unless deliberate: 2-char pushnames like "ba" are
  // almost always truncations of a real name we already have (e.g. "Baki
  // Sutton") and provisioning them creates duplicate ghost users. Who-is-who
  // places a short WhatsApp name on a member when it is sure
  // (`resolveSenders`); provisioning is reserved for genuinely new names.
  // An admin's pasted "Mo" is not a truncation: it is checked above
  // instead.
  if (!name || (!opts.deliberate && name.length < 3)) return null;
  // Skip obvious non-player authors (bot itself, group admin system messages).
  const blocked = /^(match time|matchtime|whatsapp|system)$/i;
  if (blocked.test(name)) return null;

  const normPhone = rawPhone
    ? normalisePhone(rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`)
    : null;

  // Synthetic email keeps the User.email unique constraint happy — users
  // can claim their account later via a real email address when they
  // log in (onboarding flow overwrites this placeholder).
  const emailSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "player";
  const syntheticEmail = `provisional+${emailSlug}-${Date.now().toString(36)}@matchtime.local`;

  try {
    // Phone is unique globally, so if a user with that phone already
    // exists (from another org), reuse them rather than failing.
    let user = normPhone
      ? await db.user.findUnique({ where: { phoneNumber: normPhone } })
      : null;
    if (!user) {
      user = await db.user.create({
        data: {
          name,
          email: syntheticEmail,
          phoneNumber: normPhone,
          onboarded: false,
          isActive: true,
        },
      });
    }

    // Upsert membership: if user already exists in this org (e.g. re-joined),
    // just clear leftAt and mark as provisional again.
    await db.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId } },
      create: {
        userId: user.id,
        orgId,
        role: "PLAYER",
        provisionallyAddedAt: new Date(),
      },
      update: {
        leftAt: null,
        provisionallyAddedAt: new Date(),
      },
    });
    console.log(`[analyze] auto-created provisional member ${user.id} (${name}) in org ${orgId}`);
    return { userId: user.id, name: user.name, phone: normPhone };
  } catch (err) {
    console.error("[analyze] provisional member creation failed:", err);
    return null;
  }
}
