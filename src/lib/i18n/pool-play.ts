/**
 * The words on the local player pool's pages, /play and /play/manage
 * (slice L2), in every language MatchTime ships. CLIENT-SAFE.
 *
 * Page copy, so it is not in the flat `strings.*.ts` tables (as the privacy
 * policy is not): one object per language, `pool-play.en.ts` and
 * `pool-play.tr.ts`, typed by `PoolPlayCopy`, so a missing line in either
 * language is a `tsc` error. The pages hold no wording of their own. The
 * pool's DMs stay in the string tables (`pool_dm_*`).
 *
 * Every number in a sentence (the age, the limits) is
 * passed in from `src/lib/pool/rules.ts`, never typed. House rules (unit
 * tested in `__tests__/pool-play.test.ts`): no em or en dashes, no slash as
 * a separator, "early sign-up list" and never "waiting list", Turkish never
 * equal to English.
 */
import { normaliseLang, type Lang } from "./lang";
import { buildPoolPlayEn } from "./pool-play.en";
import { buildPoolPlayTr } from "./pool-play.tr";

/** The numbers the copy quotes, from rules.ts. */
export interface PoolPlayFacts {
  minAge: number;
  perWeek: number;
  /** How long a /play code works. */
  codeDays: number;
}

export type PoolErrorKey =
  | "name"
  | "area-required"
  | "area-district"
  | "maxMiles"
  | "availability-none"
  | "availability-bad-day"
  | "availability-bad-time"
  | "availability-bad-range"
  | "availability-too-many"
  | "sports-none"
  | "sports-bad-sport"
  | "sports-other-needs-name"
  | "sports-bad-format"
  | "sports-bad-level"
  | "sports-duplicate"
  | "sports-too-many"
  | "adult"
  | "consent"
  | "busy"
  | "area-not-found"
  | "paused"
  | "unavailable"
  | "generic";

export interface PoolFieldsCopy {
  nameLabel: string;
  nameHint: string;
  areaLegend: string;
  districtLabel: string;
  districtHint: string;
  travelLegend: string;
  miles: (n: number) => string;
  daysLegend: string;
  daysHint: string;
  /** Sunday first, as `PoolAvailability.day` (0 = Sunday). */
  dayNames: readonly string[];
  fromLabel: (day: string) => string;
  toLabel: (day: string) => string;
  addRange: (day: string) => string;
  removeRange: (day: string) => string;
  sportsLegend: string;
  sportsHint: string;
  /** The hint when only one sport is offered (`LIVE_SPORTS`): no sport to pick, only its formats. */
  sportsHintOne: string;
  formatsLegend: (sport: string) => string;
  levelLabel: (sport: string) => string;
  levelNone: string;
  levelOwnWords: string;
  levelOwnWordsLabel: (sport: string) => string;
  otherNameLabel: string;
  languageLabel: string;
}

export interface PoolPlayCopy {
  title: string;
  description: string;
  languageSwitchLabel: string;
  backHome: string;
  privacyLink: string;
  fields: PoolFieldsCopy;
  errors: Record<PoolErrorKey, string>;
  errorSummary: string;
  signup: {
    heading: string;
    /** /play's short note while a sign-up goes on the early sign-up list. */
    earlyShort: string;
    /** Shown while a sign-up goes on the early sign-up list
     *  (`signupGoesOnEarlyList`); `openNote` once the pool is open. */
    earlyNote: string;
    openNote: string;
    howItWorks: readonly string[];
    adultLabel: string;
    consentLabel: string;
    consentPolicy: string;
    submit: string;
    submitting: string;
    pausedNote: string;
    confirmHeading: string;
    confirmLead: string;
    openWhatsApp: string;
    codeLabel: string;
    messageLabel: string;
    confirmEarly: string;
    confirmHelp: string;
    /** The /play reminder (2026-10-31): a returning visitor whose sign-up
     *  still waits for its WhatsApp code. */
    reminderHeading: string;
    reminderLead: string;
    reminderNoForm: string;
    /** When the code runs out, a date already in the page's language. */
    reminderUntil: (date: string) => string;
    /** Once, when his remembered code no longer works. */
    expiredNote: string;
  };
  manage: {
    heading: string;
    noProfile: string;
    signUpLink: string;
    statusLabel: string;
    status: { active: string; paused: string; pausedByMatchTime: string; stopped: string };
    earlyNote: string;
    consentLine: (date: string, version: number) => string;
    pause: string;
    resume: string;
    stop: string;
    stopHint: string;
    restartConsent: string;
    restart: string;
    editHeading: string;
    save: string;
    saving: string;
    saved: string;
    privacyHeading: string;
    showRecognitionLabel: string;
    showRecognitionHint: string;
    deleteHeading: string;
    deleteHint: string;
    deleteButton: string;
    deleteConfirm: string;
    deleteCancel: string;
    deletedHeading: string;
    deletedBody: string;
  };
  /** Slice L3: the "Play elsewhere" card on a club member's own profile. */
  member: {
    heading: string;
    lead: string;
    ownClubNote: string;
    open: string;
    prefillNote: string;
    whatsAppNote: string;
    join: string;
    joining: string;
    continueWhatsApp: string;
    inPool: string;
    manageLink: string;
    waitingHeading: string;
    startAgain: string;
    claimHeading: string;
    claimQuestion: (tail: string) => string;
    claimYes: string;
    claimNo: string;
    claimNoDone: string;
    claimExpired: string;
    claimTaken: string;
  };
}

const BUILDERS: Record<Lang, (f: PoolPlayFacts) => PoolPlayCopy> = { en: buildPoolPlayEn, tr: buildPoolPlayTr };

export function poolPlayCopy(lang: Lang | string | null | undefined, facts: PoolPlayFacts): PoolPlayCopy {
  return BUILDERS[normaliseLang(lang)](facts);
}
