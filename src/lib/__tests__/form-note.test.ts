/**
 * A FORM NOTE, ANSWERED HONESTLY (Sutton FC, 2026-11-10).
 *
 * "@Match Time reduce my strength for this match as I am quite tired." was
 * sent to the club's settings page. The rating adjuster already reads the
 * week's chat when the teams are made, so the message does what was asked.
 * The line says that only when MatchTime makes this club's teams.
 *
 * Then (Kemal, same day): say the amount, so it can be changed. The amount
 * the extractor read is stored for the next match when the sender may set
 * it (a player for themselves, an organiser for anyone) and said; a change
 * or a cancel updates it.
 */
import { describe, it, expect } from "vitest";
import { formNoteReplyFor, recordFormNote, type FormNoteStore } from "../form-note";
import type { PersonPicker } from "../pipeline/who-is-who";
import { world } from "../pipeline/__tests__/helpers";

const NOW = new Date("2026-11-10T12:14:31Z");

function memoryStore(seed: Array<{ matchId: string; userId: string; delta: number; reason: string }> = []) {
  const rows = new Map(seed.map((r) => [`${r.matchId}:${r.userId}`, { ...r, setByUserId: null as string | null }]));
  const store: FormNoteStore = {
    async save(n) {
      const key = `${n.matchId}:${n.userId}`;
      const before = rows.get(key);
      const reason = n.reason || before?.reason || "";
      rows.set(key, { matchId: n.matchId, userId: n.userId, delta: n.delta, reason, setByUserId: n.setByUserId });
      return { existed: !!before, reason };
    },
  };
  return { store, rows };
}

const TUESDAY = { ...world(), matchDayName: "Tuesday" };
const names: Record<string, string> = { "u-kemal": "Kemal Ediz", "u-elvin": "Elvin Aliyev", "u-sait": "Sait Demir" };
const nameOf = (id: string) => names[id] ?? "?";
const byName: Record<string, string> = { elvin: "u-elvin", sait: "u-sait", kemal: "u-kemal" };
const userIdOf = (ref: string) => byName[ref.toLowerCase()] ?? null;
const base = { orgId: "org-1", state: TUESDAY, userIdOf, nameOf, sourceMessageId: "wa-1" };
const player = { userId: "u-sait", isOrganiser: false };
const organiser = { userId: "u-kemal", isOrganiser: true };

describe("recordFormNote: the amount stored for the next match, and said", () => {
  it("a player about themselves: stored, and MatchTime says the amount, never a rating", async () => {
    const { store, rows } = memoryStore();
    const r = await recordFormNote({ ...base, lang: "en", facts: { form: [{ personRef: "me", delta: -0.5, reason: "tired" }] }, sender: player, store });
    expect(r.reply).toBe("Noted: -0.5 for Sait Demir (tired) in Tuesday's game. Want a different amount? Tag me, e.g. make it -1.");
    expect(rows.get("match-1:u-sait")).toEqual({ matchId: "match-1", userId: "u-sait", delta: -0.5, reason: "tired", setByUserId: "u-sait" });
  });

  it("amended: 'make it -1' keeps the reason and says Changed", async () => {
    const { store, rows } = memoryStore([{ matchId: "match-1", userId: "u-sait", delta: -0.5, reason: "tired" }]);
    const r = await recordFormNote({ ...base, lang: "en", facts: { form: [{ personRef: "Sait", delta: -1, reason: "" }] }, sender: player, store });
    expect(r.reply).toBe("Changed: -1 for Sait Demir (tired) in Tuesday's game.");
    expect(rows.get("match-1:u-sait")!.delta).toBe(-1);
  });

  it("cancelled: stored as no adjustment, so the adjuster cannot put it back from the chat", async () => {
    const { store, rows } = memoryStore([{ matchId: "match-1", userId: "u-sait", delta: -0.5, reason: "tired" }]);
    const r = await recordFormNote({
      ...base,
      lang: "tr",
      state: { ...TUESDAY, matchDayName: "Salı" },
      facts: { form: [{ personRef: "me", delta: 0, reason: "" }] },
      sender: player,
      store,
    });
    expect(r.reply).toBe("Değiştirdim: Salı maçında Sait Demir için puan ayarı yok.");
    expect(rows.get("match-1:u-sait")!.delta).toBe(0);
  });

  it("an organiser sets another player's", async () => {
    const { store, rows } = memoryStore();
    const r = await recordFormNote({ ...base, lang: "en", facts: { form: [{ personRef: "Elvin", delta: -1, reason: "bad knee" }] }, sender: organiser, store });
    expect(r.reply).toBe("Noted: -1 for Elvin Aliyev (bad knee) in Tuesday's game. Want a different amount? Tag me, e.g. make it -0.5.");
    expect(rows.get("match-1:u-elvin")).toMatchObject({ delta: -1, setByUserId: "u-kemal" });
  });

  it("a player about another player: the plain line, nothing stored", async () => {
    const { store, rows } = memoryStore();
    const r = await recordFormNote({ ...base, lang: "en", facts: { form: [{ personRef: "Elvin", delta: -1, reason: "bad knee" }] }, sender: player, store });
    expect(r.reply).toBe("Noted: I'll take it into account when the teams are made, for this match only.");
    expect(rows.size).toBe(0);
  });

  it("a player changing another player's amount: nothing stored either", async () => {
    const { store, rows } = memoryStore([{ matchId: "match-1", userId: "u-elvin", delta: -0.5, reason: "tired" }]);
    await recordFormNote({ ...base, lang: "en", facts: { form: [{ personRef: "Elvin", delta: 1, reason: "" }] }, sender: player, store });
    expect(rows.get("match-1:u-elvin")!.delta).toBe(-0.5);
  });

  it("an explicit amount past the cap is clamped and the line says so", async () => {
    const { store, rows } = memoryStore();
    const r = await recordFormNote({ ...base, lang: "en", facts: { form: [{ personRef: "me", delta: -3, reason: "ill" }] }, sender: player, store });
    expect(rows.get("match-1:u-sait")!.delta).toBe(-1);
    expect(r.reply).toContain("1 is the most either way.");
  });

  it("no match: 'Noted.', nothing stored", async () => {
    const { store, rows } = memoryStore();
    const r = await recordFormNote({
      ...base,
      lang: "en",
      state: { ...world({ noMatch: true }), matchDayName: null },
      facts: { form: [{ personRef: "me", delta: -0.5, reason: "tired" }] },
      sender: player,
      store,
    });
    expect(r.reply).toBe("Noted.");
    expect(rows.size).toBe(0);
  });

  it("a store that fails (the table not migrated yet): the plain line, no amount claimed", async () => {
    const r = await recordFormNote({
      ...base,
      lang: "en",
      facts: { form: [{ personRef: "me", delta: -0.5, reason: "tired" }] },
      sender: player,
      store: {
        async save() {
          throw new Error('relation "FormNote" does not exist');
        },
      },
    });
    expect(r.reply).toBe("Noted: I'll take it into account when the teams are made, for this match only.");
    expect(r.stored).toEqual([]);
  });
});

describe("formNoteReplyFor, the organisers' group, with the facts", () => {
  const identify: PersonPicker = async (req) => ({
    picks: new Map(
      req.messages.map((m) => [
        m.id,
        new Map(m.refs.map((ref) => [ref, ref === "Tom" ? { kind: "member" as const, userId: "u-elvin" } : { kind: "none" as const }])),
      ]),
    ),
    usage: null,
    degradations: [],
  });
  const deps = (store: FormNoteStore) => ({
    loadFeatures: async () => ({ teamBalancing: true }),
    loadState: async () => TUESDAY,
    identify,
    store,
  });

  it("an organiser sets a player's amount by name: stored and said", async () => {
    const { store, rows } = memoryStore();
    const r = await formNoteReplyFor({
      orgId: "org-1",
      now: NOW,
      lang: "en",
      facts: { form: [{ personRef: "Tom", delta: -1, reason: "bad knee" }] },
      sender: { userId: "u-kemal", name: "Kemal Ediz", isOrganiser: true },
      body: "@Match Time Tom has a bad knee, -1 for him",
      messageId: "hq-1",
      deps: deps(store),
    });
    expect(r).toBe("Noted: -1 for Elvin Aliyev (bad knee) in Tuesday's game. Want a different amount? Tag me, e.g. make it -0.5.");
    expect(rows.get("match-1:u-elvin")).toMatchObject({ delta: -1, setByUserId: "u-kemal" });
  });

  it("a name nobody is sure of: the plain line", async () => {
    const { store, rows } = memoryStore();
    const r = await formNoteReplyFor({
      orgId: "org-1",
      now: NOW,
      lang: "en",
      facts: { form: [{ personRef: "Zed", delta: -1, reason: "ill" }] },
      sender: { userId: "u-kemal", name: "Kemal Ediz", isOrganiser: true },
      deps: deps(store),
    });
    expect(r).toBe("Noted: I'll take it into account when the teams are made, for this match only.");
    expect(rows.size).toBe(0);
  });
});

describe("formNoteReplyFor", () => {
  it("a club whose teams MatchTime makes, teams not made yet", async () => {
    const r = await formNoteReplyFor({
      orgId: "org-1",
      now: NOW,
      lang: "en",
      deps: { loadFeatures: async () => ({ teamBalancing: true }), loadState: async () => world() },
    });
    expect(r).toBe("Noted: I'll take it into account when the teams are made, for this match only.");
  });

  it("the teams already made", async () => {
    const r = await formNoteReplyFor({
      orgId: "org-1",
      now: NOW,
      lang: "tr",
      deps: { loadFeatures: async () => ({ teamBalancing: true }), loadState: async () => world({ teams: { kemal: "RED" } }) },
    });
    expect(r).toBe("Not aldım. Bu maçın takımları zaten kuruldu; takımlar yeniden kurulursa bunu dikkate alacağım.");
  });

  it("a club whose teams MatchTime does not make: null, nothing said, the state never read", async () => {
    let read = false;
    const r = await formNoteReplyFor({
      orgId: "org-1",
      now: NOW,
      lang: "en",
      deps: {
        loadFeatures: async () => ({ teamBalancing: false }),
        loadState: async () => {
          read = true;
          return world();
        },
      },
    });
    expect(r).toBeNull();
    expect(read).toBe(false);
  });
});
