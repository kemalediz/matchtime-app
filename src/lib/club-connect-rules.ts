/**
 * SELF-JOIN, SLICE 4 (organiser web): the PURE rules behind club setup,
 * the "Add MatchTime to WhatsApp" button and the status card.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 4.2,
 * 5.1 to 5.3 and caps 4 and 5 of section 7.
 *
 * No database, no clock (every function that needs the time takes it),
 * and NOT the MatchTime number: that is server-only and lives in
 * club-connect.ts. `waMeLink` takes the number as an argument.
 */
import { randomInt } from "node:crypto";
import { t } from "./i18n/t";
import { normaliseLang, type Lang } from "./i18n/lang";
import type { SportPreset } from "./sport-presets";
import { LIVE_SPORTS, livePresetForSide, type LiveSports } from "./pool/sports";
import { londonDateTimeToUtc, formatLondon } from "./london-time";
import { VENUE_MIN_LENGTH } from "./activity-update";

// ── The numbers (section 7) ─────────────────────────────────────────────

/** A connect code works for 60 minutes. */
export const CONNECT_CODE_TTL_MS = 60 * 60 * 1000;
/** Cap 5: codes per club per London day. One is live at a time. */
export const MAX_CODES_PER_CLUB_PER_DAY = 3;
/** Cap 4: new self-join clubs per London day, across the whole site. */
export const MAX_NEW_CLUBS_PER_DAY = 10;
/** After approval, the card says "you're live" for this many days. */
export const APPROVED_CARD_DAYS = 7;

// ── Connect codes ───────────────────────────────────────────────────────

/** 31 characters: A to Z and 2 to 9, without 0 O 1 I L. */
export const CONNECT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** The plan's server-side parser (section 5.2): only the code after
 *  "code" or "kod" is read, so an edited message still gets through. */
export const CONNECT_CODE_PARSER = /(?:code|kod)\W*([A-HJ-KM-NP-Z2-9]{4})/i;

/** A 4-character code. Not the security (the phone match is); a pointer. */
export function generateConnectCode(rand: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += CONNECT_CODE_ALPHABET[rand(CONNECT_CODE_ALPHABET.length)];
  return code;
}

/** The message WhatsApp opens with, in the club's language. */
export function connectPrefill(lang: Lang | string | null | undefined, club: string, code: string): string {
  return t(lang).sj_connect_prefill({ club, code });
}

/** `https://wa.me/<digits>?text=<encoded>`. */
export function waMeLink(number: string, text: string): string {
  return `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

// ── Club setup ──────────────────────────────────────────────────────────

/** The setup form's default language: the browser's first preference. */
export function langFromAcceptLanguage(header: string | null | undefined): Lang {
  const first = (header ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return normaliseLang(first.split(";")[0]);
}

export const PLAYERS_PER_SIDE_OPTIONS = [4, 5, 6, 7, 8, 9, 10, 11] as const;

export interface WeeklyGame {
  dayOfWeek: number;
  time: string;
  venue: string;
  playersPerSide: number;
}

export function validateWeeklyGame(
  raw: Partial<WeeklyGame> | null | undefined,
): { ok: true; game: WeeklyGame } | { ok: false } {
  if (!raw) return { ok: false };
  const { dayOfWeek, time, playersPerSide } = raw;
  const venue = typeof raw.venue === "string" ? raw.venue.trim() : "";
  if (!Number.isInteger(dayOfWeek) || (dayOfWeek as number) < 0 || (dayOfWeek as number) > 6) return { ok: false };
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false };
  // The same minimum as every other way a weekly game is made or edited
  // (VENUE_MIN_LENGTH, activity-update.ts): one character was accepted
  // here once, and such a game could then never be saved again.
  if (venue.length < VENUE_MIN_LENGTH || venue.length > 120) return { ok: false };
  if (!(PLAYERS_PER_SIDE_OPTIONS as readonly number[]).includes(playersPerSide as number)) return { ok: false };
  return { ok: true, game: { dayOfWeek: dayOfWeek as number, time, venue, playersPerSide: playersPerSide as number } };
}

/** The Sport row a new club gets for its players per side. */
export type ClubSportSpec = Omit<SportPreset, "key"> & { preset: string | null };

/**
 * The Sport row for a size: the live preset for it (`livePresetForSide`,
 * the `LIVE_SPORTS` switch; football's 5, 7, 8, 9 and 11 today), otherwise
 * plain football balanced on rating alone. Self-join and the in-group
 * WhatsApp setup both build their club's sport here, so they agree.
 */
export function sportForPlayersPerSide(n: number, live: LiveSports = LIVE_SPORTS): ClubSportSpec {
  const preset = livePresetForSide(n, live);
  if (preset) {
    return {
      preset: preset.key,
      name: preset.name,
      playersPerTeam: preset.playersPerTeam,
      positions: [...preset.positions],
      teamLabels: [...preset.teamLabels] as [string, string],
      mvpLabel: preset.mvpLabel,
      balancingStrategy: preset.balancingStrategy,
      positionComposition: preset.positionComposition,
    };
  }
  return {
    preset: null,
    // The presets' own naming, so the pool reads it as football
    // (`poolSportOfClubSport` matches a custom sport by its name).
    name: `Football ${n}-a-side`,
    playersPerTeam: n,
    positions: ["GK", "DEF", "MID", "FWD"],
    teamLabels: ["Red", "Yellow"],
    mvpLabel: "Man of the Match",
    balancingStrategy: "rating-only",
    positionComposition: undefined,
  };
}

/** "+44 7700 900123" for a UK mobile; "+<digits>" for anything else. */
export function formatPhoneForDisplay(phone: string): string {
  const d = phone.replace(/\D/g, "");
  const uk = /^44(7\d{3})(\d{6})$/.exec(d);
  return uk ? `+44 ${uk[1]} ${uk[2]}` : `+${d}`;
}

/** 00:00 London on the day `now` falls on: where "a day" starts for caps. */
export function londonMidnight(now: Date): Date {
  return londonDateTimeToUtc(formatLondon(now, "yyyy-MM-dd"), "00:00");
}

// ── The status card ─────────────────────────────────────────────────────

/** The columns of the club's latest `ClubConnect` the card reads. */
export interface ConnectRow {
  status: string;
  code: string;
  expiresAt: Date;
  addWindowEndsAt: Date | null;
  lastMismatchAt: Date | null;
  lastMismatchPhoneMasked: string | null;
  groupSubject: string | null;
  adderMatch: string | null;
  /** Set by the connect DM (slice 5) when cap 6 was full. */
  siteCapAt: Date | null;
}

export type ConnectCard =
  | { kind: "hidden" }
  | { kind: "draft" }
  | { kind: "issued"; code: string; mismatchFrom: string | null; siteCap: boolean }
  | { kind: "expired" }
  | { kind: "dm_verified" }
  | { kind: "pending"; group: string | null; addedByOther: boolean }
  | { kind: "approved"; group: string | null }
  /** Approved, and waiting for an owner or admin to go live (slice S5). */
  /** `removed`: MatchTime was taken out of the group before going live. */
  | { kind: "setting_up"; group: string | null; removed: boolean }
  | { kind: "rejected" };

/** The organiser matched the adder by phone or WhatsApp id (plan 2.3). */
const VERIFIED_ADDER = new Set(["phone", "lid"]);

/**
 * Which card the organiser sees (plan 5.2). A club that never came
 * through self-join (approved, `approvedAt` NULL: Sutton FC) sees none.
 */
export function deriveConnectCard(args: {
  /** `settingUp`: the caller's `isClubSettingUp(org)` (club-setup-rules.ts). */
  org: { approvalStatus: string; approvedAt: Date | null; settingUp?: boolean; removedFromGroup?: boolean };
  latest: ConnectRow | null;
  now: Date;
}): ConnectCard {
  const { org, latest, now } = args;
  switch (org.approvalStatus) {
    case "rejected":
      return { kind: "rejected" };
    case "pending":
      return {
        kind: "pending",
        group: latest?.groupSubject ?? null,
        addedByOther: !VERIFIED_ADDER.has(latest?.adderMatch ?? ""),
      };
    case "approved": {
      // Approved but silent until GO: never "you're live", and shown for
      // as long as the club is setting up, not for a week.
      if (org.settingUp) return { kind: "setting_up", group: latest?.groupSubject ?? null, removed: !!org.removedFromGroup };
      if (!org.approvedAt) return { kind: "hidden" };
      const age = now.getTime() - org.approvedAt.getTime();
      return age <= APPROVED_CARD_DAYS * 24 * 60 * 60 * 1000
        ? { kind: "approved", group: latest?.groupSubject ?? null }
        : { kind: "hidden" };
    }
    case "draft":
      break;
    default:
      return { kind: "hidden" };
  }

  if (!latest) return { kind: "draft" };
  const t = now.getTime();
  switch (latest.status) {
    case "issued":
      return latest.expiresAt.getTime() > t
        ? {
            kind: "issued",
            code: latest.code,
            mismatchFrom: latest.lastMismatchAt ? latest.lastMismatchPhoneMasked : null,
            // Cap 6 resets at London midnight; so does the line.
            siteCap: !!latest.siteCapAt && latest.siteCapAt.getTime() >= londonMidnight(now).getTime(),
          }
        : { kind: "expired" };
    case "dm_verified":
      return !latest.addWindowEndsAt || latest.addWindowEndsAt.getTime() > t ? { kind: "dm_verified" } : { kind: "expired" };
    case "expired":
      return { kind: "expired" };
    default:
      // superseded, closed, or group_linked while draft again (MatchTime
      // was removed from the group while pending): start over.
      return { kind: "draft" };
  }
}
