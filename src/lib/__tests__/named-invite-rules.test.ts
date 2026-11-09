/**
 * "@Match Time DM these people" (Vets MNF, 2026-11-09): the pure rules.
 * Who was tagged (from WhatsApp's own mention data, never from the words),
 * which message's tags are meant, who of them MatchTime knows, and who is
 * DM'd, left out or named in the reply.
 */
import { describe, expect, it } from "vitest";
import {
  NAMED_INVITE_CAP,
  namedInviteReply,
  pickNamedMentions,
  planNamedInvites,
  resolveNamedMentions,
  storedMentionsOf,
  type KnownPerson,
  type StoredMention,
} from "../named-invite-rules";

const LID_BH = "158055467598020@lid";
const LID_MATT = "201112223334445@lid";
const LID_STRANGER = "309998887776665@lid";

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
    // Tagged: the unnamed JIDs are the bot's or unknowable, so only the
    // named ones (the Pi never names the bot) are kept.
    expect(
      storedMentionsOf({ botMentioned: true, mentions: ["999000111222@lid", LID_BH], mentionNames: [{ jid: LID_BH, name: "BH" }] }),
    ).toEqual([{ jid: LID_BH, name: "BH" }]);
  });

  it("total on junk, deduplicated, nothing for a message with no mentions", () => {
    expect(storedMentionsOf({})).toEqual([]);
    expect(storedMentionsOf({ mentions: "x" as unknown as string[], mentionNames: [null as never, { jid: 5 } as never] })).toEqual([]);
    expect(storedMentionsOf({ mentions: [LID_BH, LID_BH], mentionNames: [{ jid: LID_BH, name: "BH" }, { jid: LID_BH, name: "BH" }] })).toHaveLength(1);
  });
});

describe("pickNamedMentions: whose tags are meant", () => {
  const A: StoredMention[] = [{ jid: LID_BH }];
  const B: StoredMention[] = [{ jid: LID_MATT }];
  const C: StoredMention[] = [{ jid: LID_STRANGER }];

  it("the people tagged in the message itself come first", () => {
    expect(pickNamedMentions({ own: A, isReply: true, quoted: B, above: C })).toEqual({ from: "message", mentions: A });
  });

  it("a reply: the message it quotes, and only that one", () => {
    expect(pickNamedMentions({ own: [], isReply: true, quoted: B, above: C })).toEqual({ from: "quoted", mentions: B });
    // A reply to a message that tagged nobody does NOT fall back to an
    // earlier message: those could be quite different people.
    expect(pickNamedMentions({ own: [], isReply: true, quoted: [], above: C })).toBeNull();
    expect(pickNamedMentions({ own: [], isReply: true, quoted: null, above: C })).toBeNull();
  });

  it("not a reply: the latest earlier message that tagged people", () => {
    expect(pickNamedMentions({ own: [], isReply: false, quoted: null, above: C })).toEqual({ from: "above", mentions: C });
    expect(pickNamedMentions({ own: [], isReply: false, quoted: null, above: null })).toBeNull();
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
  const person = (n: number, name: string | null = `P${n}`): KnownPerson => ({ userId: `u${n}`, name, phone: `4477009000${String(n).padStart(2, "0")}` });
  const known = (n: number) => ({ mention: { jid: `${n}@lid` }, person: person(n) });
  const none = new Set<string>();

  it("the known people, once each, in the order tagged; unknowns named by phone, then by their WhatsApp name", () => {
    const plan = planNamedInvites({
      resolved: [
        known(1),
        { mention: { jid: "447747410069@c.us", phone: "447747410069" }, person: null },
        known(2),
        known(1),
        { mention: { jid: "x@lid", name: "~BH" }, person: null },
        { mention: { jid: "y@lid" }, person: null },
      ],
      requesterUserId: null,
      optedOut: none,
      answered: none,
      alreadyInvited: none,
    });
    expect(plan.invite.map((p) => p.userId)).toEqual(["u1", "u2"]);
    expect(plan.unknown).toEqual(["+447747410069", "~BH"]);
    expect(plan.unknownUnlabelled).toBe(1);
  });

  it("opted out of invites, already answered, already invited for this game, and the sender himself: never DM'd", () => {
    const plan = planNamedInvites({
      resolved: [known(1), known(2), known(3), known(4), known(5)],
      requesterUserId: "u5",
      optedOut: new Set(["u1"]),
      answered: new Set(["u2"]),
      alreadyInvited: new Set(["u3"]),
    });
    expect(plan.invite.map((p) => p.userId)).toEqual(["u4"]);
    expect(plan.optedOut.map((p) => p.userId)).toEqual(["u1"]);
    expect(plan.answered.map((p) => p.userId)).toEqual(["u2"]);
    expect(plan.alreadyInvited.map((p) => p.userId)).toEqual(["u3"]);
  });

  it(`at most ${NAMED_INVITE_CAP} DMs per request; the rest are named as left out`, () => {
    const plan = planNamedInvites({
      resolved: Array.from({ length: 12 }, (_, i) => known(i + 1)),
      requesterUserId: null,
      optedOut: none,
      answered: none,
      alreadyInvited: none,
    });
    expect(NAMED_INVITE_CAP).toBe(10);
    expect(plan.invite).toHaveLength(10);
    expect(plan.overCap.map((p) => p.userId)).toEqual(["u11", "u12"]);
  });
});

describe("namedInviteReply: one reply, saying what was done and what was not", () => {
  const p = (name: string, n: number): KnownPerson => ({ userId: `u${n}`, name, phone: `44770090000${n}` });
  const empty = { invite: [], alreadyInvited: [], answered: [], optedOut: [], unknown: [], unknownUnlabelled: 0, overCap: [] };

  it("the Vets case: three sent, two numbers it does not know", () => {
    const text = namedInviteReply(
      {
        kind: "done",
        matchName: "Monday night vets",
        when: "Mon 9 Nov, 20:00",
        plan: { ...empty, invite: [p("Bilal Hussain", 1), p("Matt Walker", 2), p("Stuart Belcher", 3)], unknown: ["+447747410069", "+447594772036"] },
      },
      "en",
    );
    expect(text).toBe(
      "✅ Done. I've sent the invite for *Monday night vets* (Mon 9 Nov, 20:00) to Bilal Hussain, Matt Walker and Stuart Belcher.\n" +
        "I can't message numbers I don't know yet, so I didn't message +447747410069 and +447594772036.",
    );
  });

  it("nothing to send to: says why, never a tick of success", () => {
    expect(namedInviteReply({ kind: "nobody-tagged" }, "en")).toBe("I couldn't see anyone tagged in that message, so I haven't messaged anyone.");
    expect(namedInviteReply({ kind: "no-match" }, "en")).toBe("There's no game coming up to invite them to, so I haven't messaged anyone.");
    expect(namedInviteReply({ kind: "full", matchName: "Monday night vets" }, "en")).toBe("*Monday night vets* has no places open, so I haven't messaged anyone.");
    const onlyUnknown = namedInviteReply({ kind: "done", matchName: "M", when: "W", plan: { ...empty, unknownUnlabelled: 2 } }, "en");
    expect(onlyUnknown).toBe("I can't message numbers I don't know yet, so I didn't message 2 people.");
    expect(onlyUnknown.startsWith("✅")).toBe(false);
  });

  it("every other reason, one line each", () => {
    const text = namedInviteReply(
      {
        kind: "done",
        matchName: "M",
        when: "W",
        plan: {
          ...empty,
          alreadyInvited: [p("Al", 1)],
          answered: [p("Bo", 2), p("Cy", 3)],
          optedOut: [p("Di", 4)],
          overCap: [p("Ed", 5)],
          unknown: ["~Troy"],
          unknownUnlabelled: 1,
        },
      },
      "en",
    );
    expect(text.split("\n")).toEqual([
      "Al already had the invite.",
      "Bo and Cy already answered for this game.",
      "Di doesn't get invites by message, so I left them out.",
      "I message at most 10 people at a time, so I left out Ed. Ask me again for them.",
      "I can't message numbers I don't know yet, so I didn't message ~Troy and one more person.",
    ]);
  });

  it.each(["en", "tr"] as const)("%s: no dashes, no separator slashes, never waiting list", (lang) => {
    const lines = [
      namedInviteReply({ kind: "nobody-tagged" }, lang),
      namedInviteReply({ kind: "no-match" }, lang),
      namedInviteReply({ kind: "full", matchName: "M" }, lang),
      namedInviteReply(
        {
          kind: "done",
          matchName: "M",
          when: "W",
          plan: { invite: [p("A", 1)], alreadyInvited: [p("B", 2)], answered: [p("C", 3)], optedOut: [p("D", 4)], overCap: [p("E", 5)], unknown: ["+4477"], unknownUnlabelled: 2 },
        },
        lang,
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
    expect(namedInviteReply({ kind: "done", matchName: "M", when: "W", plan: { ...empty, invite: [p("Ali", 1), p("Can", 2)] } }, "tr")).toBe(
      "✅ Tamam. *M* (W) davetini özelden gönderdim: Ali ve Can.",
    );
  });
});
