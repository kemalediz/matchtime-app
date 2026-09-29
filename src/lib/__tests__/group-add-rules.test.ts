/**
 * SELF-JOIN SLICE 6: the PURE rules of a group add (plan sections 2.3,
 * 5.5, 5.6 and 6.1). No database, no clock, no model.
 */
import { describe, expect, it } from "vitest";
import {
  UNSOLICITED_AUTO_LEAVE_MS,
  addEvidenceFrom,
  adderLine,
  decideGroupAddLink,
  ownerApprovalDmText,
  type LinkCandidate,
} from "../group-add-rules";

const NOW = new Date("2026-09-29T12:00:00Z");
const mins = (m: number) => new Date(NOW.getTime() + m * 60_000);

const ALI = "447700900123";
const ALI_LID = "158055467598961";
const AYSE = "905321234567";
const STRANGER = "447700900999";

function cand(over: Partial<LinkCandidate> = {}): LinkCandidate {
  return {
    id: "cc-ali",
    status: "dm_verified",
    phone: ALI,
    dmLid: ALI_LID,
    issuedAt: mins(-30),
    expiresAt: mins(30),
    addWindowEndsAt: mins(24 * 60 - 20),
    ...over,
  };
}

const ev = (over: Partial<ReturnType<typeof addEvidenceFrom>> = {}) => ({
  addedByPhone: null as string | null,
  addedByLid: null as string | null,
  participants: [] as Array<{ phone: string | null; lid: string | null }>,
  discovered: false,
  ...over,
});

describe("addEvidenceFrom: what the Pi posted, normalised", () => {
  it("reads phones as digits and LIDs as bare digits, whatever the spelling", () => {
    const e = addEvidenceFrom({
      addedByPhone: "+44 7700 900123",
      addedByLid: `${ALI_LID}@lid`,
      participants: [
        { phone: "447700900123", pushname: "Ali" },
        { lidId: `${ALI_LID}:3@lid` },
        { phone: "not a phone" },
        null,
      ],
      discovered: true,
    });
    expect(e).toEqual({
      addedByPhone: ALI,
      addedByLid: ALI_LID,
      participants: [
        { phone: ALI, lid: null },
        { phone: null, lid: ALI_LID },
      ],
      discovered: true,
    });
  });

  it("an older Pi sends no LID and no discovered flag: both default off", () => {
    const e = addEvidenceFrom({ addedByPhone: ALI });
    expect(e.addedByLid).toBeNull();
    expect(e.discovered).toBe(false);
    expect(e.participants).toEqual([]);
  });

  it("an author LID sent in the phone field is never read as a phone", () => {
    expect(addEvidenceFrom({ addedByPhone: `${ALI_LID}@lid` }).addedByPhone).toBeNull();
  });
});

describe("decideGroupAddLink: which connect request an add belongs to (plan 2.3)", () => {
  it("matched by phone: the adder is the organiser's sign-up phone", () => {
    const d = decideGroupAddLink(ev({ addedByPhone: ALI }), [cand()], NOW);
    expect(d).toEqual({ link: true, connectId: "cc-ali", adderMatch: "phone", organiserPresent: true });
  });

  it("matched by phone on an ISSUED request: the organiser skipped the DM (plan 4.2)", () => {
    const d = decideGroupAddLink(
      ev({ addedByPhone: ALI }),
      [cand({ status: "issued", dmLid: null, addWindowEndsAt: null })],
      NOW,
    );
    expect(d).toMatchObject({ link: true, adderMatch: "phone" });
  });

  it("matched by LID: the adder's LID is the one the connect DM came from", () => {
    const d = decideGroupAddLink(ev({ addedByLid: ALI_LID }), [cand()], NOW);
    expect(d).toMatchObject({ link: true, connectId: "cc-ali", adderMatch: "lid" });
  });

  it("phone wins over LID when both are known", () => {
    const d = decideGroupAddLink(ev({ addedByPhone: ALI, addedByLid: ALI_LID }), [cand()], NOW);
    expect(d).toMatchObject({ adderMatch: "phone" });
  });

  it("someone else added it and the organiser IS in the group: linked, labelled", () => {
    const d = decideGroupAddLink(
      ev({ addedByPhone: STRANGER, participants: [{ phone: ALI, lid: null }, { phone: STRANGER, lid: null }] }),
      [cand()],
      NOW,
    );
    expect(d).toEqual({ link: true, connectId: "cc-ali", adderMatch: "other-organiser-present", organiserPresent: true });
  });

  it("the organiser is found in the group by the connect DM's LID too", () => {
    const d = decideGroupAddLink(
      ev({ addedByPhone: STRANGER, participants: [{ phone: null, lid: ALI_LID }] }),
      [cand()],
      NOW,
    );
    expect(d).toMatchObject({ link: true, adderMatch: "other-organiser-present" });
  });

  it("adder unknown, exactly one DM-verified organiser in the group: linked as unknown", () => {
    const d = decideGroupAddLink(ev({ participants: [{ phone: ALI, lid: null }] }), [cand()], NOW);
    expect(d).toEqual({ link: true, connectId: "cc-ali", adderMatch: "unknown", organiserPresent: true });
  });

  it("a LID nobody can map, that is not the DM's LID, is an unknown adder", () => {
    const d = decideGroupAddLink(
      ev({ addedByLid: "999999999999", participants: [{ phone: ALI, lid: null }] }),
      [cand()],
      NOW,
    );
    expect(d).toMatchObject({ link: true, adderMatch: "unknown" });
  });

  it("organiser NOT in the group and the adder is not them: unsolicited, never a guess", () => {
    const d = decideGroupAddLink(
      ev({ addedByPhone: STRANGER, participants: [{ phone: STRANGER, lid: null }] }),
      [cand()],
      NOW,
    );
    expect(d).toEqual({ link: false, reason: "no-match" });
  });

  it("two DM-verified organisers in the same group: ambiguous, unsolicited", () => {
    const d = decideGroupAddLink(
      ev({ participants: [{ phone: ALI, lid: null }, { phone: AYSE, lid: null }] }),
      [cand(), cand({ id: "cc-ayse", phone: AYSE, dmLid: null })],
      NOW,
    );
    expect(d).toEqual({ link: false, reason: "ambiguous" });
  });

  it("an organiser present on an ISSUED request (no DM yet) does not count for an unknown adder", () => {
    const d = decideGroupAddLink(
      ev({ participants: [{ phone: ALI, lid: null }] }),
      [cand({ status: "issued", dmLid: null, addWindowEndsAt: null })],
      NOW,
    );
    expect(d).toEqual({ link: false, reason: "no-match" });
  });

  it("an expired code or a closed add window matches nothing, even by phone", () => {
    expect(
      decideGroupAddLink(ev({ addedByPhone: ALI }), [cand({ status: "issued", expiresAt: mins(-1), addWindowEndsAt: null })], NOW),
    ).toEqual({ link: false, reason: "no-match" });
    expect(decideGroupAddLink(ev({ addedByPhone: ALI }), [cand({ addWindowEndsAt: mins(-1) })], NOW)).toEqual({
      link: false,
      reason: "no-match",
    });
  });

  it("group_linked, closed, superseded requests are never candidates", () => {
    for (const status of ["group_linked", "closed", "superseded", "expired"]) {
      expect(decideGroupAddLink(ev({ addedByPhone: ALI }), [cand({ status })], NOW)).toEqual({
        link: false,
        reason: "no-match",
      });
    }
  });

  it("no requests at all: unsolicited", () => {
    expect(decideGroupAddLink(ev({ addedByPhone: ALI }), [], NOW)).toEqual({ link: false, reason: "no-match" });
  });

  it("the same organiser with two live requests (a superadmin): the newest wins", () => {
    const d = decideGroupAddLink(
      ev({ addedByPhone: ALI }),
      [cand({ id: "old", issuedAt: mins(-50) }), cand({ id: "new", issuedAt: mins(-5) })],
      NOW,
    );
    expect(d).toMatchObject({ connectId: "new" });
  });

  it("a DISCOVERED group (the reconnect sweep) links only on an organiser seen in the group", () => {
    expect(decideGroupAddLink(ev({ discovered: true, participants: [{ phone: ALI, lid: null }] }), [cand()], NOW)).toMatchObject({
      link: true,
      adderMatch: "unknown",
    });
    expect(decideGroupAddLink(ev({ discovered: true, participants: [] }), [cand()], NOW)).toEqual({
      link: false,
      reason: "no-match",
    });
  });
});

describe("the owner's approval DM (plan 6.1), English only", () => {
  const base = {
    club: "Riverside FC",
    code: "7KQ2",
    organiserName: "Ali Demir",
    organiserPhone: ALI,
    adderMatch: "phone" as const,
    organiserPresent: true,
    numberUnconfirmed: false,
    groupSubject: "Riverside Tuesday 5s",
    memberCount: 18,
    detectedLang: { lang: "tr" as const, confident: true },
    clubLang: "tr",
    alsoIn: [{ orgName: "Sutton FC", count: 3 }],
  };

  it("reads exactly as the plan's example", () => {
    expect(ownerApprovalDmText(base)).toBe(
      [
        "New club waiting: *Riverside FC* (ref 7KQ2)",
        "Organiser: Ali Demir, +44 7700 900123 (phone verified at sign-up)",
        "Added by: the organiser (matched by phone)",
        'Group: "Riverside Tuesday 5s", 18 members, looks Turkish (club chose Türkçe)',
        "Also in your other clubs: 3 members play at Sutton FC",
        "Reply APPROVE 7KQ2 or REJECT 7KQ2, or use matchtime.ai/admin/clubs",
      ].join("\n"),
    );
  });

  it("no overlap with other clubs: the line is left out; one member reads singular", () => {
    expect(ownerApprovalDmText({ ...base, alsoIn: [] })).not.toContain("Also in your other clubs");
    expect(ownerApprovalDmText({ ...base, alsoIn: [{ orgName: "Sutton FC", count: 1 }, { orgName: "Hackney Weds", count: 2 }] })).toContain(
      "Also in your other clubs: 1 member plays at Sutton FC; 2 members play at Hackney Weds",
    );
  });

  it("an unreadable group: no name, no member list, language unclear", () => {
    const text = ownerApprovalDmText({
      ...base,
      groupSubject: null,
      memberCount: 0,
      detectedLang: { lang: "en", confident: false },
      clubLang: "en",
      organiserName: null,
    });
    expect(text).toContain("Organiser: (no name), +44 7700 900123 (phone verified at sign-up)");
    expect(text).toContain("Group: (no name), member list not read, language unclear (club chose English)");
  });

  it("never uses an em dash or an en dash", () => {
    expect(ownerApprovalDmText(base)).not.toMatch(/[\u2013\u2014]/);
  });

  it("the Added by line names which rule applied, every case", () => {
    expect(adderLine("phone", true, false)).toBe("Added by: the organiser (matched by phone)");
    expect(adderLine("lid", true, false)).toBe("Added by: the organiser (matched by WhatsApp id)");
    expect(adderLine("other-organiser-present", true, false)).toBe("Added by: someone else; the organiser IS in the group");
    expect(adderLine("unknown", true, false)).toBe("Added by: unknown; the organiser IS in the group");
    expect(adderLine("unknown", false, false)).toBe("Added by: unknown; the organiser IS NOT in the group");
    expect(adderLine("mismatch", false, false)).toBe("Added by: someone else; the organiser is NOT in the group");
    expect(adderLine("lid", true, true)).toBe(
      "Added by: the organiser (matched by WhatsApp id) (organiser's WhatsApp number not confirmed)",
    );
  });
});

describe("unsolicited groups", () => {
  it("are left after 48 hours (decision 3)", () => {
    expect(UNSOLICITED_AUTO_LEAVE_MS).toBe(48 * 60 * 60 * 1000);
  });
});
