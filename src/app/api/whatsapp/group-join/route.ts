/**
 * Bot-forwarded WhatsApp `group_join` event. Auto-onboards new WhatsApp
 * group members into the matching org so admins don't have to add every
 * phone by hand at /admin/players/phones.
 *
 * Flow (per recipient phone in the payload):
 *   1. Find org by `whatsappGroupId`. 404 if the group isn't bot-enabled.
 *   2. Normalise phone to E.164. Silently ignore anything that doesn't
 *      parse — @lid recipients, weird numbers, etc.
 *   3. Upsert a `User` row keyed by phone. Brand-new users are created
 *      with the WhatsApp name when the Pi knew it (`names`, 2026-09-30),
 *      else `name=null`, filled from their first post (resolve-sender.ts)
 *      or by an admin.
 *   4. Upsert a `Membership` as PLAYER and stamp `lastSeenInGroupAt` —
 *      WhatsApp has just told us this person is in the group, which is
 *      proof of presence in exactly the sense the self-IN gate needs. If
 *      one already existed with `leftAt` set, clear it (a left member has
 *      rejoined).
 *   5. Link a phoneless placeholder (2026-09-29). When a KNOWN user gets
 *      a first or restored membership and this club holds exactly one
 *      phoneless placeholder of the same name (made by a third party's
 *      "X in"), merge it into them so their games and team place follow.
 *      Ambiguous or partial matches are only suggested. Rules:
 *      src/lib/placeholder-link-rules.ts.
 *   6. Queue a `BotJob` DM to every org admin ONLY on state change: a
 *      brand-new number, a known user's FIRST membership here ("joined"),
 *      or a membership that had left ("rejoined"). Already-active members
 *      don't spam admins. In the club's language (src/lib/join-dm.ts).
 *
 * Accepts `{ groupId, phones: string[] }` so a single event carrying
 * several added recipients gets one round-trip.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { findOrgAdminsWithPhone } from "@/lib/org";
import { linkJoinerToPlaceholder, type LinkOutcome } from "@/lib/placeholder-link";
import { composeJoinDm, joinDmPath, type JoinDmInput, type JoinLinkNote } from "@/lib/join-dm";
import { buildAdminLink } from "@/lib/admin-link";
import { usableWhatsAppName } from "@/lib/resolve-sender";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { groupId, phones, names } = (body ?? {}) as {
    groupId?: string;
    phones?: string[];
    /** Optional (2026-09-30): the WhatsApp name the Pi already knew for a
     *  joiner, keyed by the same string as in `phones`. A Pi that does not
     *  send it changes nothing; the name is filled on their first post
     *  instead (`resolve-sender.ts`). */
    names?: Record<string, string>;
  };

  if (!groupId || !Array.isArray(phones) || phones.length === 0) {
    return NextResponse.json(
      { error: "groupId and non-empty phones[] required" },
      { status: 400 },
    );
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
    select: { id: true, name: true, language: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-or-disabled-group" });
  }

  const admins = await findOrgAdminsWithPhone(org.id);

  type Result = {
    phone: string;
    created: boolean;
    rejoined: boolean;
    alreadyActive: boolean;
    link?: LinkOutcome["kind"];
    skipped?: string;
    userId?: string;
    name?: string | null;
  };
  const results: Result[] = [];

  for (const raw of phones) {
    const normalised = normalisePhone(raw);
    if (!normalised) {
      results.push({ phone: raw, created: false, rejoined: false, alreadyActive: false, skipped: "bad-phone" });
      continue;
    }

    const knownName = usableWhatsAppName(
      names && typeof names === "object" ? (names[raw] ?? names[normalised] ?? names[normalised.replace(/^\+/, "")]) : null,
    );

    // Step 3: find or create the user.
    let user = await db.user.findUnique({
      where: { phoneNumber: normalised },
      select: { id: true, name: true, email: true },
    });
    let created = false;
    if (!user) {
      // `email` is required + unique on User. Placeholder unique value the
      // admin can overwrite when they fill in name/email. Using the phone
      // guarantees uniqueness and makes the source obvious in the DB.
      const placeholderEmail = `wa-${normalised.replace(/^\+/, "")}@placeholder.matchtime`;
      user = await db.user.create({
        data: {
          name: knownName,
          email: placeholderEmail,
          phoneNumber: normalised,
          onboarded: false,
          isActive: true,
        },
        select: { id: true, name: true, email: true },
      });
      created = true;
    } else if (!user.name && knownName) {
      // A nameless row we already had: the Pi knows their WhatsApp name.
      await db.user.updateMany({ where: { id: user.id, name: null }, data: { name: knownName } });
      user = { ...user, name: knownName };
    }

    // Step 4: upsert membership.
    //
    // A `group_join` STAMPS `lastSeenInGroupAt` (2026-09-09). WhatsApp
    // has just told us this person was added to the group: that is proof
    // of presence of exactly the same kind as the participant sweep's
    // sighting or a message they post, and it arrives through the event
    // stream rather than the injected page code, so it survives the
    // breakage that has had the sweep down since 2026-07-07.
    //
    // Before this, the person the gate most obviously ought to trust —
    // someone we watched join, seconds ago — was created with a NULL
    // sighting and could not mark themselves in on the app. That was the
    // gap; closing it costs one field.
    //
    // Refreshed on all three branches because the fact is the same on
    // all three, and joins are rare enough that the extra write on the
    // already-active branch is free.
    const now = new Date();
    const existing = await db.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      select: { id: true, leftAt: true, role: true },
    });
    let rejoined = false;
    let alreadyActive = false;
    if (!existing) {
      await db.membership.create({
        data: { userId: user.id, orgId: org.id, role: "PLAYER", lastSeenInGroupAt: now },
      });
    } else if (existing.leftAt) {
      await db.membership.update({
        where: { id: existing.id },
        data: { leftAt: null, lastSeenInGroupAt: now },
      });
      rejoined = true;
    } else {
      await db.membership.update({
        where: { id: existing.id },
        data: { lastSeenInGroupAt: now },
      });
      alreadyActive = true;
    }

    // Step 5: link a placeholder a third party's "X in" created for this
    // person. Only for a KNOWN user whose membership here is new or
    // restored: a brand-new number has no name to match, and an
    // already-active member is no state change.
    let link: LinkOutcome = { kind: "none" };
    if (!created && !alreadyActive) {
      link = await linkJoinerToPlaceholder(org.id, user.id);
    }
    const linkNote: JoinLinkNote | undefined =
      link.kind === "linked"
        ? { kind: "linked", placeholderName: link.placeholderName, addedAt: link.addedAt }
        : link.kind === "suggest"
          ? { kind: "suggest", names: link.candidates.map((c) => c.name).filter(Boolean) }
          : undefined;

    // Step 6: queue admin DM only on state change.
    if (!alreadyActive && admins.length > 0) {
      const displayName =
        user.name?.trim() || (link.kind === "linked" ? link.placeholderName : "") || normalised;
      const input: JoinDmInput = created
        ? { kind: "new", club: org.name, phone: normalised, name: user.name, link: linkNote }
        : { kind: rejoined ? "rejoined" : "first", club: org.name, name: displayName, link: linkNote };
      const path = joinDmPath(input);

      for (const admin of admins) {
        // Same-person admin getting DM'd about themselves would be silly.
        if (admin.id === user.id) continue;
        // Each admin gets their OWN signed-in link, in this club (2026-09-30:
        // the DM used to end in a bare "/admin/players/phones").
        const url = path ? await buildAdminLink({ userId: admin.id, orgId: org.id, nextPath: path }) : "";
        const text = composeJoinDm(org.language, input, url);
        await db.botJob.create({
          data: {
            orgId: org.id,
            kind: "dm",
            phone: admin.phoneNumber.replace(/^\+/, ""),
            text,
          },
        });
      }
    }

    results.push({
      phone: normalised,
      created,
      rejoined,
      alreadyActive,
      link: link.kind,
      userId: user.id,
      name: user.name,
    });
  }

  return NextResponse.json({ ok: true, orgId: org.id, results });
}
