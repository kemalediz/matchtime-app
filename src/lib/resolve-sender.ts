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

/** The outcome of resolution. `userId: null` means nobody was found. */
export type ResolvedSender = {
  userId: string | null;
  name: string | null;
  phone: string | null;
};

/**
 * The only two fields resolution reads off an inbound message.
 *
 * Deliberately NOT the route's full `InboundMessage`: a resolver that can
 * see the body is a resolver somebody will eventually make read the body.
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

export async function resolveSender(orgId: string, msg: SenderIdentity): Promise<ResolvedSender> {
  // Phone first (most accurate). Accept raw digits — prepend '+' if the
  // bot didn't. @lid senders arrive with empty phone: that's the signal
  // to try a name-based fallback.
  if (msg.authorPhone) {
    const raw = msg.authorPhone.startsWith("+") ? msg.authorPhone : `+${msg.authorPhone}`;
    const norm = normalisePhone(raw);
    if (norm) {
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
      if (user) return { userId: user.id, name: user.name, phone: norm };
    }
  }
  if (msg.authorName && msg.authorName.trim().length >= 2) {
    // Fuzzy name match — the sender's WhatsApp display name ("Kemal
    // Ediz") often doesn't exactly match the DB record ("Kemal"), so
    // we:
    //   1. First try exact case-insensitive equals (the historic rule)
    //   2. Fall back to first-token match on either side — DB first
    //      name vs pushname first name, either direction
    // Both variants still require a UNIQUE match in the org to avoid
    // guessing between two players with the same first name.
    const pushname = msg.authorName.trim();
    // Include soft-removed memberships in the candidate set: someone
    // posting in the group is clearly back, so a unique match against a
    // soft-removed member should restore them rather than provision a
    // new ghost user. We track leftAt status per-candidate to apply the
    // restore on the chosen match.
    const candidates = await db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true } } },
    });
    const norm = (s: string) =>
      s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const pushTokens = norm(pushname).split(/\s+/).filter(Boolean);
    const pushFirst = pushTokens[0] ?? "";

    const equalsMatches = candidates.filter(
      (c) => c.user.name && norm(c.user.name) === norm(pushname),
    );
    if (equalsMatches.length === 1) {
      const m = equalsMatches[0];
      if (m.leftAt) await restoreMembership(m.id, m.user.name);
      return { userId: m.user.id, name: m.user.name, phone: null };
    }

    const firstNameMatches = candidates.filter((c) => {
      if (!c.user.name) return false;
      const dbTokens = norm(c.user.name).split(/\s+/).filter(Boolean);
      const dbFirst = dbTokens[0] ?? "";
      return (
        dbFirst === pushFirst ||
        // Relaxed prefix match: as long as one side is ≥3 chars and the
        // other is ≥2, accept a startsWith. Handles short pushnames like
        // "ba" → "Baki" and nicknames like "Kara" → "Karahan". The
        // uniqueness check above still blocks ambiguous cases ("Ed" when
        // both "Ediz" and "Edward" are in the org).
        ((dbFirst.length >= 3 && pushFirst.length >= 2 && dbFirst.startsWith(pushFirst)) ||
          (pushFirst.length >= 3 && dbFirst.length >= 2 && pushFirst.startsWith(dbFirst)))
      );
    });
    if (firstNameMatches.length === 1) {
      const m = firstNameMatches[0];
      if (m.leftAt) await restoreMembership(m.id, m.user.name);
      return { userId: m.user.id, name: m.user.name, phone: null };
    }
    // Multiple first-name matches (e.g. two Ibrahims) — try the alias
    // table FIRST before giving up. UserAlias is admin-curated
    // (populated by mergePlayers) and unique per (orgId, alias), so an
    // alias hit disambiguates cleanly regardless of how many fuzzy
    // candidates also match. Kemal flagged 2026-05-15: Baki's "ba"
    // pushname matches both Baki and Başar by fuzzy, so the resolver
    // returned null — but UserAlias["ba"] → Baki was already present
    // from an earlier merge, and it should have taken precedence.
    if (firstNameMatches.length > 1) {
      const aliasKeyEarly = norm(pushname);
      if (aliasKeyEarly.length >= 2) {
        const alias = await db.userAlias.findUnique({
          where: { orgId_alias: { orgId, alias: aliasKeyEarly } },
        });
        if (alias) {
          const m = candidates.find((c) => c.userId === alias.userId);
          if (m) {
            if (m.leftAt) await restoreMembership(m.id, m.user.name);
            console.log(
              `[analyze] ambiguous fuzzy "${pushname}" resolved via UserAlias → ${m.user.name} (${alias.userId})`,
            );
            return { userId: m.user.id, name: m.user.name, phone: null };
          }
        }
      }
      console.warn(
        `[analyze] ambiguous fuzzy match for "${pushname}" in org ${orgId} — ${firstNameMatches.length} candidates: ${firstNameMatches
          .map((m) => m.user.name)
          .join(", ")} (no alias to disambiguate)`,
      );
      return { userId: null, name: pushname, phone: null };
    }

    // Alias lookup. Admin merges populate UserAlias rows (Nunu →
    // Elnur Mammadov, etc.) so the next time the same pushname
    // arrives we resolve to the real user instead of creating
    // another ghost. Letter-overlap-based fuzzy could never bridge
    // "Nunu" → "Elnur" — admin curation is the right tool for
    // nicknames + privacy-mode pushnames.
    const aliasKey = norm(pushname);
    if (aliasKey.length >= 2) {
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: aliasKey } },
      });
      if (alias) {
        const m = candidates.find((c) => c.userId === alias.userId);
        if (m) {
          if (m.leftAt) await restoreMembership(m.id, m.user.name);
          return { userId: m.user.id, name: m.user.name, phone: null };
        }
      }
    }
  }
  // Auto-create a provisional member when we couldn't match.
  //   Rationale: the message came from the org's monitored WhatsApp
  //   group, so by construction the sender is in the roster. Silently
  //   dropping their IN/OUT is a worse failure mode than occasionally
  //   creating a duplicate that an admin has to merge. Admin dashboard
  //   surfaces provisional members (via Membership.provisionallyAddedAt)
  //   so they can set phone/position/rating or remove them.
  const provisional = await createProvisionalMember(orgId, msg);
  if (provisional) return provisional;
  // Never surface a raw numeric id as a display name — downstream
  // replies address the sender by this field.
  const fallbackName =
    msg.authorName && !isRawDigitName(msg.authorName) ? msg.authorName : null;
  return { userId: null, name: fallbackName, phone: null };
}

export async function createProvisionalMember(
  orgId: string,
  msg: SenderIdentity,
): Promise<ResolvedSender | null> {
  return createProvisionalByName(orgId, msg.authorName?.trim() ?? null, msg.authorPhone);
}
export async function createProvisionalByName(
  orgId: string,
  rawName: string | null,
  rawPhone: string | null,
): Promise<ResolvedSender | null> {
  const trimmed = rawName?.trim();
  // Never stamp a raw phone number / @lid numeric id as a display name
  // (RC4, 2026-06-12): provision under a neutral placeholder instead
  // and let the admin rename from the dashboard — the membership is
  // flagged provisional either way, and group posts must never show
  // bare digits as a player.
  const name = trimmed && isRawDigitName(trimmed) ? "New player" : trimmed;
  // Require ≥3 chars: 2-char pushnames like "ba" are almost always
  // truncations of a real name we already have (e.g. "Baki Sutton") and
  // provisioning them creates duplicate ghost users. The relaxed fuzzy
  // matcher (see firstNameMatches) now resolves short pushnames to
  // existing members; provisioning is reserved for genuinely new names.
  if (!name || name.length < 3) return null;
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
