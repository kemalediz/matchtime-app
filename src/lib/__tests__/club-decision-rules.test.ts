/**
 * SELF-JOIN SLICE 7 ("Decisions"): the PURE rules.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 6.2, 6.4, 7
 * (cap 8) and 12.
 *
 * No database, no clock but the one passed in, NO MODEL. The owner's DM
 * is read by the one DM reader; what is checked here is its answer.
 */
import { describe, expect, it } from "vitest";
import {
  NEW_CLUB_DM_WINDOW_DAYS,
  NEW_CLUB_MEMBER_DMS_PER_DAY,
  formatDecidedAt,
  holdDmsOverAllowance,
  isApproverSender,
  newClubDmCap,
  ownerAckText,
  approverCommandFromRead,
  resolveApproverTarget,
  suspendRefusal,
  type DecidedClub,
  type WaitingClub,
} from "../club-decision-rules";

const NOW = new Date("2026-09-29T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

describe("approverCommandFromRead: the reader's answer, checked against what the owner wrote", () => {
  const read = (intent: string, clubRef = "") => ({ intent, confidence: 0.95, clubRef });

  it("approve or reject, as the reader said, with a ref that is in his message", () => {
    expect(approverCommandFromRead(read("approve_club", "7KQ2"), ["approve 7kq2"])).toEqual({ verb: "approve", ref: "7KQ2" });
    expect(approverCommandFromRead(read("reject_club", "9xt4"), ["reddet 9XT4."])).toEqual({ verb: "reject", ref: "9XT4" });
    expect(approverCommandFromRead(read("approve_club", "7KQ2"), ["yes that one", "New club: Riverside FC, ref 7KQ2"])).toEqual({ verb: "approve", ref: "7KQ2" });
  });

  it("no ref named: a bare verb", () => {
    expect(approverCommandFromRead(read("approve_club"), ["approve"])).toEqual({ verb: "approve", ref: null });
    expect(approverCommandFromRead(read("reject_club", "  "), ["reject that one"])).toEqual({ verb: "reject", ref: null });
  });

  it("a ref the model gave that is not in his words, or only inside a longer word, is flagged, never trusted", () => {
    expect(approverCommandFromRead(read("approve_club", "7KQ2"), ["approve the riverside one"])).toEqual({ verb: "approve", ref: null, unverifiedRef: "7KQ2" });
    expect(approverCommandFromRead(read("approve_club", "KQ2"), ["approve 7KQ2"])).toEqual({ verb: "approve", ref: null, unverifiedRef: "KQ2" });
  });

  it("anything the reader did not call an approve or a reject is no command", () => {
    for (const intent of ["other", "question", "go_live", "intro_messages", "connect_club"]) {
      expect(approverCommandFromRead(read(intent, "7KQ2"), ["approve 7KQ2"]), intent).toBeNull();
    }
  });
});

describe("ownerAckText: a ref the owner did not write", () => {
  it("asks which club, with an example and the waiting list", () => {
    expect(ownerAckText({ kind: "ref-needed", waiting: [{ orgId: "o1", code: "7KQ2", club: "Riverside FC" }] })).toBe(
      "Which club? Reply with its ref, for example APPROVE 7KQ2. Waiting now: 7KQ2 Riverside FC.",
    );
    expect(ownerAckText({ kind: "ref-needed", waiting: [] })).toBe("Which club? Reply with its ref. Nothing is waiting right now.");
  });
});

describe("isApproverSender: exact match against SELF_JOIN_APPROVER_PHONES, off the envelope", () => {
  const approvers = ["447700900444"];

  it("matches the forwarded phone in any common spelling", () => {
    expect(isApproverSender({ phone: "447700900444" }, approvers)).toBe(true);
    expect(isApproverSender({ phone: "+44 7700 900444" }, approvers)).toBe(true);
  });

  it("matches the envelope's alt phone when the chat id was a LID", () => {
    expect(isApproverSender({ phone: null, senderAltPhone: "447700900444" }, approvers)).toBe(true);
  });

  it("refuses everybody else, a LID-only sender, and anybody when no approver is set", () => {
    expect(isApproverSender({ phone: "447700900445" }, approvers)).toBe(false);
    expect(isApproverSender({ phone: "4477009004" }, approvers)).toBe(false);
    expect(isApproverSender({ phone: "4477009004444" }, approvers)).toBe(false);
    expect(isApproverSender({ phone: null, senderAltPhone: null }, approvers)).toBe(false);
    expect(isApproverSender({ phone: "158055467598020" }, [])).toBe(false);
    expect(isApproverSender({ phone: "447700900444" }, [])).toBe(false);
  });
});

describe("resolveApproverTarget", () => {
  const riverside: WaitingClub = { orgId: "o1", code: "7KQ2", club: "Riverside FC" };
  const hackney: WaitingClub = { orgId: "o2", code: "9XT4", club: "Hackney Weds" };
  const decided: DecidedClub = {
    code: "3MNP",
    club: "Old Boys",
    status: "approved",
    decidedAt: new Date("2026-09-28T18:04:00Z"),
  };

  it("a ref that is waiting is the target", () => {
    expect(resolveApproverTarget({ verb: "approve", ref: "7KQ2" }, [riverside, hackney], [])).toEqual({
      kind: "decide",
      target: riverside,
    });
  });

  it("a bare command is accepted only when exactly one club is waiting", () => {
    expect(resolveApproverTarget({ verb: "reject", ref: null }, [hackney], [])).toEqual({
      kind: "decide",
      target: hackney,
    });
    expect(resolveApproverTarget({ verb: "approve", ref: null }, [riverside, hackney], [])).toEqual({
      kind: "ambiguous",
      waiting: [riverside, hackney],
    });
    expect(resolveApproverTarget({ verb: "approve", ref: null }, [], [])).toEqual({ kind: "none-waiting" });
  });

  it("a ref already decided says so; an unknown ref lists what is waiting", () => {
    expect(resolveApproverTarget({ verb: "approve", ref: "3MNP" }, [hackney], [decided])).toEqual({
      kind: "already",
      decided,
    });
    expect(resolveApproverTarget({ verb: "approve", ref: "ZZZZ" }, [hackney], [decided])).toEqual({
      kind: "unknown-ref",
      ref: "ZZZZ",
      waiting: [hackney],
    });
  });
});

describe("ownerAckText (English only: owner-facing, plan 6.2)", () => {
  const riverside: WaitingClub = { orgId: "o1", code: "7KQ2", club: "Riverside FC" };
  const hackney: WaitingClub = { orgId: "o2", code: "9XT4", club: "Hackney Weds" };

  it("go-live S3: a held approval says only what is true whatever happens next (PR #235 review fix 2c)", () => {
    const text = ownerAckText({ kind: "approved", club: "Riverside FC", held: true });
    expect(text).toBe(
      "Approved Riverside FC. It stays silent in its group: its organiser is sent the setup message and goes live by replying GO. Any problem shows on the health page.",
    );
    expect(text).not.toMatch(/hello goes out/);
    // Nothing is known yet about whether the organiser can be reached: no "is being asked", no "has been asked".
    expect(text).not.toMatch(/being asked|been asked/);
    expect(text).toMatch(/health page/);
    expect(ownerAckText({ kind: "approved", club: "Riverside FC", held: false })).toBe(
      "Approved Riverside FC. The hello goes out in the group within a few minutes.",
    );
  });

  it("says what happened, in the plan's words", () => {
    expect(ownerAckText({ kind: "approved", club: "Riverside FC" })).toBe(
      "Approved Riverside FC. The hello goes out in the group within a few minutes.",
    );
    expect(ownerAckText({ kind: "rejected", club: "Riverside FC" })).toBe(
      "Rejected Riverside FC. Leaving the group now.",
    );
    expect(ownerAckText({ kind: "ambiguous", waiting: [riverside, hackney] })).toBe(
      "Two clubs are waiting: 7KQ2 Riverside FC, 9XT4 Hackney Weds. Reply APPROVE and the ref.",
    );
    expect(ownerAckText({ kind: "unknown-ref", ref: "7KQ2", waiting: [hackney] })).toBe(
      "No club waiting with ref 7KQ2. Waiting now: 9XT4 Hackney Weds.",
    );
    expect(ownerAckText({ kind: "unknown-ref", ref: "7KQ2", waiting: [] })).toBe(
      "No club waiting with ref 7KQ2. Nothing else is waiting.",
    );
    expect(ownerAckText({ kind: "none-waiting" })).toBe("No clubs are waiting right now.");
    expect(
      ownerAckText({
        kind: "already",
        decided: { code: "7KQ2", club: "Riverside FC", status: "approved", decidedAt: new Date("2026-09-28T18:04:00Z") },
      }),
    ).toBe("Riverside FC was already approved on 28 Sept at 19:04.");
    expect(ownerAckText({ kind: "group-taken", club: "Riverside FC", takenBy: "Sutton FC" })).toBe(
      "Can't approve Riverside FC: its group already belongs to Sutton FC. Nothing changed. See matchtime.ai/admin/clubs.",
    );
  });

  it("counts past two in words the owner can read", () => {
    const three = [riverside, hackney, { orgId: "o3", code: "4ABC", club: "Kartallar" }];
    expect(ownerAckText({ kind: "ambiguous", waiting: three })).toMatch(/^3 clubs are waiting: /);
  });

  it("never uses an em or en dash", () => {
    const all = [
      ownerAckText({ kind: "approved", club: "X" }),
      ownerAckText({ kind: "rejected", club: "X" }),
      ownerAckText({ kind: "ambiguous", waiting: [riverside, hackney] }),
      ownerAckText({ kind: "unknown-ref", ref: "X", waiting: [] }),
      ownerAckText({ kind: "none-waiting" }),
      ownerAckText({ kind: "group-taken", club: "X", takenBy: "Y" }),
    ];
    for (const s of all) expect(s).not.toMatch(/[—–]/);
  });
});

describe("formatDecidedAt: London wall clock, 'Sept'", () => {
  it("formats in London time", () => {
    expect(formatDecidedAt(new Date("2026-09-28T18:04:00Z"))).toBe("28 Sept at 19:04");
    expect(formatDecidedAt(new Date("2026-01-05T09:30:00Z"))).toBe("5 Jan at 09:30");
  });
});

describe("cap 8: DMs to members from a new self-join club (plan section 7)", () => {
  it("is 20 a day for the first 28 days after approval", () => {
    expect(NEW_CLUB_MEMBER_DMS_PER_DAY).toBe(20);
    expect(NEW_CLUB_DM_WINDOW_DAYS).toBe(28);
    expect(newClubDmCap({ approvedAt: days(-1) }, NOW)).toBe(20);
    expect(newClubDmCap({ approvedAt: days(-27.9) }, NOW)).toBe(20);
  });

  it("does not apply after 28 days, nor ever to a club approved before self-join (Sutton FC)", () => {
    expect(newClubDmCap({ approvedAt: days(-28) }, NOW)).toBeNull();
    expect(newClubDmCap({ approvedAt: null }, NOW)).toBeNull();
  });

  it("holds DMs beyond what is left today, in order, and never a group post", () => {
    const list = [
      { kind: "group-message", key: "g1" },
      { kind: "dm", key: "d1" },
      { kind: "dm", key: "d2" },
      { kind: "group-poll", key: "p1" },
      { kind: "dm", key: "d3" },
    ];
    const r = holdDmsOverAllowance(list, 1);
    expect(r.keep.map((i) => i.key)).toEqual(["g1", "d1", "p1"]);
    expect(r.held.map((i) => i.key)).toEqual(["d2", "d3"]);
    expect(holdDmsOverAllowance(list, 0).keep.map((i) => i.key)).toEqual(["g1", "p1"]);
    expect(holdDmsOverAllowance(list, -3).held).toHaveLength(3);
    expect(holdDmsOverAllowance(list, 10).held).toEqual([]);
  });
});

describe("suspendRefusal: the off switch cannot reach a club that predates self-join", () => {
  const selfJoin = { approvalStatus: "approved", approvedAt: days(-3), name: "Riverside FC" };
  const sutton = { approvalStatus: "approved", approvedAt: null, name: "Sutton FC" };

  it("allows an approved self-join club when the typed name matches, ignoring case and spaces", () => {
    expect(suspendRefusal(selfJoin, "Riverside FC")).toBeNull();
    expect(suspendRefusal(selfJoin, "  riverside fc ")).toBeNull();
  });

  it("refuses without the typed name, or with the wrong one", () => {
    expect(suspendRefusal(selfJoin, "")).toBe("confirm-mismatch");
    expect(suspendRefusal(selfJoin, undefined)).toBe("confirm-mismatch");
    expect(suspendRefusal(selfJoin, "Riverside")).toBe("confirm-mismatch");
  });

  it("refuses Sutton FC's shape (approved, never through self-join) EVEN with its name typed", () => {
    expect(suspendRefusal(sutton, "Sutton FC")).toBe("not-self-join");
  });

  it("refuses a club that is not approved", () => {
    for (const s of ["draft", "pending", "rejected", "suspended"]) {
      expect(suspendRefusal({ ...selfJoin, approvalStatus: s }, "Riverside FC")).toBe("not-approved");
    }
  });
});
