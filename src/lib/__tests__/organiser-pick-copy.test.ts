/**
 * Slice 2b review fix (2026-10-01): in an organiser-pick club no post may
 * promise that the first to say IN takes a place. Every sentence that
 * promises the bench mechanics gets the organiser wording there; a
 * first-come club (Sutton FC) keeps today's bytes, pinned here against the
 * builders' default and by the golden snapshot.
 */
import { describe, expect, it } from "vitest";
import { buildBenchIntroLine, buildFullSquadBenchInvite, buildSquadCompleteBenchInvite } from "../bench-offer-copy";
import { buildRecruitInviteDm } from "../recruit";
import { buildRecruitChaseText } from "../recruit-chase";
import { buildSelfAttendanceAck } from "../out-of-band-self-attendance";

const FIRST_COME_PROMISE = /first to (reply|react|say|claim)|takes the slot|ilk \*?VARIM|yeri alır|squad's full|kadro dolu/i;

describe("organiser-pick clubs never promise first come", () => {
  it("the squad-complete invite", () => {
    expect(buildSquadCompleteBenchInvite({ organiser: true })).toBe(
      "🪑 *Waiting list is open.* Say *IN* to go on the waiting list, and the organisers will pick who plays.",
    );
    expect(buildSquadCompleteBenchInvite({ organiser: true, lang: "tr" })).toBe(
      "🪑 *Yedek listesi açık.* *VARIM* yazın, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer.",
    );
  });

  it("the day-one intro's bench line", () => {
    expect(buildBenchIntroLine({ organiser: true })).toBe(
      "🔁  *Waiting list:* say *IN* to go on the waiting list. When a place opens, the organisers pick who plays.",
    );
    expect(buildBenchIntroLine({ organiser: true, lang: "tr" })).not.toMatch(FIRST_COME_PROMISE);
  });

  it("the full-squad answer to a recruit ask", () => {
    const c = { matchName: "Friday 9-a-side", confirmedCount: 18, maxPlayers: 18, organiser: true };
    expect(buildFullSquadBenchInvite(c)).toBe(
      "*Friday 9-a-side* is full at 18 of 18, but the waiting list is open. Say *IN* to go on the waiting list, and the organisers will pick who plays. 🙏",
    );
    expect(buildFullSquadBenchInvite({ ...c, lang: "tr" })).not.toMatch(FIRST_COME_PROMISE);
  });

  it("the recruit invite and chase DMs", () => {
    const invite = { firstName: "Ali", matchName: "Friday 9-a-side", matchWhen: "Fri 9 Oct, 20:30", spotsLeft: 2, link: null, organiser: true };
    expect(buildRecruitInviteDm(invite)).toBe(
      [
        "👋 Ali, we're putting the squad together for *Friday 9-a-side* on Fri 9 Oct, 20:30. 2 spots left.",
        "",
        "Want to play? Reply *IN* to go on the waiting list, and the organisers will pick who plays.",
        "Can't make it? Reply *OUT* and I'll stop asking 🙌",
      ].join("\n"),
    );
    expect(buildRecruitInviteDm({ ...invite, lang: "tr" })).toContain("organizatörler seçer");
    const chase = { playerName: "Ali Aziz", activityName: "Friday 9-a-side", matchWhen: "Fri 9 Oct, 20:30", need: 1, organiser: true };
    expect(buildRecruitChaseText(chase)).toBe(
      "👋 Ali, still after 1 player for *Friday 9-a-side* on Fri 9 Oct, 20:30. Reply *IN* to go on the waiting list and the organisers will pick who plays, or *OUT* and I'll stop asking 🙏",
    );
    expect(buildRecruitChaseText({ ...chase, lang: "tr" })).toContain("organizatörler seçer");
  });

  it("the private ack of an IN that went on the waiting list", () => {
    const ack = { failed: false, status: "BENCH" as const, matchName: "Friday 9-a-side", matchWhen: "Fri 9 Oct, 20:30", organiser: true };
    expect(buildSelfAttendanceAck(ack)).toBe(
      "📋 I've put you on the waiting list for *Friday 9-a-side* on Fri 9 Oct, 20:30. The organisers pick who plays, and I'll message you if you're picked 🙏",
    );
    expect(buildSelfAttendanceAck({ ...ack, lang: "tr" })).not.toMatch(FIRST_COME_PROMISE);
  });
});

describe("first-come clubs (Sutton FC) keep today's words", () => {
  it("organiser: false is the default, byte for byte", () => {
    expect(buildSquadCompleteBenchInvite({ organiser: false })).toBe(buildSquadCompleteBenchInvite());
    expect(buildBenchIntroLine({ organiser: false, lang: "tr" })).toBe(buildBenchIntroLine({ lang: "tr" }));
    const c = { matchName: "Tue 7-a-side", confirmedCount: 14, maxPlayers: 14 };
    expect(buildFullSquadBenchInvite({ ...c, organiser: false })).toBe(buildFullSquadBenchInvite(c));
    const invite = { firstName: "Ali", matchName: "X", matchWhen: "Tue", spotsLeft: 1, link: null };
    expect(buildRecruitInviteDm({ ...invite, organiser: false })).toBe(buildRecruitInviteDm(invite));
    const chase = { playerName: "Ali", activityName: "X", matchWhen: "Tue", need: 1 };
    expect(buildRecruitChaseText({ ...chase, organiser: false })).toBe(buildRecruitChaseText(chase));
    const ack = { failed: false, status: "BENCH" as const, matchName: "X", matchWhen: "Tue" };
    expect(buildSelfAttendanceAck({ ...ack, organiser: false })).toBe(buildSelfAttendanceAck(ack));
    expect(buildSquadCompleteBenchInvite()).toMatch(/takes the slot/);
  });
});
