/**
 * THE ORGANISER'S ONE SETUP DM: the pure half (go-live slice S3,
 * 2026-10-12; go-live plan 2.4 and 2.5 "Setup DM blocks"). No database,
 * no clock, no model: every link arrives minted.
 *
 * A club approved while SETUP_HOLD_ENABLED is on stays silent in its group
 * until its organiser says GO. It gets ONE DM, which replaces both today's
 * "you're live" DM (`sj_dm_approved`) and the separate "what I learned
 * from your chat" DM (setup-learning/dm.ts `composeSetupDm`). In the
 * club's language, block by block:
 *
 *   head       approved, and quiet in the group until you tell me to start
 *   reading    what came of reading the group's chat, one of:
 *                findings   the same blocks as today's findings DM (each
 *                           switched setting with a chat quote and its
 *                           undo link, the things worth a check, the
 *                           monthly list), without that DM's closing line
 *                nothing    read, and nothing needs a setting changed
 *                unread     could not be read (too little chat, or the
 *                           reading gave up after its retries)
 *                none       no reading at all (it is switched off): the
 *                           block is left out
 *   standard   what the standard setup is. ONLY when no setting was
 *              switched AND the club really is on it (`standard`): an
 *              organiser may have changed things on the website while
 *              waiting, and the DM must not claim otherwise
 *   settings   the settings page (the learned panel when there are findings)
 *   game       the weekly game, as in today's "you're live" DM
 *   ratings    the starting ratings, as in today's "you're live" DM
 *   [admin]    THE ADMIN GROUP BLOCK'S INSERTION POINT (a later slice)
 *   GO         reply GO here, or press Go live on the settings page
 *   free       the free period's length, and that it starts at go-live
 */
import { isSetupLearningFinal } from "./club-setup-rules";
import { t } from "./i18n/t";
import { setupFindingsBlocks } from "./setup-learning/dm";
import {
  LEARNED_KEYS,
  currentValue,
  sameValue,
  type AppliedItem,
  type LearnedKey,
  type NotedPattern,
  type OrgSettingsState,
  type SettingValue,
  type Suggestion,
} from "./setup-learning/rules";

/** The platform channel purpose of the setup DM. */
export const SETUP_ASK_DM_PURPOSE = "setup-ask" as const;
/** The setup DM's refId: one per club. */
export const setupAskRefId = (orgId: string): string => `${orgId}:setup-ask`;

/** Why a reading was closed without being read: the reading is switched
 *  off (nothing was tried, so the DM says nothing about it) ... */
export const READING_OFF_REASON = "reading-off";
/** ... or it had not finished two hours after the approval (the DM says
 *  the chat could not be read). */
export const READING_TIMED_OUT_REASON = "timed-out";

/** What the DM says about the chat reading. `U` is what an applied item
 *  carries: nothing extra as stored, its undo link once minted. */
export type ChatReading<U = { undoUrl: string }> =
  | { kind: "findings"; applied: Array<AppliedItem & U>; suggestions: Suggestion[]; noted: NotedPattern[] }
  | { kind: "nothing" }
  | { kind: "unread" }
  | { kind: "none" };

/** The columns of a ClubSetupLearning row the DM is composed from. */
export interface ChatReadingRow {
  status: string;
  reason?: string | null;
  applied: unknown;
  suggestions: unknown;
  noted: unknown;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** The columns `currentValue` reads: what each learnable setting holds now. */
export type LearnedSettingColumns = Pick<
  OrgSettingsState,
  | "rollingSquadEnabled"
  | "benchPickMode"
  | "dropOutDeadlineDay"
  | "dropOutDeadlineTime"
  | "listPublishDay"
  | "listPublishTime"
  | "paymentTrackingEnabled"
>;

const valueNow = (key: LearnedKey, org: LearnedSettingColumns): SettingValue => currentValue(key, org as OrgSettingsState);

/**
 * From the club's reading row to what the DM reports. A row that is not
 * final (or no row) is "none": the caller decides whether to wait for it.
 *
 * THE DM REPORTS WHAT IS TRUE NOW, not what was true when the reading
 * finished. A switched setting is listed only while it still stands: not
 * one the organiser has undone from the settings page (`undoneAt`), and,
 * when `current` is given, not one that no longer holds the value the
 * reading set (the organiser changed it by hand). The same two tests the
 * settings panel uses for "undone" and "changed since" (view.ts).
 */
export function readingFromRow(
  row: ChatReadingRow | null | undefined,
  current?: LearnedSettingColumns | null,
): ChatReading<object> {
  if (!row || !isSetupLearningFinal(row.status)) return { kind: "none" };
  if (row.status === "skipped" && row.reason === READING_OFF_REASON) return { kind: "none" };
  if (row.status === "skipped" || row.status === "failed") return { kind: "unread" };
  const applied = asArray<AppliedItem>(row.applied).filter(
    (a) => !a.undoneAt && (!current || sameValue(valueNow(a.key, current), a.to)),
  );
  const suggestions = asArray<Suggestion>(row.suggestions);
  const noted = asArray<NotedPattern>(row.noted);
  if (applied.length + suggestions.length + noted.length === 0) return { kind: "nothing" };
  return { kind: "findings", applied, suggestions, noted };
}

/**
 * The value each learnable setting has on a club nobody has touched (the
 * schema defaults). ONE ENTRY PER KEY OF `LEARNED_KEYS`, the reading's own
 * list, and typed so: a key added there does not compile until it is given
 * its default here, so `isStandardSetup` can never forget one.
 */
export const STANDARD_SETTING: Record<LearnedKey, SettingValue> = {
  rollingSquad: false,
  organiserPicks: "first-come",
  dropOutDeadline: null,
  listPublish: null,
  paymentTracking: false,
};

/** Everything `isStandardSetup` reads. */
export type StandardSetupColumns = LearnedSettingColumns & {
  squadMode: string;
  featureAttendance: boolean;
  featureBench: boolean;
  featureSquadFromList: boolean;
};

/**
 * Is the club on the standard setup the DM describes ("players say In or
 * Out each week, and a free place goes to the first person on the bench")?
 * True only when EVERY setting the reading can switch is on its default
 * (`STANDARD_SETTING`: rolling squad, organisers pick, the drop-out
 * deadline, the list day, payment tracking) and the club has the shape the
 * sentence assumes: a weekly squad, In and Out tracking, a bench, and no
 * pasted list.
 */
export function isStandardSetup(org: StandardSetupColumns): boolean {
  return (
    LEARNED_KEYS.every((key) => sameValue(valueNow(key, org), STANDARD_SETTING[key])) &&
    org.squadMode === "weekly" &&
    org.featureAttendance &&
    org.featureBench &&
    !org.featureSquadFromList
  );
}

export interface SetupAskDmInput {
  lang: string;
  club: string;
  group: string | null;
  reading: ChatReading;
  /** `isStandardSetup` of the club as it is NOW. */
  standard: boolean;
  /** /admin/activities */
  scheduleUrl: string;
  /** /admin/players/ratings */
  ratingsUrl: string;
  /** /admin/settings: where Go live is. */
  settingsUrl: string;
  /** /admin/settings at the learned panel. Used when there are findings. */
  learnedUrl?: string | null;
  /** /admin/settings at the "organisers pick" suggestion, when it is one. */
  organiserPicksUrl?: string | null;
  /**
   * THE ADMIN GROUP BLOCK (go-live slice S7): `setupAdminGroupBlock`
   * (club-setup-followup-rules.ts), passed by `sendSetupDm` for a club
   * with no admin group linked. When given it goes in as its own block
   * right before the GO line.
   */
  adminGroupBlock?: string | null;
  /**
   * Will going live START A FREE PERIOD for this club (`freePeriodCanStart`
   * in club-billing-rules.ts: billing on, plan not Free, none had yet)?
   * Only then is the free period line said. Required, so every caller
   * decides: a Free club, or a deployment with billing off, is never told
   * about a free period that will not start.
   */
  freePeriod: boolean;
}

export function composeSetupAskDm(p: SetupAskDmInput): string {
  const s = t(p.lang);
  const blocks: string[] = [s.sj_dm_ready_head({ club: p.club, group: p.group })];

  const r = p.reading;
  const hasFindings = r.kind === "findings";
  const detailUrl = hasFindings && p.learnedUrl ? p.learnedUrl : p.settingsUrl;
  if (r.kind === "findings") {
    blocks.push(
      ...setupFindingsBlocks({
        lang: p.lang,
        group: p.group,
        applied: r.applied,
        suggestions: r.suggestions,
        noted: r.noted,
        scheduleUrl: p.scheduleUrl,
        settingsUrl: detailUrl,
        organiserPicksUrl: p.organiserPicksUrl ?? detailUrl,
      }),
    );
  } else if (r.kind === "nothing") {
    blocks.push(s.sj_dm_ready_nothing({ group: p.group, standard: p.standard }));
  } else if (r.kind === "unread") {
    blocks.push(s.sj_dm_ready_unread({ standard: p.standard }));
  }

  // Never beside a switched setting, and never when the organiser has
  // already moved the club off the defaults.
  const switched = r.kind === "findings" && r.applied.length > 0;
  if (!switched && p.standard) blocks.push(s.sj_dm_ready_standard);

  blocks.push(s.sj_dm_ready_settings({ url: detailUrl }));
  blocks.push(s.sj_dm_ready_schedule({ url: p.scheduleUrl }));
  blocks.push(s.sj_dm_ready_ratings({ url: p.ratingsUrl }));

  // ════ ADMIN GROUP BLOCK: INSERTION POINT (go-live slice S7) ════
  // The optional "add me to your organisers' group" step goes here, as one
  // block, between the ratings line and the GO line, passed in as
  // `adminGroupBlock` (slice S7: club-setup-dm.ts, for a club with no
  // admin group linked).
  if (p.adminGroupBlock) blocks.push(p.adminGroupBlock);
  // ════ END ADMIN GROUP BLOCK ════

  // The button is named as the settings page and the GO replies name it.
  blocks.push(s.sj_dm_ready_go({ url: p.settingsUrl, button: s.sj_go_button }));
  if (p.freePeriod) blocks.push(s.sj_dm_ready_free);
  return blocks.join("\n\n");
}
