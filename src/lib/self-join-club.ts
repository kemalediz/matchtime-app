/**
 * SELF-JOIN, SLICE 4: creating a club on the website.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, section 5.1,
 * decision 2 (the weekly game is set up here, before the button), and
 * caps 1 and 4 of section 7.
 *
 * The club is born DRAFT (`draftClubFields()`, club-approval.ts's one
 * writer), with the organiser as OWNER, the language they picked, and
 * its weekly game: a Sport for the size and an Activity on the day,
 * time and venue. Nothing here touches WhatsApp: the bot stays off and
 * no group is named until the owner approves (slice 7).
 *
 * Refusals, in order (superadmins skip the last three):
 *   invalid       a field is missing or malformed;
 *   verify-phone  the account has no phone verified by a WhatsApp code
 *                 (a used PhoneOtp for it: /signup and /claim both
 *                 leave one);
 *   one-club      this person already owns a self-join club, whatever
 *                 state it is in (cap 1: one club per verified phone;
 *                 User.phoneNumber is unique, so the user IS the phone);
 *   site-cap      10 self-join clubs were created today, London time
 *                 (cap 4).
 */
import { db } from "./db";
import { draftClubFields, SELF_JOIN_CLUB_WHERE } from "./club-approval";
import { isLang } from "./i18n/lang";
import { t } from "./i18n/t";
import {
  MAX_NEW_CLUBS_PER_DAY,
  londonMidnight,
  sportForPlayersPerSide,
  validateWeeklyGame,
  type WeeklyGame,
} from "./club-connect-rules";

export interface SelfJoinClubInput {
  name: string;
  language: string;
  game: Partial<WeeklyGame> | null;
}

export type SelfJoinRefusal = "invalid" | "verify-phone" | "one-club" | "site-cap";

export type SelfJoinClubResult = { ok: true; orgId: string; slug: string } | { ok: false; reason: SelfJoinRefusal };

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ı/g, "i")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "club"
  );
}

async function freeSlug(base: string): Promise<string> {
  for (let i = 1; i <= 50; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!(await db.organisation.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * May this person create a self-join club right now? null = yes.
 * The setup page asks first so it can say why before the form is filled;
 * `createSelfJoinClub` asks again at submit.
 */
export async function selfJoinEligibility(
  userId: string,
  now: Date,
): Promise<Exclude<SelfJoinRefusal, "invalid"> | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, phoneNumber: true, isSuperadmin: true },
  });
  if (!user) return "verify-phone";
  if (user.isSuperadmin) return null;

  const digits = (user.phoneNumber ?? "").replace(/\D/g, "");
  const verified = digits ? await db.phoneOtp.count({ where: { phone: digits, usedAt: { not: null } } }) : 0;
  if (verified === 0) return "verify-phone";

  const owned = await db.membership.count({ where: { userId, role: "OWNER", org: SELF_JOIN_CLUB_WHERE } });
  if (owned > 0) return "one-club";

  const today = await db.organisation.count({
    where: { ...SELF_JOIN_CLUB_WHERE, createdAt: { gte: londonMidnight(now) } },
  });
  if (today >= MAX_NEW_CLUBS_PER_DAY) return "site-cap";
  return null;
}

export async function createSelfJoinClub(
  userId: string,
  input: SelfJoinClubInput,
  now: Date,
): Promise<SelfJoinClubResult> {
  const name = (input.name ?? "").trim();
  const game = validateWeeklyGame(input.game);
  if (name.length < 2 || name.length > 60 || !isLang(input.language) || !game.ok) {
    return { ok: false, reason: "invalid" };
  }
  const language = input.language;

  const refusal = await selfJoinEligibility(userId, now);
  if (refusal) return { ok: false, reason: refusal };

  const slug = await freeSlug(slugify(name));
  const sport = sportForPlayersPerSide(game.game.playersPerSide);
  const activityName = t(language).sj_activity_name({ perSide: game.game.playersPerSide });

  const org = await db.$transaction(async (tx) => {
    const created = await tx.organisation.create({
      data: {
        name,
        slug,
        language,
        ...draftClubFields(),
        memberships: { create: { userId, role: "OWNER" } },
      },
    });
    const sportRow = await tx.sport.create({
      data: {
        orgId: created.id,
        name: activityName,
        preset: sport.preset,
        playersPerTeam: sport.playersPerTeam,
        positions: sport.positions,
        teamLabels: sport.teamLabels,
        mvpLabel: sport.mvpLabel,
        balancingStrategy: sport.balancingStrategy,
        positionComposition: sport.positionComposition,
      },
    });
    await tx.activity.create({
      data: {
        orgId: created.id,
        sportId: sportRow.id,
        name: activityName,
        dayOfWeek: game.game.dayOfWeek,
        time: game.game.time,
        venue: game.game.venue,
      },
    });
    return created;
  });

  return { ok: true, orgId: org.id, slug: org.slug };
}
