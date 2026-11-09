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
import { refKey } from "@/lib/person-ref-key";
import type { PersonPicker } from "@/lib/pipeline/who-is-who";

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
 * WITHOUT A PHONE, THE MODEL (2026-11-09, review of #574). This used to
 * match the WhatsApp name by spelling: equal, then a first name, then a
 * first-name PREFIX ("David" would be the member Davide De Sousa, and a
 * non-member David saying "I'm out" would drop Davide), then an alias.
 * Now every such sender's WhatsApp name goes to who-is-who in ONE call for
 * the batch, with the club's members (former members marked, aliases
 * shown) and the message: a member it is sure of is the sender (a former
 * one brought back); nobody is a new provisional member, as before; and a
 * name it cannot place (several members, not sure, a failed call) is an
 * UNKNOWN sender, provisioned as nobody: failing closed. Their message
 * then writes nothing, which is the existing path for an unresolved
 * sender (the "who are you?" nudge), rather than a guess that drops or
 * registers the wrong member. A model call rather than failing closed for
 * every phoneless sender, because under Baileys a sender whose number the
 * Pi could not learn is routine, and refusing all of them would silence
 * real members who say IN.
 */
export async function resolveSenders(
  orgId: string,
  msgs: SenderToResolve[],
  opts: { identify?: PersonPicker } = {},
): Promise<Map<string, ResolvedSender>> {
  const out = new Map<string, ResolvedSender>();
  const ask: Array<{ msg: SenderToResolve; pushname: string }> = [];
  for (const msg of msgs) {
    const byPhone = await resolveSenderByPhone(msg);
    if (byPhone) {
      out.set(msg.waMessageId, byPhone);
      continue;
    }
    const pushname = msg.authorName?.trim() ?? "";
    if (pushname.length >= 2 && !isRawDigitName(pushname)) ask.push({ msg, pushname });
    else out.set(msg.waMessageId, await provisionOrNobody(orgId, msg));
  }
  if (ask.length === 0) return out;

  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true } } } }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
  ]);
  const byUser = new Map((memberships ?? []).filter((m) => !!m.user).map((m) => [m.user.id, m]));
  const picker = opts.identify ?? personPickerFor();
  const res = await picker({
    roster: [...byUser.values()].map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      aliases: (aliases ?? []).filter((a) => a.userId === m.user.id).map((a) => a.alias),
      former: !!m.leftAt,
    })),
    where:
      "the club's players' group. Each name to identify is the WhatsApp name of the person who SENT that message, " +
      "a name they chose for themselves; it names the sender, not anybody in the text",
    messages: ask.map(({ msg, pushname }) => ({ id: msg.waMessageId, body: msg.body ?? "", author: null, refs: [pushname] })),
  });
  for (const d of res.degradations) console.warn(`[resolve-sender] ${d}`);

  for (const { msg, pushname } of ask) {
    const pick = res.picks.get(msg.waMessageId)?.get(refKey(pushname));
    const m = pick?.kind === "member" ? byUser.get(pick.userId) : undefined;
    if (m) {
      if (m.leftAt) await restoreMembership(m.id, m.user.name);
      out.set(msg.waMessageId, { userId: m.user.id, name: m.user.name, phone: null });
    } else if (pick?.kind === "none") {
      out.set(msg.waMessageId, await provisionOrNobody(orgId, msg));
    } else {
      console.warn(
        `[resolve-sender] the WhatsApp name of a phoneless sender in org ${orgId} could not be placed (${pick ? pick.kind : "no answer"}): an unknown sender`,
      );
      out.set(msg.waMessageId, { userId: null, name: pushname, phone: null });
    }
  }
  return out;
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
