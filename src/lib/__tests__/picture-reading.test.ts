/**
 * Picture reading, the server half: which pictures are read, the daily
 * cap, the budget scope, and what comes back. Everything is stubbed: no
 * database, no model.
 */
import { describe, expect, it, vi } from "vitest";
import {
  checkPicture,
  formatTranscript,
  readPicture,
  PICTURE_DAILY_CAP,
  PICTURE_TRANSCRIPT_PREFIX,
  MAX_PICTURE_BYTES,
  type PictureDeps,
} from "../picture-reading";
import { AiBudgetExceededError } from "../ai-budget-context";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import { PICTURE_READING_MODEL } from "../picture-prompt";

const NOW = new Date("2026-10-09T18:00:00.000Z");
const GROUP = "120363000000000001@g.us";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");

function stubModel(text: string, cost = 0.004) {
  const calls: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    complete: vi.fn(async (req: ModelRequest) => {
      calls.push(req);
      return {
        text,
        stopReason: "end_turn",
        usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: cost,
        ms: 1,
      };
    }),
  };
  return { model, calls };
}

function deps(over: Partial<PictureDeps> = {}) {
  const claimed = new Set<string>();
  const budgetKeys: string[] = [];
  const d: PictureDeps = {
    findClub: async (g) => (g === GROUP ? { id: "org-1" } : null),
    isOwnerOrAdmin: async (_org, s) => s.senderPhone === "447700900001" || s.senderLid === "123456789",
    isMember: async () => true,
    readsToday: async () => claimed.size,
    claim: async (_o, _d, id) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    unclaim: async (_o, _d, id) => {
      claimed.delete(id);
    },
    withBudget: async (key, fn) => {
      budgetKeys.push(key);
      return fn();
    },
    model: stubModel("Poster: list of players for Friday 9 October 8:30pm at Harris Merton: 1. Shehryar 2. Imz").model,
    ...over,
  };
  return { d, claimed, budgetKeys };
}

const ADMIN = { groupId: GROUP, waMessageId: "m1", senderPhone: "447700900001" };
const STRANGER = { groupId: GROUP, waMessageId: "m2", senderPhone: "447700900999" };

describe("checkPicture: which pictures are read", () => {
  it("flag off: nothing is read, nothing is looked up", async () => {
    const { d } = deps({ findClub: vi.fn(async () => ({ id: "org-1" })) });
    expect(await checkPicture(ADMIN, { enabled: false, now: NOW, deps: d })).toEqual({ read: false, reason: "flag-off" });
    expect(d.findClub).not.toHaveBeenCalled();
  });

  it("a group that is not a serving club: not read", async () => {
    const { d } = deps();
    const r = await checkPicture({ ...ADMIN, groupId: "999@g.us" }, { enabled: true, now: NOW, deps: d });
    expect(r).toEqual({ read: false, reason: "no-club" });
  });

  it("an owner or admin by phone: read, whatever the caption", async () => {
    const { d } = deps();
    expect(await checkPicture(ADMIN, { enabled: true, now: NOW, deps: d })).toEqual({ read: true, orgId: "org-1", why: "admin" });
  });

  it("an admin by a stored LID pair (no phone): read", async () => {
    const { d } = deps();
    const r = await checkPicture({ groupId: GROUP, waMessageId: "m3", senderLid: "123456789" }, { enabled: true, now: NOW, deps: d });
    expect(r).toMatchObject({ read: true, why: "admin" });
  });

  it("the pushname is never an identity: a stranger named like the admin is not read without a game caption", async () => {
    const { d } = deps();
    const r = await checkPicture({ ...STRANGER, senderName: "Alex Admin" } as never, { enabled: true, now: NOW, deps: d });
    expect(r).toEqual({ read: false, reason: "not-qualifying", orgId: "org-1" });
  });

  it("a member's captioned picture is read, whatever the caption says: no word list decides (2026-10-30)", async () => {
    const { d } = deps();
    for (const caption of ["Teams for tonight", "Cuma kadro", "😂😂", "look at this"]) {
      expect(await checkPicture({ ...STRANGER, caption }, { enabled: true, now: NOW, deps: d }), caption).toEqual({
        read: true,
        orgId: "org-1",
        why: "caption",
      });
    }
  });

  it("an unidentified sender or a non-member never triggers a read, captioned or not (review of #476)", async () => {
    const { d } = deps({ isMember: vi.fn(async () => false) });
    expect(await checkPicture({ ...STRANGER, caption: "Teams for tonight" }, { enabled: true, now: NOW, deps: d })).toMatchObject({
      read: false,
      reason: "not-qualifying",
    });
    const { d: d2 } = deps();
    expect(await checkPicture({ groupId: GROUP, waMessageId: "m9", caption: "Teams" }, { enabled: true, now: NOW, deps: d2 })).toMatchObject({
      read: false,
      reason: "not-qualifying",
    });
  });

  it("a member's picture with no caption is not read", async () => {
    const { d } = deps();
    for (const caption of [undefined, "", "   "]) {
      expect(await checkPicture({ ...STRANGER, caption }, { enabled: true, now: NOW, deps: d })).toMatchObject({
        read: false,
        reason: "not-qualifying",
      });
    }
  });

  it("members' captioned pictures stop at half the day's cap, so the organisers' pictures keep room", async () => {
    const { d } = deps({ readsToday: async () => PICTURE_DAILY_CAP / 2 });
    expect(await checkPicture({ ...STRANGER, caption: "Teams" }, { enabled: true, now: NOW, deps: d })).toEqual({
      read: false,
      reason: "daily-cap",
      orgId: "org-1",
    });
    expect(await checkPicture(ADMIN, { enabled: true, now: NOW, deps: d })).toMatchObject({ read: true, why: "admin" });
  });

  it(`at ${PICTURE_DAILY_CAP} pictures today the club is at its cap`, async () => {
    const { d } = deps({ readsToday: async () => PICTURE_DAILY_CAP });
    expect(await checkPicture(ADMIN, { enabled: true, now: NOW, deps: d })).toEqual({
      read: false,
      reason: "daily-cap",
      orgId: "org-1",
    });
  });

  it("a request without a group or message id is refused", async () => {
    const { d } = deps();
    expect(await checkPicture({ groupId: "", waMessageId: "m" }, { enabled: true, now: NOW, deps: d })).toMatchObject({
      read: false,
      reason: "bad-request",
    });
  });
});

describe("readPicture: one model call, inside the club's budget, once per message", () => {
  it("reads the picture with the vision model and returns a prefixed transcript", async () => {
    const { model, calls } = stubModel("Team sheet: Team 1: Ali, Ben. Team 2: Cem, Dan.");
    const { d, budgetKeys } = deps({ model });
    const r = await readPicture({ ...ADMIN, image: { data: JPEG, mediaType: "image/jpeg" } }, { enabled: true, now: NOW, deps: d });
    expect(r).toEqual({
      read: true,
      orgId: "org-1",
      transcript: `${PICTURE_TRANSCRIPT_PREFIX} Team sheet: Team 1: Ali, Ben. Team 2: Cem, Dan.`,
      costUsd: 0.004,
    });
    expect(budgetKeys).toEqual(["org-1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(PICTURE_READING_MODEL);
    expect(calls[0].label).toBe("picture-reading");
    expect(calls[0].images).toEqual([{ mediaType: "image/jpeg", data: JPEG }]);
  });

  it('"Not about the game": read, no transcript, nothing for the analyser', async () => {
    const { d } = deps({ model: stubModel("Not about the game").model });
    const r = await readPicture({ ...ADMIN, image: { data: JPEG, mediaType: "image/jpeg" } }, { enabled: true, now: NOW, deps: d });
    expect(r).toMatchObject({ read: true, transcript: null });
  });

  it("the same message twice is read once (a Pi retry costs nothing)", async () => {
    const { model } = stubModel("Poster: list");
    const { d } = deps({ model });
    const req = { ...ADMIN, image: { data: JPEG, mediaType: "image/jpeg" as const } };
    await readPicture(req, { enabled: true, now: NOW, deps: d });
    const again = await readPicture(req, { enabled: true, now: NOW, deps: d });
    expect(again).toMatchObject({ read: false, reason: "duplicate" });
    expect(model.complete).toHaveBeenCalledTimes(1);
  });

  it("the cap is enforced at the claim: a read that would be the eleventh is refused and its claim released", async () => {
    // The check sees 9; another request claims the tenth before this one
    // claims, so with its own claim the count is 11.
    const counts = [PICTURE_DAILY_CAP - 1, PICTURE_DAILY_CAP + 1];
    const unclaim = vi.fn(async () => {});
    const { model } = stubModel("Poster");
    const { d } = deps({
      model,
      readsToday: async () => counts.shift() ?? 99,
      claim: async () => true,
      unclaim,
    });
    const r = await readPicture({ ...ADMIN, image: { data: JPEG, mediaType: "image/jpeg" } }, { enabled: true, now: NOW, deps: d });
    expect(r).toMatchObject({ read: false, reason: "daily-cap" });
    expect(unclaim).toHaveBeenCalledTimes(1);
    expect(model.complete).not.toHaveBeenCalled();
  });

  it("at the club's AI cap the model is not called and the answer says so", async () => {
    const { model } = stubModel("x");
    const { d } = deps({
      model,
      withBudget: async (key) => {
        throw new AiBudgetExceededError(key, "picture-reading");
      },
    });
    const r = await readPicture({ ...ADMIN, image: { data: JPEG, mediaType: "image/jpeg" } }, { enabled: true, now: NOW, deps: d });
    expect(r).toMatchObject({ read: false, reason: "ai-cap" });
    expect(model.complete).not.toHaveBeenCalled();
  });

  it("a model failure is a quiet no-read, never a throw", async () => {
    const model: PipelineModel = { name: "boom", complete: async () => Promise.reject(new Error("529")) };
    const { d } = deps({ model });
    const r = await readPicture({ ...ADMIN, image: { data: JPEG, mediaType: "image/jpeg" } }, { enabled: true, now: NOW, deps: d });
    expect(r).toMatchObject({ read: false, reason: "model-error" });
  });

  it.each([
    ["no image", undefined],
    ["an unsupported type", { data: JPEG, mediaType: "image/heic" }],
    ["an empty image", { data: "", mediaType: "image/jpeg" }],
    ["an image over the size limit", { data: Buffer.alloc(MAX_PICTURE_BYTES + 1).toString("base64"), mediaType: "image/jpeg" }],
    ["not base64", { data: "%%%not base64%%%", mediaType: "image/jpeg" }],
  ])("%s is refused before any model call", async (_label, image) => {
    const { model } = stubModel("x");
    const { d } = deps({ model });
    const r = await readPicture({ ...ADMIN, image } as never, { enabled: true, now: NOW, deps: d });
    expect(r).toMatchObject({ read: false, reason: "bad-image" });
    expect(model.complete).not.toHaveBeenCalled();
  });

  it("re-checks everything: a non-qualifying picture is not read even if the Pi sends it", async () => {
    const { model } = stubModel("x");
    const { d } = deps({ model });
    const r = await readPicture({ ...STRANGER, image: { data: JPEG, mediaType: "image/jpeg" } }, { enabled: true, now: NOW, deps: d });
    expect(r).toMatchObject({ read: false, reason: "not-qualifying" });
    expect(model.complete).not.toHaveBeenCalled();
  });

  it("logs counts, sizes and ids only: never the picture, the caption or the transcript", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { d } = deps({ model: stubModel("Poster: SECRET_TRANSCRIPT_TEXT").model });
      await readPicture(
        { ...ADMIN, caption: "SECRET_CAPTION", image: { data: JPEG, mediaType: "image/jpeg" } },
        { enabled: true, now: NOW, deps: d },
      );
      const all = [...log.mock.calls, ...err.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
      expect(all).toContain("m1");
      expect(all).not.toContain("SECRET_TRANSCRIPT_TEXT");
      expect(all).not.toContain("SECRET_CAPTION");
      expect(all).not.toContain(JPEG);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});

describe("formatTranscript", () => {
  it("prefixes, trims and caps the model's text", () => {
    expect(formatTranscript("  Poster: list  ")).toBe(`${PICTURE_TRANSCRIPT_PREFIX} Poster: list`);
    expect(formatTranscript("x".repeat(5000))!.length).toBeLessThanOrEqual(1600);
  });
  it.each(["Not about the game", "not about the game.", "NOT ABOUT THE GAME", "", "   "])("%j is no transcript", (t) => {
    expect(formatTranscript(t)).toBeNull();
  });
});
