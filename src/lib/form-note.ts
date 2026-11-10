/**
 * A FORM NOTE: STORED WITH ITS AMOUNT, AND SAID (2026-11-10).
 *
 * The teams extractor's `form`: a player tells MatchTime how they, or a
 * team-mate, will play in the next match (tired, ill, injured, in form), or
 * changes or cancels the amount MatchTime said it will use. Sutton FC's
 * "@Match Time reduce my strength for this match as I am quite tired." was
 * sent to the settings page (#584); then Kemal: "it would be nice if it
 * tells explicitly how much rating adjustment it made (not giving the final
 * rating) so if I don't like it, I can get it amended further."
 *
 * So the amount is decided when the note is given (the extractor, on the
 * one scale the rating adjuster uses: `form-scale.ts`), stored per player
 * per match (`FormNote`) when the sender may set it (`form-note-rules.ts`:
 * a player for themselves, an organiser for anyone), and said. When the
 * teams are made a stored note wins over the adjuster for that player
 * (`team-generation.ts`). Talk about somebody else by a player is
 * acknowledged as before and the adjuster reads it from the chat.
 *
 * Both groups use `recordFormNote`: the players' group from its batch
 * (`team-ops-engine-batch.ts`, which has already identified the names), and
 * the organisers' group through `formNoteReplyFor`, which loads what the
 * line depends on. Null from `formNoteReplyFor` when MatchTime does not
 * make this club's teams (`teamBalancing` off): then nothing is said, as
 * the players' group says nothing.
 *
 * Every database failure (the table not yet migrated included) falls back
 * to the plain #584 line: nothing is claimed that was not stored.
 */
import type { Lang } from "./i18n/lang";
import type { SquadState, TeamFacts } from "./pipeline/types";
import { formNoteReply } from "./team-ops-engine";
import { formNoteSavedReply, planFormNotes, type FormSender, type PlannedNote } from "./form-note-rules";
import { refKey, whoRosterOf, type PersonPicker, type PersonPicks } from "./pipeline/who-is-who";

/** Where notes are kept. Injected in tests; `prismaFormNoteStore` in
 *  production. */
export interface FormNoteStore {
  /** Create or update the player's note for the match. An empty reason
   *  keeps the stored one (a change of amount gives none). Returns whether
   *  a note was already there, and the reason now stored. */
  save(note: {
    orgId: string;
    matchId: string;
    userId: string;
    delta: number;
    reason: string;
    setByUserId: string | null;
    sourceMessageId: string | null;
  }): Promise<{ existed: boolean; reason: string }>;
}

export const prismaFormNoteStore: FormNoteStore = {
  async save(note) {
    const { db } = await import("./db");
    const before = await db.formNote.findUnique({
      where: { matchId_userId: { matchId: note.matchId, userId: note.userId } },
      select: { reason: true },
    });
    const reason = note.reason || before?.reason || "";
    await db.formNote.upsert({
      where: { matchId_userId: { matchId: note.matchId, userId: note.userId } },
      create: {
        orgId: note.orgId,
        matchId: note.matchId,
        userId: note.userId,
        delta: note.delta,
        reason,
        setByUserId: note.setByUserId,
        sourceMessageId: note.sourceMessageId,
      },
      update: { delta: note.delta, reason, setByUserId: note.setByUserId, sourceMessageId: note.sourceMessageId },
    });
    return { existed: before !== null, reason };
  },
};

export interface RecordFormNoteResult {
  reply: string;
  /** What was stored, for the log. Empty when nothing was. */
  stored: PlannedNote[];
  logReason: string;
}

/**
 * Store what may be stored and say it. `userIdOf` is who-is-who's sure pick
 * for a quoted name; `nameOf` the name to print. With no match there is
 * nothing to store a note against ("Noted."); with nothing the sender may
 * set, the plain line (#584).
 */
export async function recordFormNote(args: {
  orgId: string;
  lang?: Lang | string | null;
  facts: Pick<TeamFacts, "form">;
  sender: FormSender;
  state: Pick<SquadState, "matchId" | "teams" | "matchDayName">;
  userIdOf: (ref: string) => string | null;
  nameOf: (userId: string) => string;
  sourceMessageId: string | null;
  store: FormNoteStore;
}): Promise<RecordFormNoteResult> {
  const teamsMade = args.state.teams.length > 0;
  const plain = (why: string): RecordFormNoteResult => ({
    reply: formNoteReply({ lang: args.lang, matchId: args.state.matchId, teamsMade }),
    stored: [],
    logReason: why,
  });
  const matchId = args.state.matchId;
  if (!matchId || !args.state.matchDayName) return plain("no match to note it for");
  const plan = planFormNotes({ claims: args.facts.form ?? [], sender: args.sender, userIdOf: args.userIdOf });
  if (plan.store.length === 0) {
    return plain(`nothing the sender may set (${plan.others} about somebody else or nobody sure); the adjuster reads it from the chat`);
  }
  const saved: Array<{ name: string; delta: number; reason: string; changed: boolean; clamped: boolean }> = [];
  try {
    for (const n of plan.store) {
      const r = await args.store.save({
        orgId: args.orgId,
        matchId,
        userId: n.userId,
        delta: n.delta,
        reason: n.reason,
        setByUserId: args.sender.userId,
        sourceMessageId: args.sourceMessageId,
      });
      saved.push({ name: args.nameOf(n.userId), delta: n.delta, reason: r.reason, changed: r.existed, clamped: n.clamped });
    }
  } catch (err) {
    console.error("[form-note] storing the note failed; the plain line instead:", err);
    return plain(`storing failed (${err instanceof Error ? err.message : String(err)}); the adjuster reads it from the chat`);
  }
  return {
    reply: formNoteSavedReply({
      lang: args.lang,
      dayName: args.state.matchDayName,
      teamsMade,
      saved,
      othersToo: plan.others > 0,
    }),
    stored: plan.store,
    logReason: `stored ${plan.store.map((n) => `${n.userId} ${n.delta}`).join(", ")} for match ${matchId}${plan.others > 0 ? `; ${plan.others} acknowledged only` : ""}`,
  };
}

export interface FormNoteDeps {
  loadFeatures?: (orgId: string) => Promise<{ teamBalancing: boolean }>;
  loadState?: (
    orgId: string,
    now: Date,
  ) => Promise<Pick<SquadState, "matchId" | "teams"> & Partial<Pick<SquadState, "matchDayName" | "roster">>>;
  /** Who the quoted names are (`who-is-who.ts`). Injected by tests. */
  identify?: PersonPicker;
  store?: FormNoteStore;
}

/**
 * THE ORGANISERS' GROUP'S WAY TO THE SAME LINE. The sender there is an
 * organiser (HQ's teams need one), so a note may be set for anyone. Loads
 * the club's features and squad state, looks the names up in one
 * who-is-who call against the club's members, then `recordFormNote`.
 * Without `facts` (or without a sender) the plain line, as #584 said it.
 */
export async function formNoteReplyFor(args: {
  orgId: string;
  now: Date;
  lang?: Lang | string | null;
  facts?: Pick<TeamFacts, "form">;
  sender?: { userId: string | null; name: string | null; isOrganiser: boolean };
  body?: string;
  messageId?: string | null;
  deps?: FormNoteDeps;
}): Promise<string | null> {
  const loadFeatures =
    args.deps?.loadFeatures ?? (async (id: string) => (await import("./org-features")).getOrgFeatures(id));
  if (!(await loadFeatures(args.orgId)).teamBalancing) return null;
  const loadState =
    args.deps?.loadState ?? (async (id: string, now: Date) => (await import("./pipeline/load-state")).loadSquadState(id, now));
  const state = await loadState(args.orgId, args.now);
  if (!args.facts || !args.sender || (args.facts.form ?? []).length === 0) {
    return formNoteReply({ lang: args.lang, matchId: state.matchId, teamsMade: state.teams.length > 0 });
  }
  const roster = state.roster ?? [];
  let people: PersonPicks = new Map();
  try {
    const { identifyRefs, personPickerFor } = await import("./pipeline/identify-batch");
    const res = await identifyRefs({
      picker: args.deps?.identify ?? personPickerFor(),
      refs: (args.facts.form ?? []).map((f) => f.personRef),
      body: args.body ?? "",
      author: args.sender.name,
      senderUserId: args.sender.userId,
      roster: whoRosterOf(roster),
      where: "HQ, the club organisers' admin group, about a player's form for the next match",
    });
    people = res.people;
  } catch (err) {
    console.error("[form-note] who-is-who failed; nobody named is identified:", err);
  }
  const r = await recordFormNote({
    orgId: args.orgId,
    lang: args.lang,
    facts: args.facts,
    sender: { userId: args.sender.userId, isOrganiser: args.sender.isOrganiser },
    state: { matchId: state.matchId, teams: state.teams, matchDayName: state.matchDayName ?? null },
    userIdOf: pickedUserId(people),
    nameOf: (id) => {
      const m = roster.find((x) => x.userId === id);
      return m?.displayName || m?.name || "?";
    },
    sourceMessageId: args.messageId ?? null,
    store: args.deps?.store ?? prismaFormNoteStore,
  });
  console.log(`[form-note] HQ ${args.messageId ?? "?"}: ${r.logReason}`);
  return r.reply;
}

/** who-is-who's SURE pick for a quoted name, or null. */
export function pickedUserId(people: PersonPicks | undefined): (ref: string) => string | null {
  return (ref) => {
    const pick = people?.get(refKey(ref));
    return pick?.kind === "member" ? pick.userId : null;
  };
}
