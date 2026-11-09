/**
 * RED-first spec: an @-mention is named from the ORG ROSTER, or not at all.
 *
 * ── Why this module exists (measured, 2026-09-08) ────────────────────
 * The Pi used to resolve every @-mention through
 * `client.getContactById(jid)` and paste the contact's pushname straight
 * into the body the analyzer reads. That pushname is the mentioned
 * person's OWN, self-chosen WhatsApp profile name — not what the club
 * calls them, and not what WhatsApp showed the person who typed the
 * message (WhatsApp renders a mention from the READER's address book).
 *
 * Two real messages from the live Sutton FC group:
 *
 *   typed:  "@Shahrokh🐔 Sutton Football Club is out due to unforeseen …"
 *   stored: "@DÇ  is out due to unforeseen issue at work"      → noise
 *
 *   typed:  "@David David 67 and @~Najib out"
 *   stored: "@割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂ and @Najib out"    → David's drop lost
 *
 * Both drops were silently lost. `"割::::.̸̢̤̋…"` is not corruption: it
 * occurs 13 times as `AnalyzedMessage.authorName` for this org (it is
 * David's pushname) and an admin has ALREADY curated
 * `UserAlias["割::::.."] → David`. So the club's own database knew the
 * answer while the body said something no human would recognise.
 *
 * ── The rule ─────────────────────────────────────────────────────────
 * The name substituted into a message body comes from the roster, in
 * descending order of trust:
 *
 *   1. PHONE   — a "<digits>@c.us" mention IS the person's phone number.
 *                Unique key, no guessing.
 *   2. THE MODEL'S PICK (2026-11-09) — who-is-who is shown the club's
 *                members with their `UserAlias` rows and the pushname, and
 *                says which member it is (`nameMentions`); read by
 *                `resolvePerson()`, which bails on anything but one sure
 *                member. No pushname is matched by spelling.
 *
 * Anything else leaves the raw "@<digits>" token exactly as it arrived.
 * A raw token is refused downstream by `identity.ts`'s "raw digits are
 * never a name" rule — an honest unknown, which is what we want, instead
 * of a fabricated one.
 */
import { describe, it, expect } from "vitest";
import { nameMentions, resolveMentionNames } from "./mention-names";
import type { PersonPick, PersonPicker, PersonPicks } from "./who-is-who";

const DAVID_PUSHNAME = "割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂";

const ROSTER = [
  { userId: "u-kemal", name: "Kemal", phone: "+447700900001" },
  { userId: "u-david", name: "David", phone: null },
  { userId: "u-najib", name: "Najib", phone: "+447700900321" },
  { userId: "u-shahrokh", name: "Shahrokh", phone: "+447700900777" },
  { userId: "u-mojib", name: "Mojib", phone: null },
  { userId: "u-ibrahim-s", name: "Ibrahim Sahin", phone: null },
  { userId: "u-ibrahim-k", name: "Ibrahim Kaya", phone: null },
];

const ALIASES = [{ alias: "割::::..", userId: "u-david" }];

const base = { roster: ROSTER, aliases: ALIASES };

/** who-is-who's answers for the pushnames: a member id, or null for nobody. */
const pick = (...entries: Array<[string, string | null]>): PersonPicks =>
  new Map<string, PersonPick>(entries.map(([k, id]) => [k, id ? { kind: "member", userId: id } : { kind: "none" }]));

describe("no pushname is matched by spelling (2026-11-09)", () => {
  it("RED on main: an exact member name as pushname, with no pick, names nobody", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767399 in",
      mentions: ["233452997767399@lid"],
      mentionNames: [{ jid: "233452997767399@lid", name: "Mojib" }],
    });
    expect(out.body).toBe("@233452997767399 in");
    expect(out.outcomes[0].pushname).toBe("Mojib");
  });

  it("nameMentions asks who-is-who ONCE for every pushname the phone rung left, across messages", async () => {
    const calls: Array<{ refs: string[][]; aliases: string[] }> = [];
    const picker: PersonPicker = async (req) => {
      calls.push({ refs: req.messages.map((m) => m.refs), aliases: req.roster.flatMap((m) => [...(m.aliases ?? [])]) });
      return {
        picks: new Map(req.messages.map((m) => [m.id, new Map<string, PersonPick>(m.refs.map((r) => [r, r === "Mojib Jalali" ? { kind: "member", userId: "u-mojib" } : { kind: "none" }]))])),
        usage: null,
        degradations: [],
      };
    };
    const out = await nameMentions({
      roster: ROSTER,
      aliases: ALIASES,
      picker,
      messages: [
        { body: "@233452997767399 in", mentions: ["233452997767399@lid"], mentionNames: [{ jid: "233452997767399@lid", name: "Mojib Jalali" }] },
        { body: "@447700900321 out", mentions: ["447700900321@c.us"] },
        { body: "@158055467598020 out", mentions: ["158055467598020@lid"], mentionNames: [{ jid: "158055467598020@lid", name: "DÇ" }] },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].refs).toEqual([["Mojib Jalali"], ["DÇ"]]);
    expect(calls[0].aliases).toContain("割::::..");
    expect(out.map((o) => o.body)).toEqual(["@Mojib in", "@Najib out", "@158055467598020 out"]);
  });

  it("nameMentions makes no call when the phone rung named everyone", async () => {
    let called = 0;
    const picker: PersonPicker = async () => {
      called++;
      return { picks: new Map(), usage: null, degradations: [] };
    };
    await nameMentions({ roster: ROSTER, picker, messages: [{ body: "@447700900321 out", mentions: ["447700900321@c.us"] }] });
    expect(called).toBe(0);
  });
});

describe("resolveMentionNames", () => {
  it("REGRESSION: the David drop — an alias recovers the roster name", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767322 and @447700900321 out",
      mentions: ["233452997767322@lid", "447700900321@c.us"],
      mentionNames: [{ jid: "233452997767322@lid", name: "割::::.." }],
      // who-is-who, shown the club's alias "割::::.." for David, picks him.
      people: pick(["割::::..", "u-david"]),
    });
    expect(out.body).toBe("@David and @Najib out");
    expect(out.outcomes.map((o) => o.via)).toEqual(["roster", "phone"]);
  });

  it("REGRESSION: the Shahrokh drop — an unresolvable name leaves the raw token", () => {
    // "DÇ" is Shahrokh's pushname. It folds to "dc", matches no member and
    // has no alias, so nothing may be substituted. The old code pasted it.
    const out = resolveMentionNames({
      ...base,
      body: "@158055467598020 is out due to unforeseen issue at work",
      mentions: ["158055467598020@lid"],
      mentionNames: [{ jid: "158055467598020@lid", name: "DÇ" }],
    });
    expect(out.body).toBe("@158055467598020 is out due to unforeseen issue at work");
    expect(out.body).not.toContain("DÇ");
    expect(out.outcomes[0].member).toBeNull();
    expect(out.outcomes[0].via).toBeNull();
  });

  it("never substitutes a name with no letters, even with no roster match", () => {
    const out = resolveMentionNames({
      roster: ROSTER,
      aliases: [], // no curated alias this time
      body: "@233452997767322 out",
      mentions: ["233452997767322@lid"],
      mentionNames: [{ jid: "233452997767322@lid", name: DAVID_PUSHNAME }],
    });
    expect(out.body).toBe("@233452997767322 out");
    expect(out.body).not.toContain("割");
  });

  it("a RAW, unsanitised pushname is the model's to place: its pick names the mention", () => {
    // Since 2026-11-09 no pushname is folded and compared in code; the
    // model is shown the alias beside David and says the pushname is him.
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767322 out",
      mentions: ["233452997767322@lid"],
      mentionNames: [{ jid: "233452997767322@lid", name: DAVID_PUSHNAME }],
      people: pick([DAVID_PUSHNAME, "u-david"]),
    });
    expect(out.body).toBe("@David out");
    expect(out.outcomes[0].via).toBe("roster");
  });

  it("names a @c.us mention from its phone number, with no candidate name at all", () => {
    // The strongest path: the mention JID IS the phone. No contact lookup,
    // nothing the mentioned person controls, nothing to verify.
    const out = resolveMentionNames({
      ...base,
      body: "@447700900777 is out due to unforeseen issue at work",
      mentions: ["447700900777@c.us"],
    });
    expect(out.body).toBe("@Shahrokh is out due to unforeseen issue at work");
    expect(out.outcomes[0].via).toBe("phone");
  });

  it("names a mention from the roster when the model picks the member for the pushname", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767399 in",
      mentions: ["233452997767399@lid"],
      mentionNames: [{ jid: "233452997767399@lid", name: "Mojib Jalali" }],
      people: pick(["Mojib Jalali", "u-mojib"]),
    });
    expect(out.body).toBe("@Mojib in");
    expect(out.outcomes[0].via).toBe("roster");
  });

  it("handles an emoji pushname without corrupting the body", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767400 is out",
      mentions: ["233452997767400@lid"],
      mentionNames: [{ jid: "233452997767400@lid", name: "Shahrokh Sutton Football Club" }],
      people: pick(["Shahrokh Sutton Football Club", "u-shahrokh"]),
    });
    expect(out.body).toBe("@Shahrokh is out");
  });

  it("bails on ambiguity rather than guessing between two Ibrahims", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767401 out",
      mentions: ["233452997767401@lid"],
      mentionNames: [{ jid: "233452997767401@lid", name: "Ibrahim" }],
    });
    expect(out.body).toBe("@233452997767401 out");
    expect(out.outcomes[0].member).toBeNull();
  });

  it("resolves only the mentions it can, leaving the rest raw", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@158055467598020 and @447700900321 out, @233452997767322 in",
      mentions: ["158055467598020@lid", "447700900321@c.us", "233452997767322@lid"],
      mentionNames: [
        { jid: "158055467598020@lid", name: "DÇ" },
        { jid: "233452997767322@lid", name: "割::::.." },
      ],
      people: pick(["割::::..", "u-david"], ["DÇ", null]),
    });
    expect(out.body).toBe("@158055467598020 and @Najib out, @David in");
  });

  it("does not rewrite a longer number that starts with a mention's digits", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@4477009003219 is a typo",
      mentions: ["447700900321@c.us"],
    });
    expect(out.body).toBe("@4477009003219 is a typo");
  });

  it("never lets a member name containing $ corrupt the replacement", () => {
    const out = resolveMentionNames({
      roster: [{ userId: "u-x", name: "A$AP", phone: "+447700900555" }],
      aliases: [],
      body: "@447700900555 in",
      mentions: ["447700900555@c.us"],
    });
    expect(out.body).toBe("@A$AP in");
  });

  it("refuses a raw-digit pushname as a lookup key", () => {
    const out = resolveMentionNames({
      ...base,
      body: "@233452997767322 out",
      mentions: ["233452997767322@lid"],
      mentionNames: [{ jid: "233452997767322@lid", name: "447700900321" }],
    });
    expect(out.body).toBe("@233452997767322 out");
  });

  it("OLD PI: a body already rewritten with names and no mentionNames is untouched", () => {
    // Servers deploy before the Pi does. An old Pi sends a pre-substituted
    // body with no "@<digits>" left in it — this must be a no-op, not a
    // second pass that mangles it.
    const out = resolveMentionNames({
      ...base,
      body: "@Mojib Jalali and @Najib out",
      mentions: ["233452997767399@lid", "447700900321@c.us"],
    });
    expect(out.body).toBe("@Mojib Jalali and @Najib out");
  });

  it("is a no-op with no mentions, and total against rubbish input", () => {
    expect(resolveMentionNames({ ...base, body: "who's in?" }).body).toBe("who's in?");
    expect(
      resolveMentionNames({
        roster: [],
        body: undefined as unknown as string,
        mentions: ["", "@lid", "x"],
      }).body,
    ).toBe("");
  });
});

// ── 2026-09-30, MT Test: a LID mention named by PHONE ────────────────
//
// "@David is IN" arrived as "@252012071493723 is IN". David is a member
// by phone (+447881432810); under Baileys every mention is a LID, so the
// @c.us phone rule above never fired. The Pi now forwards the phone it
// was told for the LID, and the server also consults the LID-to-phone
// pairs it has stored itself (participant snapshots, the connect DM).
describe("resolveMentionNames: a LID mention named by phone", () => {
  const MT = [
    { userId: "u-david", name: "David", phone: "+447881432810" },
    { userId: "u-elvin", name: "Elvin", phone: "+447423203409" },
  ];

  it("the Pi's forwarded phone names a LID mention", () => {
    const out = resolveMentionNames({
      roster: MT,
      body: "@252012071493723 is IN",
      mentions: ["252012071493723@lid"],
      mentionNames: [{ jid: "252012071493723@lid", phone: "447881432810" }],
    });
    expect(out.body).toBe("@David is IN");
    expect(out.outcomes[0].via).toBe("phone");
  });

  it("the phone outranks a pushname that points somewhere else", () => {
    const out = resolveMentionNames({
      roster: MT,
      body: "@252012071493723 is IN",
      mentions: ["252012071493723@lid"],
      mentionNames: [{ jid: "252012071493723@lid", name: "Elvin", phone: "447881432810" }],
    });
    expect(out.body).toBe("@David is IN");
  });

  it("an unknown forwarded phone falls back to the name, as before", () => {
    const out = resolveMentionNames({
      roster: MT,
      body: "@252012071493723 is IN",
      mentions: ["252012071493723@lid"],
      mentionNames: [{ jid: "252012071493723@lid", name: "Elvin", phone: "447000000000" }],
      people: pick(["Elvin", "u-elvin"]),
    });
    expect(out.body).toBe("@Elvin is IN");
    expect(out.outcomes[0].via).toBe("roster");
  });

  it("a LID the SERVER has stored against a phone names the mention", () => {
    const out = resolveMentionNames({
      roster: MT,
      body: "@252012071493723 is IN",
      mentions: ["252012071493723@lid"],
      knownLids: [{ lid: "252012071493723@lid", phone: "+447881432810" }],
    });
    expect(out.body).toBe("@David is IN");
    expect(out.outcomes[0].via).toBe("stored-lid");
  });

  it("a LID the SERVER has stored against a user names the mention", () => {
    const out = resolveMentionNames({
      roster: MT,
      body: "@252012071493723 is IN",
      mentions: ["252012071493723@lid"],
      knownLids: [{ lid: "252012071493723", userId: "u-david" }],
    });
    expect(out.body).toBe("@David is IN");
  });

  it("a stored LID that points at two different people names nobody", () => {
    const out = resolveMentionNames({
      roster: MT,
      body: "@252012071493723 is IN",
      mentions: ["252012071493723@lid"],
      knownLids: [
        { lid: "252012071493723@lid", userId: "u-david" },
        { lid: "252012071493723@lid", userId: "u-elvin" },
      ],
    });
    expect(out.body).toBe("@252012071493723 is IN");
  });

  it("a stored user who is not on this roster names nobody", () => {
    const out = resolveMentionNames({
      roster: MT,
      body: "@46179639369730 is IN",
      mentions: ["46179639369730@lid"],
      knownLids: [{ lid: "46179639369730@lid", userId: "u-stranger" }],
    });
    expect(out.body).toBe("@46179639369730 is IN");
  });
});
