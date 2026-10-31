/**
 * Slice 2b, the pure half of organiser pick (plan 2.7 to 2.11): when a
 * round opens, when nobody has picked in time, and the pick message. No
 * database, no model. What an admin's reply means is read by the pick
 * reader (organiser-pick-reader.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  PICK_LATE_REPLY_MS,
  buildPickListChanged,
  buildPickFallbackOffered,
  buildPickMessage,
  decidePickRound,
  fallbackOfferCount,
  pickFallbackAt,
  positionLabel,
} from "../organiser-pick-rules";
import { LATE_MESSAGE_AFTER_MS } from "../late-message";

const H = 3600_000;

describe("fallbackOfferCount (D5, 2026-10-06)", () => {
  it("one offer per free place when enough people are waiting", () => {
    expect(fallbackOfferCount(1, 5)).toBe(1);
    expect(fallbackOfferCount(3, 3)).toBe(3);
  });
  it("never more offers than people waiting: sixteen places and two waiting is two", () => {
    expect(fallbackOfferCount(16, 2)).toBe(2);
  });
  it("nothing to offer, or nobody to offer it to", () => {
    expect(fallbackOfferCount(0, 4)).toBe(0);
    expect(fallbackOfferCount(4, 0)).toBe(0);
    expect(fallbackOfferCount(-1, 4)).toBe(0);
  });
});

describe("buildPickFallbackOffered (P11, 2026-10-06)", () => {
  const base = { lang: "en", activityName: "Friday 9-a-side" };
  it("one place, one offer: the sentence it has always been", () => {
    expect(buildPickFallbackOffered({ ...base, offered: 1, openPlaces: 1 })).toBe(
      "Nobody picked for *Friday 9-a-side*, so I've offered the place to the bench: the first to say IN gets it.",
    );
  });
  it("every open place offered", () => {
    expect(buildPickFallbackOffered({ ...base, offered: 3, openPlaces: 3 })).toBe(
      "Nobody picked for *Friday 9-a-side*, so I've offered the 3 open places to the bench: whoever says IN gets one.",
    );
  });
  it("CAPPED: sixteen places and two waiting says two were offered and fourteen are still open", () => {
    expect(buildPickFallbackOffered({ ...base, offered: 2, openPlaces: 16 })).toBe(
      "Nobody picked for *Friday 9-a-side*, so I've offered 2 places to the bench, one for each person waiting: " +
        "whoever says IN gets one. 14 more places are still open.",
    );
  });
  it("capped to one offer, one place left over", () => {
    expect(buildPickFallbackOffered({ ...base, offered: 1, openPlaces: 2 })).toBe(
      "Nobody picked for *Friday 9-a-side*, so I've offered 1 place to the bench, one for each person waiting: " +
        "whoever says IN gets one. 1 more place is still open.",
    );
  });
  it("in Turkish", () => {
    expect(buildPickFallbackOffered({ ...base, lang: "tr", offered: 3, openPlaces: 3 })).toBe(
      "*Friday 9-a-side* için kimse seçim yapmadı, bu yüzden 3 boş yeri yedek listesine açtım: VARIM diyen bir yer alır.",
    );
    expect(buildPickFallbackOffered({ ...base, lang: "tr", offered: 2, openPlaces: 16 })).toBe(
      "*Friday 9-a-side* için kimse seçim yapmadı, bu yüzden yedek listesine 2 yer açtım (bekleyen her kişiye bir yer): " +
        "VARIM diyen bir yer alır. 14 yer daha boş.",
    );
  });
});

describe("pickFallbackAt (D5)", () => {
  const kickoff = new Date("2026-10-09T19:30:00Z"); // Friday 20:30 London
  it("a day after the round opened, when that is earlier than kickoff minus 4h", () => {
    const opened = new Date("2026-10-05T20:05:00Z"); // Monday
    expect(pickFallbackAt(opened, kickoff).toISOString()).toBe("2026-10-06T20:05:00.000Z");
  });
  it("kickoff minus 4h when that comes first", () => {
    const opened = new Date("2026-10-09T08:00:00Z");
    expect(pickFallbackAt(opened, kickoff).toISOString()).toBe("2026-10-09T15:30:00.000Z");
  });
  it("a drop 3 hours before kickoff: never sooner than 1 hour after the round opened", () => {
    const opened = new Date("2026-10-09T16:30:00Z");
    expect(pickFallbackAt(opened, kickoff).toISOString()).toBe("2026-10-09T17:30:00.000Z");
  });
  it("a superseding round keeps the earlier fallback, floored the same way", () => {
    const opened = new Date("2026-10-06T10:00:00Z");
    const carried = new Date("2026-10-06T20:05:00Z");
    expect(pickFallbackAt(opened, kickoff, carried).toISOString()).toBe(carried.toISOString());
    expect(pickFallbackAt(new Date("2026-10-06T19:50:00Z"), kickoff, carried).toISOString()).toBe("2026-10-06T20:50:00.000Z");
  });
});

describe("decidePickRound", () => {
  const base = {
    now: new Date("2026-10-07T11:00:00Z"), // Wednesday 12:00 London
    kickoff: new Date("2026-10-09T19:30:00Z"),
    openPlaces: 1,
    waitingUserIds: ["u-kemal", "u-wasim"],
    dropOutDeadline: null,
    openOffers: 0,
    openRound: null,
    lastClosedRound: null,
    dropsSince: 1,
    confirmed: 17,
    pastePending: false,
  };
  it("opens with a free place and a waiting list", () => {
    expect(decidePickRound(base)).toEqual({ action: "open" });
  });
  it("waits with no place, or nobody waiting", () => {
    expect(decidePickRound({ ...base, openPlaces: 0 }).action).toBe("wait");
    expect(decidePickRound({ ...base, waitingUserIds: [] }).action).toBe("wait");
  });
  it("waits before the club's drop-out deadline, and opens after it", () => {
    const deadline = new Date("2026-10-07T20:00:00Z");
    expect(decidePickRound({ ...base, dropOutDeadline: deadline }).action).toBe("wait");
    expect(decidePickRound({ ...base, dropOutDeadline: new Date("2026-10-05T20:00:00Z") }).action).toBe("open");
  });
  it("waits overnight (a drop at 23:00 waits for 09:00)", () => {
    expect(decidePickRound({ ...base, now: new Date("2026-10-07T21:59:00Z") }).action).toBe("open"); // 22:59 BST
    expect(decidePickRound({ ...base, now: new Date("2026-10-07T22:00:00Z") }).action).toBe("wait"); // 23:00 BST
    expect(decidePickRound({ ...base, now: new Date("2026-10-08T07:00:00Z") }).action).toBe("wait"); // 08:00 BST
    expect(decidePickRound({ ...base, now: new Date("2026-10-08T07:59:00Z") }).action).toBe("wait"); // 08:59 BST
    expect(decidePickRound({ ...base, now: new Date("2026-10-08T08:00:00Z") }).action).toBe("open"); // 09:00 BST
  });
  it("waits while the fallback offer is running, and after kickoff", () => {
    expect(decidePickRound({ ...base, openOffers: 1 }).action).toBe("wait");
    expect(decidePickRound({ ...base, now: base.kickoff }).action).toBe("wait");
  });
  it("supersedes a stale open round only once its message is an hour old", () => {
    const openRound = { createdAt: new Date(base.now.getTime() - 30 * 60_000), listUserIds: ["u-kemal"], openPlaces: 1 };
    expect(decidePickRound({ ...base, openRound }).action).toBe("wait");
    expect(decidePickRound({ ...base, openRound: { ...openRound, createdAt: new Date(base.now.getTime() - H) } }).action).toBe(
      "supersede",
    );
  });
  it("leaves a current open round alone", () => {
    const openRound = { createdAt: new Date(base.now.getTime() - 5 * H), listUserIds: base.waitingUserIds, openPlaces: 1 };
    expect(decidePickRound({ ...base, openRound, dropsSince: 0 }).action).toBe("wait");
  });
  it("after NONE or a fallback, a new round only when something changed", () => {
    const closed = { createdAt: new Date(base.now.getTime() - 2 * H), listUserIds: base.waitingUserIds, openPlaces: 1, outcome: "none-by-admin" };
    expect(decidePickRound({ ...base, lastClosedRound: closed, dropsSince: 0 }).action).toBe("wait");
    expect(decidePickRound({ ...base, lastClosedRound: closed, dropsSince: 1 }).action).toBe("open");
    expect(decidePickRound({ ...base, lastClosedRound: { ...closed, listUserIds: ["u-kemal"] }, dropsSince: 0 }).action).toBe("open");
  });
  it("after a round was filled, a free place always opens a new one (the picked player said OUT)", () => {
    const closed = { createdAt: new Date(base.now.getTime() - 2 * H), listUserIds: base.waitingUserIds, openPlaces: 1, outcome: "filled" };
    expect(decidePickRound({ ...base, lastClosedRound: closed, dropsSince: 0 }).action).toBe("open");
  });

  // ── The squad is not set yet (rehearsal 2026-10-15, finding 1) ──
  it("no confirmed player yet: no pick round, however many places are open (the organisers are still making the list)", () => {
    expect(decidePickRound({ ...base, openPlaces: 18, confirmed: 0, dropsSince: 0 })).toEqual({
      action: "wait",
      why: "no squad yet",
    });
  });
  it("a pasted list waiting for YES: no pick round, nor a superseding one", () => {
    expect(decidePickRound({ ...base, pastePending: true })).toEqual({ action: "wait", why: "a pasted list is waiting for YES" });
    const openRound = { createdAt: new Date(base.now.getTime() - 5 * H), listUserIds: ["u-kemal"], openPlaces: 1 };
    expect(decidePickRound({ ...base, openRound, pastePending: true }).action).toBe("wait");
  });

  // ── One prompt per opening (rehearsal 2026-10-15, finding 2) ──
  describe("an open round after the admins changed the squad themselves", () => {
    const openRound = { createdAt: new Date(base.now.getTime() - 5 * H), listUserIds: base.waitingUserIds, openPlaces: 2 };
    it("they filled a place ('put Zed in'): no new message, the round just records the count", () => {
      expect(decidePickRound({ ...base, openRound, openPlaces: 1, dropsSince: 0 })).toEqual({ action: "refresh" });
    });
    it("they took a player out in the admin group (not a player's drop): no new message either", () => {
      expect(decidePickRound({ ...base, openRound, openPlaces: 3, dropsSince: 0 })).toEqual({ action: "refresh" });
    });
    it("they brought in someone from the bench: the shorter bench is still answered by the list as sent", () => {
      expect(decidePickRound({ ...base, openRound, openPlaces: 1, waitingUserIds: ["u-wasim"], dropsSince: 0 })).toEqual({
        action: "refresh",
      });
    });
    it("nothing at all changed: wait", () => {
      expect(decidePickRound({ ...base, openRound, openPlaces: 2, dropsSince: 0 }).action).toBe("wait");
    });
    it("a player dropped since: a new message, about that drop", () => {
      expect(decidePickRound({ ...base, openRound, openPlaces: 2, dropsSince: 1 })).toEqual({ action: "supersede", news: "drop" });
    });
    it("somebody new joined the bench: a new message, the bench update", () => {
      expect(decidePickRound({ ...base, openRound, waitingUserIds: [...base.waitingUserIds, "u-ali"], dropsSince: 0 })).toEqual({
        action: "supersede",
        news: "bench",
      });
    });
  });
  it("after NONE, the admins' own change to the count opens nothing; a player's drop or a new name on the bench does", () => {
    const closed = { createdAt: new Date(base.now.getTime() - 2 * H), listUserIds: base.waitingUserIds, openPlaces: 1, outcome: "none-by-admin" };
    expect(decidePickRound({ ...base, lastClosedRound: closed, openPlaces: 2, dropsSince: 0 }).action).toBe("wait");
    expect(decidePickRound({ ...base, lastClosedRound: closed, openPlaces: 2, dropsSince: 1 }).action).toBe("open");
    expect(decidePickRound({ ...base, lastClosedRound: closed, waitingUserIds: [...base.waitingUserIds, "u-ali"], dropsSince: 0 }).action).toBe(
      "open",
    );
  });
});

describe("the pick message (P1) and the list again (P5)", () => {
  const rows = [
    { name: "Kemal", position: "GK", rating: 7.4 },
    { name: "Wasim", position: "MID", rating: 7.9 },
    { name: "Ali", position: null, rating: null },
  ];
  const base = {
    reason: "drop" as "drop" | "open-place" | "deadline-summary" | "bench-update",
    droppedNames: ["Hamzah"],
    late: false,
    activityName: "Friday 9-a-side",
    whenLabel: "Fri 9 Oct at 20:30",
    open: 1,
    confirmed: 17,
    maxPlayers: 18,
    rows,
    audience: "dm" as const,
    fallback: "bench-offer" as const,
    fallbackWhen: "Saturday 20:30",
    deadlineLabel: "Mon 5 Oct at 21:00",
  };
  it("EN, by DM", () => {
    expect(buildPickMessage({ ...base, lang: "en" })).toBe(
      [
        "*Hamzah* dropped out of *Friday 9-a-side* (Fri 9 Oct at 20:30). 1 place open, squad 17/18.",
        "",
        "Bench:",
        "1. Kemal (GK, 7.4)",
        "2. Wasim (MID, 7.9)",
        "3. Ali (no position, new)",
        "",
        "Reply with a number or a name to bring someone in, e.g. *2*, or *2 3* for two. Reply *NONE* to leave it open.",
        "If nobody picks by Saturday 20:30, I'll offer the place to the whole bench.",
      ].join("\n"),
    );
  });
  it("TR, in the admin group, leave-empty", () => {
    expect(buildPickMessage({ ...base, lang: "tr", audience: "group", fallback: "leave-empty", fallbackWhen: "Cumartesi 20:30" })).toBe(
      [
        "*Hamzah*, *Friday 9-a-side* (Fri 9 Oct at 20:30) maçından çıktı. 1 yer boş, kadro 17/18.",
        "",
        "Yedek listesi:",
        "1. Kemal (GK, 7.4)",
        "2. Wasim (MID, 7.9)",
        "3. Ali (mevki yok, yeni)",
        "",
        "Beni etiketleyip numara, isim ya da @etiket yazın, örneğin *@Match Time 2*, iki kişi için *@Match Time 2 3*. *@Match Time HİÇBİRİ* yazarsanız yer boş kalır. Etiketlemek için *@* yazıp listeden *Match Time*'ı seçin.",
        "Cumartesi 20:30 saatine kadar kimse seçmezse yer boş kalır.",
      ].join("\n"),
    );
  });
  it("first-line variants: two drops, a late drop, no drop, the deadline summary", () => {
    const first = (over: Partial<typeof base>) => buildPickMessage({ ...base, lang: "en", ...over }).split("\n")[0];
    expect(first({ droppedNames: ["Ali", "Sam"], open: 2, confirmed: 16 })).toBe(
      "*Ali* and *Sam* dropped out of *Friday 9-a-side* (Fri 9 Oct at 20:30). 2 places open, squad 16/18.",
    );
    expect(first({ droppedNames: ["Ali"], late: true })).toBe(
      "*Ali* dropped out of *Friday 9-a-side* (Fri 9 Oct at 20:30) after the deadline. 1 place open, squad 17/18.",
    );
    expect(first({ reason: "open-place", droppedNames: [] })).toBe(
      "There is 1 place open in *Friday 9-a-side* (Fri 9 Oct at 20:30), squad 17/18.",
    );
    expect(first({ reason: "deadline-summary" })).toBe(
      "Drop-out deadline (Mon 5 Oct at 21:00) passed for *Friday 9-a-side*, kick-off Fri 9 Oct at 20:30. 1 place open, squad 17/18.",
    );
  });
  it("the deadline summary says which time is the deadline and which the kick-off (2026-10-15, FNF), EN and TR", () => {
    expect(buildPickMessage({ ...base, lang: "tr", reason: "deadline-summary", deadlineLabel: "5 Ekim Pazartesi 21:00", whenLabel: "9 Ekim Cuma 20:30" }).split("\n")[0]).toBe(
      "*Friday 9-a-side* için son çıkış saati (5 Ekim Pazartesi 21:00) geçti, maç 9 Ekim Cuma 20:30. 1 yer boş, kadro 17/18.",
    );
  });
  it("the bench update: no drop-out named again, no fallback line again, just the count, the list and how to answer", () => {
    expect(buildPickMessage({ ...base, lang: "en", reason: "bench-update", audience: "group" })).toBe(
      [
        "The bench for *Friday 9-a-side* (Fri 9 Oct at 20:30) has changed. 1 place open, squad 17/18.",
        "",
        "Bench:",
        "1. Kemal (GK, 7.4)",
        "2. Wasim (MID, 7.9)",
        "3. Ali (no position, new)",
        "",
        "Tag me with a number, a name or an @tag, e.g. *@Match Time 2*, or *@Match Time 2 3* for two. *@Match Time NONE* leaves it open. To tag me, type *@* and pick *Match Time* from the list.",
      ].join("\n"),
    );
    expect(buildPickMessage({ ...base, lang: "tr", reason: "bench-update", audience: "group" }).split("\n")[0]).toBe(
      "*Friday 9-a-side* (Fri 9 Oct at 20:30) için yedek listesi değişti. 1 yer boş, kadro 17/18.",
    );
  });
  it("P5 repeats the list with the instructions", () => {
    expect(buildPickListChanged({ lang: "en", rows: rows.slice(0, 1), audience: "group" })).toBe(
      [
        "The bench has changed since my last message. Here it is again:",
        "",
        "Bench:",
        "1. Kemal (GK, 7.4)",
        "",
        "Tag me with a number, a name or an @tag, e.g. *@Match Time 2*, or *@Match Time 2 3* for two. *@Match Time NONE* leaves it open. To tag me, type *@* and pick *Match Time* from the list.",
      ].join("\n"),
    );
  });
  it("positions: up to two, or none", () => {
    expect(positionLabel(["GK", "DEF", "MID"])).toBe("GK/DEF");
    expect(positionLabel([])).toBeNull();
  });
});

describe("constants", () => {
  it("a late reply is the same 30 minutes as a late group message", () => {
    expect(PICK_LATE_REPLY_MS).toBe(LATE_MESSAGE_AFTER_MS);
  });
});
