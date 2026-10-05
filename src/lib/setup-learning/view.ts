/**
 * F3, LEARNED SETUP: what /admin/settings shows, and the one-tap undo.
 *
 * The panel lists each switched setting with its chat evidence and an
 * Undo button, the suggestions (changed nowhere) and the noted patterns.
 * Undo puts the setting back to the value it had before, ONLY while it
 * still holds the value MatchTime set (a compare-and-set): a setting the
 * organiser has changed since is theirs, and is reported "changed since"
 * rather than overwritten. An undone setting is recorded as the
 * organiser's own choice (`settingsSetByOrganiser`).
 */
import { db } from "../db";
import { APPROVED_CLUB_WHERE } from "../club-approval";
import {
  LEARNED_KEYS,
  ORGANISER_SET_KEY,
  currentValue,
  dataFor,
  sameValue,
  type AppliedItem,
  type LearnedKey,
  type NotedPattern,
  type OrgSettingsState,
  type Suggestion,
} from "./rules";

export type AppliedState = "active" | "undone" | "changed";

export interface LearnedSetupView {
  createdAt: string;
  applied: Array<AppliedItem & { state: AppliedState }>;
  suggestions: Suggestion[];
  noted: NotedPattern[];
}

const SETTINGS_SELECT = {
  rollingSquadEnabled: true,
  benchPickMode: true,
  dropOutDeadlineDay: true,
  dropOutDeadlineTime: true,
  listPublishDay: true,
  listPublishTime: true,
  paymentTrackingEnabled: true,
  language: true,
  settingsSetByOrganiser: true,
} as const;

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function appliedState(item: AppliedItem, org: OrgSettingsState): AppliedState {
  if (item.undoneAt) return "undone";
  return sameValue(currentValue(item.key, org), item.to) ? "active" : "changed";
}

/** Null when the club was never read, or nothing came of it. */
export async function loadLearnedSetupView(orgId: string): Promise<LearnedSetupView | null> {
  const row = await db.clubSetupLearning.findUnique({
    where: { orgId },
    select: { status: true, applied: true, suggestions: true, noted: true, createdAt: true },
  });
  if (!row || (row.status !== "applied" && row.status !== "nothing")) return null;
  const applied = asArray<AppliedItem>(row.applied);
  const suggestions = asArray<Suggestion>(row.suggestions);
  const noted = asArray<NotedPattern>(row.noted);
  if (applied.length + suggestions.length + noted.length === 0) return null;
  const org = (await db.organisation.findUnique({ where: { id: orgId }, select: SETTINGS_SELECT })) as OrgSettingsState | null;
  if (!org) return null;
  return {
    createdAt: row.createdAt.toISOString(),
    applied: applied.map((a) => ({ ...a, state: appliedState(a, org) })),
    suggestions,
    noted,
  };
}

export type UndoResult = { ok: true } | { ok: false; reason: "not-found" | "already-undone" | "changed-since" };

export async function undoLearnedSetting(orgId: string, key: string, now: Date = new Date()): Promise<UndoResult> {
  if (!(LEARNED_KEYS as readonly string[]).includes(key)) return { ok: false, reason: "not-found" };
  const k = key as LearnedKey;
  const row = await db.clubSetupLearning.findUnique({ where: { orgId }, select: { applied: true } });
  const applied = asArray<AppliedItem>(row?.applied);
  const item = applied.find((a) => a.key === k);
  if (!item) return { ok: false, reason: "not-found" };
  if (item.undoneAt) return { ok: false, reason: "already-undone" };

  // Compare-and-set: the columns must still hold what MatchTime set.
  const holds = dataFor(k, item.to);
  const { count } = await db.organisation.updateMany({
    where: { id: orgId, ...APPROVED_CLUB_WHERE, ...holds },
    data: { ...dataFor(k, item.from), settingsSetByOrganiser: { push: ORGANISER_SET_KEY[k] } },
  });
  if (count !== 1) return { ok: false, reason: "changed-since" };
  const next = applied.map((a) => (a.key === k ? { ...a, undoneAt: now.toISOString() } : a));
  await db.clubSetupLearning.update({ where: { orgId }, data: { applied: next as unknown as object } });
  console.log(`[setup-learning] ${orgId}: organiser undid ${k}`);
  return { ok: true };
}
