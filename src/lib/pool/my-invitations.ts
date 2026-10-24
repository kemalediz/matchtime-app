/**
 * MY INVITATIONS (local player pool L8): what the player's own page lists.
 * Approved spec: "open club invitations (club, sport, venue, how often they
 * play, the games the player had there) with Join / No thanks, plus open
 * game offers. The DM links straight to it; an invitation stays until
 * answered."
 *
 * Thin I/O. ONLY his own rows: every read is keyed by his user id. The
 * club facts are the ones a pool offer already states (`offer-facts.ts`):
 * club, sport and format, venue, size and how often it plays, never a
 * member's name or a number. The link is never on this page: Join sends it
 * by WhatsApp (`club-invitation.ts`).
 */
import { db } from "../db";
import { normaliseLang, type Lang } from "../i18n/lang";
import { t } from "../i18n/t";
import { ORDINARY_MEMBER_WHERE } from "../guest-membership";
import { loadGuestFacts } from "./guest-report-loader";
import { buildGuestPlayers } from "./guest-report";
import { loadMatchOfferFacts } from "./offer-facts";
import { clubLineOf } from "./offer-copy";
import { poolOfferPath } from "./offer-token";
import { sportLabel } from "./sports";

export interface MyClubInvitation {
  id: string;
  club: string;
  /** "Football, 7-a-side" in his language; null when unknown. */
  sport: string | null;
  venue: string | null;
  /** "A regular group of 30 players, playing every week"; null when unknown. */
  about: string | null;
  gamesHere: number;
  /** waiting-him: Join / No thanks. waiting-club: he said yes already. */
  state: "waiting-him" | "waiting-club";
}

export interface MyOffer {
  id: string;
  club: string;
  kickoff: Date;
  venue: string | null;
  expiresAt: Date;
  path: string;
}

export interface MyInvitationsView {
  lang: Lang;
  invitations: MyClubInvitation[];
  offers: MyOffer[];
}

async function languageOf(userId: string): Promise<Lang> {
  const profile = await db.poolProfile.findUnique({ where: { userId }, select: { language: true } });
  if (profile?.language) return normaliseLang(profile.language);
  const m = await db.membership.findFirst({ where: { userId, leftAt: null, ...ORDINARY_MEMBER_WHERE }, select: { org: { select: { language: true } } } });
  return normaliseLang(m?.org.language);
}

export async function loadMyInvitations(userId: string, now: Date = new Date()): Promise<MyInvitationsView> {
  const lang = await languageOf(userId);
  const [rows, memberOf, offers] = await Promise.all([
    db.clubInvitation.findMany({ where: { userId, status: "open" }, orderBy: { createdAt: "desc" }, select: { id: true, orgId: true, matchId: true, playerYesAt: true } }),
    db.membership.findMany({ where: { userId, leftAt: null, ...ORDINARY_MEMBER_WHERE }, select: { orgId: true } }),
    db.poolOffer.findMany({
      where: { userId, outcome: null, sentAt: { not: null }, expiresAt: { gt: now } },
      orderBy: { expiresAt: "asc" },
      select: { id: true, matchId: true, expiresAt: true },
    }),
  ]);
  const members = new Set(memberOf.map((m) => m.orgId));

  const invitations: MyClubInvitation[] = [];
  // An invitation from a club he has joined since is done; not listed.
  for (const r of rows.filter((x) => !members.has(x.orgId))) {
    const facts = await loadGuestFacts(r.orgId, { userIds: [userId], now });
    const card = buildGuestPlayers({ orgId: r.orgId, now, lang, games: facts.games, people: facts.people }).cards[userId];
    const lastHere = facts.games
      .filter((g) => g.orgId === r.orgId)
      .sort((a, b) => b.match.kickoff.getTime() - a.match.kickoff.getTime())[0];
    const game = await loadMatchOfferFacts(r.matchId ?? lastHere?.match.matchId ?? "", now);
    const club = game?.club ?? (await db.organisation.findUnique({ where: { id: r.orgId }, select: { name: true } }))?.name ?? "";
    invitations.push({
      id: r.id,
      club,
      sport: game ? [sportLabel(game.sport, lang), game.format ? t(lang).sj_per_side_option({ perSide: game.format }) : null].filter(Boolean).join(", ") : null,
      venue: game?.venueName ?? null,
      about: game ? clubLineOf(lang, game.members, game.gamesLast8Weeks) : null,
      gamesHere: card?.gamesHere ?? 0,
      state: r.playerYesAt ? "waiting-club" : "waiting-him",
    });
  }

  const myOffers: MyOffer[] = [];
  for (const o of offers) {
    const f = await loadMatchOfferFacts(o.matchId, now);
    if (!f) continue;
    myOffers.push({ id: o.id, club: f.club, kickoff: f.kickoff, venue: f.venueName, expiresAt: o.expiresAt, path: poolOfferPath(o.id) });
  }
  return { lang, invitations, offers: myOffers };
}
