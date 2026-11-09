/**
 * "@Match Time DM these people" (Vets MNF, 2026-11-09): the pure rules.
 * Who was tagged (from WhatsApp's own mention data, never from the words),
 * which message's tags are meant, who of them MatchTime knows, and who is
 * DM'd, left out or named in the reply.
 */
import { describe, expect, it } from "vitest";
import {
  MESSAGE_MENTIONS_RETENTION_DAYS,
  NAMED_ABOVE_LOOKBACK_MS,
  NAMED_INVITE_CAP,
  mentionsPurgeBefore,
  namedInviteReply,
  pickAbove,
  pickNamedMentions,
  planNamedInvites,
  resolveNamedMentions,
  storedMentionsOf,
  taggedPeopleOf,
  type KnownPerson,
  type NamedInvitePlan,
  type StoredMention,
  type TaggedSource,
} from "../named-invite-rules";

const LID_BH = "158055467598020@lid";
const LID_MATT = "201112223334445@lid";
const LID_STRANGER = "309998887776665@lid";
const BOT_LID = "999000111222333@lid";

describe("storedMentionsOf: the people a message tagged, never the bot", () => {
  it("each mention the Pi named, with the phone behind a LID mention", () => {
    expect(
      storedMentionsOf({
        mentions: [LID_BH, LID_MATT],
        mentionNames: [
          { jid: LID_BH, name: "BH", phone: "447700900111" },
          { jid: LID_MATT, name: "Matt Afc Walcountians Vets" },
        ],
      }),
    ).toEqual([
      { jid: LID_BH, name: "BH", phone: "447700900111" },
      { jid: LID_MATT, name: "Matt Afc Walcountians Vets" },
    ]);
  });

  it("a phone JID is its own phone", () => {
    expect(storedMentionsOf({ mentions: ["447747410069@c.us"], mentionNames: [{ jid: "447747410069@c.us", name: "Dave" }] })).toEqual([
      { jid: "447747410069@c.us", name: "Dave", phone: "447747410069" },
    ]);
  });

  it("a mention the Pi could not name is kept only when the message did not tag the bot (it may BE the bot)", () => {
    expect(storedMentionsOf({ mentions: [LID_STRANGER, "447594772036@s.whatsapp.net"] })).toEqual([
      { jid: LID_STRANGER },
      { jid: "447594772036@s.whatsapp.net", phone: "447594772036" },
    ]);
    expect(storedMentionsOf({ botMentioned: true, mentions: [BOT_LID, LID_BH], mentionNames: [{ jid: LID_BH, name: "BH" }] })).toEqual([{ jid: LID_BH, name: "BH" }]);
  });

  it("total on junk, deduplicated, nothing for a message with no mentions", () => {
    expect(storedMentionsOf({})).toEqual([]);
    expect(storedMentionsOf({ mentions: "x" as unknown as string[], mentionNames: [null as never, { jid: 5 } as never] })).toEqual([]);
    expect(storedMentionsOf({ mentions: [LID_BH, LID_BH], mentionNames: [{ jid: LID_BH, name: "BH" }, { jid: LID_BH, name: "BH" }] })).toHaveLength(1);
  });
});

describe("taggedPeopleOf: a tag the Pi could not name still counts as a tag (review #1)", () => {
  it("tagging the bot and one person the Pi knew nothing about: one unidentified, never 'nobody tagged'", () => {
    expect(taggedPeopleOf({ botMentioned: true, mentions: [BOT_LID, LID_STRANGER] })).toEqual({ mentions: [], unidentified: 1 });
    expect(taggedPeopleOf({ botMentioned: true, mentions: [BOT_LID, LID_STRANGER, LID_BH], mentionNames: [{ jid: LID_BH, name: "BH" }] })).toEqual({
      mentions: [{ jid: LID_BH, name: "BH" }],
      unidentified: 1,
    });
  });

  it("tagging only the bot is no tag of anyone; untagged messages keep their unnamed JIDs as mentions", () => {
    expect(taggedPeopleOf({ botMentioned: true, mentions: [BOT_LID] })).toEqual({ mentions: [], unidentified: 0 });
    expect(taggedPeopleOf({ mentions: [LID_STRANGER] })).toEqual({ mentions: [{ jid: LID_STRANGER }], unidentified: 0 });
  });
});

describe("mentionsPurgeBefore: who was tagged is kept 7 days, then deleted", () => {
  it("the cutoff is exactly 7 days before now", () => {
    expect(MESSAGE_MENTIONS_RETENTION_DAYS).toBe(7);
    expect(mentionsPurgeBefore(new Date("2026-11-09T06:00:00Z")).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });

  it("outlives the look-back for \"the people above\", with room for a quoted reply a few days later", () => {
    const now = new Date("2026-11-09T06:00:00Z");
    expect(now.getTime() - mentionsPurgeBefore(now).getTime()).toBeGreaterThan(NAMED_ABOVE_LOOKBACK_MS);
  });
});

describe("pickNamedMentions: whose tags are meant", () => {
  const src = (jid: string, senderName: string | null = "Shane"): TaggedSource => ({ mentions: [{ jid }], unidentified: 0, senderName });
  const own = (jid?: string) => ({ mentions: jid ? [{ jid }] : [], unidentified: 0 });

  it("the people tagged in the message itself come first", () => {
    expect(pickNamedMentions({ own: own(LID_BH), isReply: true, quoted: src(LID_MATT), above: src(LID_STRANGER) })).toEqual({
      from: "message",
      people: own(LID_BH),
      senderName: null,
    });
  });

  it("a message that tagged someone the Pi could not name is still its own source: never the quoted or above (review #1)", () => {
    const r = pickNamedMentions({ own: { mentions: [], unidentified: 2 }, isReply: false, quoted: null, above: src(LID_STRANGER) });
    expect(r).toEqual({ from: "message", people: { mentions: [], unidentified: 2 }, senderName: null });
  });

  it("a reply: the message it quotes, and only that one", () => {
    expect(pickNamedMentions({ own: own(), isReply: true, quoted: src(LID_MATT), above: src(LID_STRANGER) })).toMatchObject({ from: "quoted", senderName: "Shane" });
    expect(pickNamedMentions({ own: own(), isReply: true, quoted: { mentions: [], unidentified: 0, senderName: "x" }, above: src(LID_STRANGER) })).toBeNull();
    expect(pickNamedMentions({ own: own(), isReply: true, quoted: null, above: src(LID_STRANGER) })).toBeNull();
  });

  it("not a reply: the latest earlier message that tagged people", () => {
    expect(pickNamedMentions({ own: own(), isReply: false, quoted: null, above: src(LID_STRANGER) })).toMatchObject({ from: "above" });
    expect(pickNamedMentions({ own: own(), isReply: false, quoted: null, above: null })).toBeNull();
  });
});

describe("pickAbove: never a message sent after the request (review #5)", () => {
  const at = (iso: string) => new Date(iso);
  const before = at("2026-11-09T17:30:00Z");
  const row = (sentAt: string, name: string) => ({ mentions: [{ jid: LID_BH }], unidentified: 0, senderName: name, sentAt: at(sentAt) });

  it("the stored row when the batch has nothing earlier", () => {
    expect(pickAbove({ stored: row("2026-11-09T17:20:00Z", "Shane"), batchBefore: [], before })?.senderName).toBe("Shane");
  });

  it("an earlier message in the same flush wins a tie on the clock, by arrival order", () => {
    const r = pickAbove({ stored: row("2026-11-09T17:30:00Z", "Old"), batchBefore: [row("2026-11-09T17:30:00Z", "A"), row("2026-11-09T17:30:00Z", "B")], before });
    expect(r?.senderName).toBe("B");
  });

  it("a newer stored row wins over an older batch message; a batch message stamped after the request never counts", () => {
    expect(pickAbove({ stored: row("2026-11-09T17:25:00Z", "Stored"), batchBefore: [row("2026-11-09T17:10:00Z", "Batch")], before })?.senderName).toBe("Stored");
    expect(pickAbove({ stored: null, batchBefore: [row("2026-11-09T17:31:00Z", "Later")], before })).toBeNull();
  });

  it("messages that tagged nobody are skipped; null when nothing is left", () => {
    expect(pickAbove({ stored: null, batchBefore: [{ mentions: [], unidentified: 0, senderName: "x", sentAt: before }], before })).toBeNull();
  });
});

describe("resolveNamedMentions: only people MatchTime already knows", () => {
  const bh: KnownPerson = { userId: "u-bh", name: "Bilal Hussain", phone: "447700900111" };
  const matt: KnownPerson = { userId: "u-matt", name: "Matt Walker", phone: "447700900222" };
  const dave: KnownPerson = { userId: "u-dave", name: "Dave Jones", phone: "447747410069" };

  it("by the phone behind the mention, by a LID MatchTime stored, else unknown", () => {
    const out = resolveNamedMentions(
      [
        { jid: LID_BH, phone: "447700900111" },
        { jid: LID_MATT },
        { jid: "447747410069@c.us", phone: "447747410069" },
        { jid: LID_STRANGER, name: "Troy" },
        { jid: "447594772036@c.us", phone: "447594772036" },
      ],
      { users: [bh, matt, dave], lids: [{ lid: LID_MATT, userId: "u-matt" }] },
    );
    expect(out.map((r) => r.person?.userId ?? null)).toEqual(["u-bh", "u-matt", "u-dave", null, null]);
  });

  it("a stored LID that names a phone, and a LID that points at two people is unknown", () => {
    const out = resolveNamedMentions(
      [{ jid: LID_BH }, { jid: LID_MATT }],
      {
        users: [bh, matt],
        lids: [
          { lid: "158055467598020", phone: "+44 7700 900111" },
          { lid: LID_MATT, userId: "u-matt" },
          { lid: LID_MATT, userId: "u-bh" },
        ],
      },
    );
    expect(out.map((r) => r.person?.userId ?? null)).toEqual(["u-bh", null]);
  });

  it("a phone two users share is nobody (never guessed)", () => {
    const twin: KnownPerson = { userId: "u-twin", name: "Twin", phone: "447700900111" };
    expect(resolveNamedMentions([{ jid: LID_BH, phone: "447700900111" }], { users: [bh, twin], lids: [] })[0].person).toBeNull();
  });
});

describe("planNamedInvites: who is DM'd", () => {
  const person = (n: number): KnownPerson => ({ userId: `u${n}`, name: `User ${n}`, phone: `4477009000${String(n).padStart(2, "0")}` });
  const known = (n: number, mention: Partial<StoredMention> = {}) => ({ mention: { jid: `${n}0000@lid`, ...mention }, person: person(n) });
  const none = new Set<string>();
  const base = { requesterUserId: null, optedOut: none, notHere: none, answered: none, alreadyInvited: none, clubNames: new Map<string, string>(), unidentified: 0 };

  it("the known people, once each, in the order tagged", () => {
    const plan = planNamedInvites({ ...base, resolved: [known(1), known(2), known(1)] });
    expect(plan.invite.map((p) => p.userId)).toEqual(["u1", "u2"]);
  });

  // Kemal, 2026-11-09: the reply names people the way their DM greets them,
  // by the WhatsApp name tagged first (Matt, stored "UTV", is "Matt Afc
  // Walcountians Vets"), then this club's name for a member; never User.name.
  it("named by the WhatsApp name tagged, else their name in THIS club when they are a member, never User.name (review #2)", () => {
    const plan = planNamedInvites({
      ...base,
      clubNames: new Map([
        ["u1", "UTV"],
        ["u4", "Bilal Hussain"],
      ]),
      resolved: [known(1, { name: "Matt Afc Walcountians Vets" }), known(2, { name: "Matt Afc" }), known(3), known(4)],
    });
    expect(plan.invite.map((p) => [p.label, p.member])).toEqual([
      ["Matt Afc Walcountians Vets", true],
      ["Matt Afc", false],
      [null, false],
      ["Bilal Hussain", true],
    ]);
  });

  it("a member tagged by phone number with no WhatsApp name: their club name, not the phone", () => {
    const plan = planNamedInvites({
      ...base,
      clubNames: new Map([["u1", "Bilal Hussain"]]),
      resolved: [known(1, { jid: "447700900001@c.us", phone: "447700900001" }), known(2, { jid: "447700900002@c.us", phone: "447700900002" })],
    });
    expect(plan.invite.map((p) => p.label)).toEqual(["Bilal Hussain", "+447700900002"]);
  });

  it("a phone is printed only for a phone-number tag, never one learned behind a LID (review #6)", () => {
    const plan = planNamedInvites({
      ...base,
      resolved: [
        { mention: { jid: "447747410069@c.us", phone: "447747410069" }, person: null },
        { mention: { jid: LID_STRANGER, phone: "447594772036" }, person: null },
        { mention: { jid: LID_BH, phone: "447000000001", name: "~BH" }, person: null },
        { mention: { jid: "x@lid".padStart(20, "7") }, person: null },
        known(4, { jid: LID_MATT, phone: "447700900004" }),
      ],
    });
    expect(plan.unknown).toEqual(["+447747410069", "~BH"]);
    expect(plan.unknownUnlabelled).toBe(2);
    expect(plan.invite[0].label).toBeNull();
  });

  it("opted out anywhere, left or removed here, already answered, already invited, the sender: never DM'd", () => {
    const plan = planNamedInvites({
      ...base,
      resolved: [known(1), known(2), known(3), known(4), known(5), known(6)],
      requesterUserId: "u6",
      optedOut: new Set(["u1"]),
      notHere: new Set(["u5"]),
      answered: new Set(["u2"]),
      alreadyInvited: new Set(["u3"]),
    });
    expect(plan.invite.map((p) => p.userId)).toEqual(["u4"]);
    expect(plan.optedOut.map((p) => p.userId)).toEqual(["u1"]);
    expect(plan.notHere.map((p) => p.userId)).toEqual(["u5"]);
    expect(plan.answered.map((p) => p.userId)).toEqual(["u2"]);
    expect(plan.alreadyInvited.map((p) => p.userId)).toEqual(["u3"]);
  });

  it(`at most ${NAMED_INVITE_CAP} DMs per request; the rest are named as left out; unidentified tags carried`, () => {
    const plan = planNamedInvites({ ...base, unidentified: 2, resolved: Array.from({ length: 12 }, (_, i) => known(i + 1)) });
    expect(NAMED_INVITE_CAP).toBe(10);
    expect(plan.invite).toHaveLength(10);
    expect(plan.overCap.map((p) => p.userId)).toEqual(["u11", "u12"]);
    expect(plan.unidentified).toBe(2);
  });
});

describe("namedInviteReply: one reply, saying what was done and what was not", () => {
  const p = (label: string | null, n: number) => ({ userId: `u${n}`, name: null, phone: `44770090000${n}`, label, member: true });
  const empty: NamedInvitePlan = { invite: [], alreadyInvited: [], answered: [], optedOut: [], notHere: [], overCap: [], unknown: [], unknownUnlabelled: 0, unidentified: 0 };

  it("the Vets case: three sent, two numbers it does not know, and whose message it was", () => {
    const text = namedInviteReply(
      {
        kind: "done",
        matchName: "Monday night vets",
        when: "Mon 9 Nov, 20:00",
        plan: { ...empty, invite: [p("Bilal Hussain", 1), p("Matt Walker", 2), p("Stuart Belcher", 3)], unknown: ["+447747410069", "+447594772036"] },
      },
      "en",
      { from: "quoted", senderName: "Shane" },
    );
    expect(text).toBe(
      "📨 From Shane's message:\n" +
        "✅ Done. I've sent the invite for *Monday night vets* (Mon 9 Nov, 20:00) to Bilal Hussain, Matt Walker and Stuart Belcher.\n" +
        "I can't message numbers I don't know yet, so I didn't message +447747410069 and +447594772036.",
    );
  });

  it("the source line: the message above with no name, and nothing for the message itself", () => {
    const done = { kind: "done" as const, matchName: "M", when: "W", plan: { ...empty, invite: [p("A", 1)] } };
    expect(namedInviteReply(done, "en", { from: "above", senderName: null }).split("\n")[0]).toBe("📨 From the message above:");
    expect(namedInviteReply(done, "en", { from: "quoted", senderName: null }).split("\n")[0]).toBe("📨 From the message you replied to:");
    expect(namedInviteReply(done, "en", { from: "message", senderName: null }).startsWith("✅")).toBe(true);
  });

  it("nothing to send to: says why, never a tick of success", () => {
    expect(namedInviteReply({ kind: "nobody-tagged" }, "en")).toBe("I couldn't see anyone tagged in that message, so I haven't messaged anyone.");
    expect(namedInviteReply({ kind: "no-match" }, "en")).toBe("There's no game coming up to invite them to, so I haven't messaged anyone.");
    expect(namedInviteReply({ kind: "full", matchName: "Monday night vets" }, "en")).toBe("*Monday night vets* has no places open, so I haven't messaged anyone.");
    expect(namedInviteReply({ kind: "failed" }, "en")).toBe("Something went wrong, so I haven't messaged anyone. Please try again in a minute.");
    const onlyUnknown = namedInviteReply({ kind: "done", matchName: "M", when: "W", plan: { ...empty, unknownUnlabelled: 2 } }, "en");
    expect(onlyUnknown).toBe("I can't message numbers I don't know yet, so I didn't message 2 people.");
  });

  it("tags the Pi could not identify are said, never silently dropped (review #1)", () => {
    expect(namedInviteReply({ kind: "done", matchName: "M", when: "W", plan: { ...empty, unidentified: 1 } }, "en")).toBe(
      "I couldn't tell who 1 of the people tagged is, so I didn't message them.",
    );
    expect(namedInviteReply({ kind: "done", matchName: "M", when: "W", plan: { ...empty, unidentified: 3 } }, "en")).toBe(
      "I couldn't tell who 3 of the people tagged are, so I didn't message them.",
    );
  });

  it("every other reason, one line each; a person with no name is counted, never shown by phone", () => {
    const text = namedInviteReply(
      {
        kind: "done",
        matchName: "M",
        when: "W",
        plan: {
          ...empty,
          invite: [p("Zed", 9), p(null, 8)],
          alreadyInvited: [p("Al", 1)],
          answered: [p("Bo", 2), p("Cy", 3)],
          optedOut: [p("Di", 4)],
          notHere: [p("Ev", 6)],
          overCap: [p("Ed", 5)],
          unknown: ["~Troy"],
          unknownUnlabelled: 1,
        },
      },
      "en",
    );
    expect(text.split("\n")).toEqual([
      "✅ Done. I've sent the invite for *M* (W) to Zed and one more person.",
      "Al already had the invite.",
      "Bo and Cy already answered for this game.",
      "Di doesn't get invites by message, so I left them out.",
      "Ev isn't in the club any more, so I left them out.",
      "I message at most 10 people at a time, so I left out Ed. Ask me again for them.",
      "I can't message numbers I don't know yet, so I didn't message ~Troy and one more person.",
    ]);
    expect(text).not.toMatch(/4477009/);
  });

  it.each(["en", "tr"] as const)("%s: no dashes, no separator slashes, never waiting list", (lang) => {
    const lines = [
      namedInviteReply({ kind: "nobody-tagged" }, lang),
      namedInviteReply({ kind: "no-match" }, lang),
      namedInviteReply({ kind: "full", matchName: "M" }, lang),
      namedInviteReply({ kind: "failed" }, lang),
      namedInviteReply(
        {
          kind: "done",
          matchName: "M",
          when: "W",
          plan: { invite: [p("A", 1)], alreadyInvited: [p("B", 2)], answered: [p("C", 3)], optedOut: [p("D", 4)], notHere: [p("F", 6)], overCap: [p("E", 5)], unknown: ["+4477"], unknownUnlabelled: 2, unidentified: 1 },
        },
        lang,
        { from: "quoted", senderName: "Shane" },
      ),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/[–—]/);
      expect(line).not.toMatch(/\//);
      expect(line.toLowerCase()).not.toMatch(/waiting list|bekleme listesi/);
    }
  });

  it("Turkish is Turkish", () => {
    expect(namedInviteReply({ kind: "nobody-tagged" }, "tr")).toBe("O mesajda etiketlenen kimseyi göremedim, kimseye yazmadım.");
    expect(namedInviteReply({ kind: "done", matchName: "M", when: "W", plan: { ...empty, invite: [p("Ali", 1), p("Can", 2)] } }, "tr", { from: "above", senderName: "Shane" })).toBe(
      "📨 Shane adlı kişinin mesajından:\n✅ Tamam. *M* (W) davetini özelden gönderdim: Ali ve Can.",
    );
  });
});
