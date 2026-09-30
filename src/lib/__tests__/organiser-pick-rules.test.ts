/**
 * Slice 2b, the pure half of organiser pick (plan 2.7 to 2.11): when a
 * round opens, when nobody has picked in time, what an admin's reply
 * means, and the pick message. No database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  PICK_LATE_REPLY_MS,
  buildPickListChanged,
  buildPickMessage,
  decidePickRound,
  parsePickReply,
  pickFallbackAt,
  positionLabel,
  type PickReplyContext,
} from "../organiser-pick-rules";
import { LATE_MESSAGE_AFTER_MS } from "../late-message";

const H = 3600_000;

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
  it("waits overnight (a drop at 23:00 waits for 08:00)", () => {
    expect(decidePickRound({ ...base, now: new Date("2026-10-07T22:00:00Z") }).action).toBe("wait");
    expect(decidePickRound({ ...base, now: new Date("2026-10-08T07:00:00Z") }).action).toBe("open");
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
});

const ctx = (over: Partial<PickReplyContext> = {}): PickReplyContext => ({
  list: [
    { userId: "u-kemal", name: "Kemal Ediz" },
    { userId: "u-wasim", name: "Wasim" },
    { userId: "u-ali-k", name: "Ali Khan" },
    { userId: "u-ibo", name: "İbrahim Işık" },
  ],
  confirmed: [{ userId: "u-hamzah", name: "Hamzah" }],
  members: [
    { userId: "u-ali-d", name: "Ali Demir" },
    { userId: "u-sam", name: "Sam Lee" },
  ],
  pendingConfirm: false,
  tags: [],
  ...over,
});

describe("parsePickReply: numbers", () => {
  it.each([
    ["2", [2]],
    ["2 3", [2, 3]],
    ["2, 3", [2, 3]],
    ["2 and 3", [2, 3]],
    ["2 ve 3", [2, 3]],
    ["1-3", [1, 2, 3]],
    ["2.", [2]],
    ["@Match Time 2", [2]],
  ])("%s", (text, numbers) => {
    expect(parsePickReply(text, ctx(), "group")).toEqual({ kind: "numbers", numbers });
  });
  it("out of range is not understood in a DM and ignored in the group", () => {
    expect(parsePickReply("9", ctx(), "dm")).toEqual({ kind: "not-understood" });
    expect(parsePickReply("9", ctx(), "group")).toEqual({ kind: "not-a-pick" });
  });
});

describe("parsePickReply: names and tags", () => {
  it("a unique first name, a full name, a name typed with @", () => {
    expect(parsePickReply("Wasim", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-wasim"] });
    expect(parsePickReply("kemal ediz", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-kemal"] });
    expect(parsePickReply("@Wasim", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-wasim"] });
    expect(parsePickReply("Wasim, Kemal", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-wasim", "u-kemal"] });
  });
  it("Turkish İ and ı, and accents, fold", () => {
    expect(parsePickReply("ibrahim", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-ibo"] });
    expect(parsePickReply("İBRAHİM IŞIK", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-ibo"] });
  });
  it("the waiting list wins over the club: 'Ali' is Ali Khan", () => {
    expect(parsePickReply("Ali", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-ali-k"] });
  });
  it("a first name that fits two candidates is ambiguous (E5)", () => {
    const c = ctx({ list: [{ userId: "u-ali-k", name: "Ali Khan" }, { userId: "u-ali-d", name: "Ali Demir" }] });
    expect(parsePickReply("ali", c, "group")).toEqual({ kind: "ambiguous", first: "ali", names: ["Ali Khan", "Ali Demir"] });
    expect(parsePickReply("Ali", c, "dm")).toEqual({ kind: "ambiguous", first: "Ali", names: ["Ali Khan", "Ali Demir"] });
  });
  it("a club member not on the list and a confirmed player resolve too (E1, E2 are the caller's)", () => {
    expect(parsePickReply("Sam", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-sam"] });
    expect(parsePickReply("Hamzah", ctx(), "group")).toEqual({ kind: "people", userIds: ["u-hamzah"] });
  });
  it("a real @tag resolved by the server; one it cannot resolve is E4", () => {
    const tags = [{ digits: "252012071493723", userId: "u-wasim" }];
    expect(parsePickReply("@252012071493723", ctx({ tags }), "group")).toEqual({ kind: "people", userIds: ["u-wasim"] });
    expect(parsePickReply("@Match Time @252012071493723", ctx({ tags }), "group")).toEqual({ kind: "people", userIds: ["u-wasim"] });
    expect(parsePickReply("@99999999999", ctx({ tags }), "group")).toEqual({ kind: "unresolved-tag" });
    expect(parsePickReply("@99999999999", ctx({ tags: [{ digits: "99999999999", userId: null }] }), "group")).toEqual({
      kind: "unresolved-tag",
    });
  });
  it("a sentence with a name in it is chat, not a pick", () => {
    expect(parsePickReply("Wasim played well last week", ctx(), "group")).toEqual({ kind: "not-a-pick" });
    const tags = [{ digits: "252012071493723", userId: "u-wasim" }];
    expect(parsePickReply("@252012071493723 played well", ctx({ tags }), "group")).toEqual({ kind: "not-a-pick" });
  });
  it("in a DM, a pick-shaped reply that does not resolve is P6; plain chat falls through", () => {
    expect(parsePickReply("Wasim and Bob", ctx(), "dm")).toEqual({ kind: "not-understood" });
    expect(parsePickReply("2 and Bob", ctx(), "dm")).toEqual({ kind: "not-understood" });
    expect(parsePickReply("what time is kickoff?", ctx(), "dm")).toEqual({ kind: "not-a-pick" });
  });
});

describe("parsePickReply: ALL, NONE, YES", () => {
  it("ALL and HEPSİ", () => {
    expect(parsePickReply("ALL", ctx(), "group")).toEqual({ kind: "all" });
    expect(parsePickReply("hepsi", ctx(), "group")).toEqual({ kind: "all" });
  });
  it("NONE, NOBODY, LEAVE IT, HİÇBİRİ, KİMSE; never YOK", () => {
    for (const w of ["NONE", "nobody", "Leave it", "HİÇBİRİ", "KİMSE"]) {
      expect(parsePickReply(w, ctx(), "group"), w).toEqual({ kind: "none" });
    }
    expect(parsePickReply("YOK", ctx(), "group")).toEqual({ kind: "not-a-pick" });
  });
  it("YES and EVET only while a question is pending", () => {
    expect(parsePickReply("YES", ctx(), "group")).toEqual({ kind: "not-a-pick" });
    expect(parsePickReply("yes", ctx({ pendingConfirm: true }), "group")).toEqual({ kind: "yes" });
    expect(parsePickReply("Evet", ctx({ pendingConfirm: true }), "dm")).toEqual({ kind: "yes" });
  });
});

describe("the pick message (P1) and the list again (P5)", () => {
  const rows = [
    { name: "Kemal", position: "GK", rating: 7.4 },
    { name: "Wasim", position: "MID", rating: 7.9 },
    { name: "Ali", position: null, rating: null },
  ];
  const base = {
    reason: "drop" as "drop" | "open-place" | "deadline-summary",
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
  };
  it("EN, by DM", () => {
    expect(buildPickMessage({ ...base, lang: "en" })).toBe(
      [
        "*Hamzah* dropped out of *Friday 9-a-side* (Fri 9 Oct at 20:30). 1 place open, squad 17/18.",
        "",
        "Waiting list:",
        "1. Kemal (GK, 7.4)",
        "2. Wasim (MID, 7.9)",
        "3. Ali (no position, new)",
        "",
        "Reply with a number or a name to bring someone in, e.g. *2*, or *2 3* for two. Reply *NONE* to leave it open.",
        "If nobody picks by Saturday 20:30, I'll offer the place to the whole waiting list.",
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
        "Buraya numara, isim ya da @etiket yazın, örneğin *2*, iki kişi için *2 3*. *HİÇBİRİ* yazarsanız yer boş kalır.",
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
      "Drop-out deadline passed for *Friday 9-a-side* (Fri 9 Oct at 20:30). 1 place open, squad 17/18.",
    );
  });
  it("P5 repeats the list with the instructions", () => {
    expect(buildPickListChanged({ lang: "en", rows: rows.slice(0, 1), audience: "group" })).toBe(
      [
        "The waiting list has changed since my last message. Here it is again:",
        "",
        "Waiting list:",
        "1. Kemal (GK, 7.4)",
        "",
        "Reply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open.",
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
