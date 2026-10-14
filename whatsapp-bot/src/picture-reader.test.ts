/**
 * The Pi's half of picture reading: which pictures it asks about, what it
 * downloads, what it hands up, and that a picture is handed up exactly
 * once whatever goes wrong. Everything external is stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createPictureReader,
  pictureMetaOf,
  withTranscript,
  MAX_PICTURES_PER_GROUP_PER_DAY,
  type PictureReaderDeps,
} from "./picture-reader.js";
import { BAILEYS_RAW } from "./baileys/inbound-view.js";

const GROUP = "120363000000000001@g.us";
const RAW = { key: { id: "ABC" }, message: { imageMessage: { caption: "" } } };

function view(over: Record<string, unknown> = {}) {
  return {
    id: { _serialized: `false_${GROUP}_ABC_447700900001@c.us` },
    from: GROUP,
    author: "447700900001@c.us",
    fromMe: false,
    type: "image",
    body: "",
    hasMedia: true,
    mentionedIds: [],
    timestamp: 1760000000,
    _data: { body: "", notifyName: "Alex" },
    baileys: { upsertType: "notify", senderJid: "447700900001@c.us", senderPhone: "447700900001", pushName: "Alex", senderLid: "999", altPhone: null },
    [BAILEYS_RAW]: RAW,
    ...over,
  } as never;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function deps(over: Partial<PictureReaderDeps> = {}) {
  const lines: string[] = [];
  const d: PictureReaderDeps = {
    isMonitored: (g) => g === GROUP,
    check: vi.fn(async () => ({ read: true })),
    download: vi.fn(async () => Buffer.from("JPEGBYTES-SECRET")),
    shrink: vi.fn(async (b: Buffer) => ({ data: b, mediaType: "image/jpeg" as const })),
    read: vi.fn(async () => ({ read: true, transcript: "[Picture] Poster: 1. Ali 2. Ben" })),
    log: (l) => lines.push(l),
    now: () => new Date("2026-10-09T18:00:00Z").getTime(),
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    },
    ...over,
  };
  return { d, lines };
}

async function run(d: PictureReaderDeps, v = view()) {
  const handed: unknown[] = [];
  const reader = createPictureReader(d);
  if (!reader.wants(v)) return { wanted: false, handed };
  reader.handle(v, RAW as never, (x) => handed.push(x));
  for (let i = 0; i < 10; i++) await flush();
  return { wanted: true, handed };
}

describe("which pictures the Pi even looks at", () => {
  it("an image in a monitored group from someone else: yes", () => {
    expect(createPictureReader(deps().d).wants(view())).toBe(true);
  });
  it.each([
    ["a text message", { type: "chat", hasMedia: false }],
    ["a video", { type: "video" }],
    ["a sticker", { type: "sticker" }],
    ["our own picture", { fromMe: true }],
    ["a DM", { from: "447700900001@c.us" }],
    ["an unmonitored group", { from: "120363999999999999@g.us" }],
  ])("%s: no", (_l, over) => {
    expect(createPictureReader(deps().d).wants(view(over))).toBe(false);
  });
});

describe("the read", () => {
  it("asks first, downloads only on a yes, and hands up the transcript as the sender's message", async () => {
    const { d } = deps();
    const { handed } = await run(d);
    expect(d.check).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GROUP, waMessageId: `false_${GROUP}_ABC_447700900001@c.us`, senderPhone: "447700900001", senderLid: "999", caption: "" }),
    );
    expect(d.download).toHaveBeenCalledTimes(1);
    expect(handed).toHaveLength(1);
    const v = handed[0] as { body: string; _data: { body: string }; id: { _serialized: string }; [BAILEYS_RAW]: unknown };
    expect(v.body).toBe("[Picture] Poster: 1. Ali 2. Ben");
    expect(v._data.body).toBe(v.body);
    // Same message: same id (reactions land on the picture), raw kept for replies.
    expect(v.id._serialized).toBe(`false_${GROUP}_ABC_447700900001@c.us`);
    expect(v[BAILEYS_RAW]).toBe(RAW);
  });

  it("a caption is kept and the transcript goes under it", async () => {
    const { d } = deps();
    const { handed } = await run(d, view({ body: "Friday list", _data: { body: "Friday list" } }));
    expect((handed[0] as { body: string }).body).toBe("Friday list\n[Picture] Poster: 1. Ali 2. Ben");
  });

  it("a no from the server: no download, the picture is handed up as it was", async () => {
    const { d } = deps({ check: vi.fn(async () => ({ read: false, reason: "not-qualifying" })) });
    const v = view({ body: "lol", _data: { body: "lol" } });
    const { handed } = await run(d, v);
    expect(d.download).not.toHaveBeenCalled();
    expect(handed).toEqual([v]);
  });

  it("'not about the game': handed up as it was", async () => {
    const { d } = deps({ read: vi.fn(async () => ({ read: true, transcript: null })) });
    const v = view();
    const { handed } = await run(d, v);
    expect(handed).toEqual([v]);
  });

  it.each([
    ["the check throws", { check: vi.fn(async () => Promise.reject(new Error("net"))) }],
    ["the check has no answer", { check: vi.fn(async () => null) }],
    ["the download fails", { download: vi.fn(async () => Promise.reject(new Error("410"))) }],
    ["the download is refused (too big)", { download: vi.fn(async () => null) }],
    ["the picture cannot be shrunk", { shrink: vi.fn(async () => null) }],
    ["the read throws", { read: vi.fn(async () => Promise.reject(new Error("500"))) }],
    ["the read is refused", { read: vi.fn(async () => ({ read: false, reason: "ai-cap" })) }],
  ])("%s: the picture is still handed up, once, as it was", async (_l, over) => {
    const { d } = deps(over as Partial<PictureReaderDeps>);
    const v = view();
    const { handed } = await run(d, v);
    expect(handed).toEqual([v]);
  });

  it("a read that never answers: the picture is handed up at the deadline, and a late answer is dropped", async () => {
    vi.useFakeTimers();
    try {
      let answer: (x: unknown) => void = () => {};
      const { d } = deps({ read: vi.fn(() => new Promise((r) => (answer = r as never))) as never });
      const handed: unknown[] = [];
      const reader = createPictureReader(d);
      const v = view();
      reader.handle(v, RAW as never, (x) => handed.push(x));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(handed).toEqual([v]);
      answer({ read: true, transcript: "[Picture] late" });
      await vi.advanceTimersByTimeAsync(10);
      expect(handed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("server says the flag is off: no more checks for a while", async () => {
    const check = vi.fn(async () => ({ read: false, reason: "flag-off" }));
    const { d } = deps({ check });
    const reader = createPictureReader(d);
    const handed: unknown[] = [];
    reader.handle(view(), RAW as never, (x) => handed.push(x));
    for (let i = 0; i < 5; i++) await flush();
    expect(reader.wants(view())).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it(`the Pi's own cap: at most ${MAX_PICTURES_PER_GROUP_PER_DAY} downloads per group per day`, async () => {
    const { d } = deps();
    const reader = createPictureReader(d);
    for (let i = 0; i < MAX_PICTURES_PER_GROUP_PER_DAY + 3; i++) {
      reader.handle(view({ id: { _serialized: `id-${i}` } }), RAW as never, () => {});
      for (let k = 0; k < 6; k++) await flush();
    }
    expect(d.download).toHaveBeenCalledTimes(MAX_PICTURES_PER_GROUP_PER_DAY);
  });

  it("logs ids, counts and sizes only: never the picture, its caption or the transcript", async () => {
    const { d, lines } = deps();
    await run(d, view({ body: "SECRET_CAPTION", _data: { body: "SECRET_CAPTION" } }));
    const all = lines.join("\n");
    expect(all).toContain("false_");
    expect(all).not.toContain("SECRET_CAPTION");
    expect(all).not.toContain("JPEGBYTES-SECRET");
    expect(all).not.toContain("Ali");
  });
});

describe("helpers", () => {
  it("pictureMetaOf reads the view's ids, never the pushname", () => {
    const m = pictureMetaOf(view());
    expect(m).toEqual({
      groupId: GROUP,
      waMessageId: `false_${GROUP}_ABC_447700900001@c.us`,
      senderPhone: "447700900001",
      senderAltPhone: null,
      senderLid: "999",
      caption: "",
    });
    expect(JSON.stringify(m)).not.toContain("Alex");
  });

  it("withTranscript leaves the original view untouched", () => {
    const v = view() as { body: string };
    const out = withTranscript(v as never, "[Picture] x") as { body: string };
    expect(out.body).toBe("[Picture] x");
    expect(v.body).toBe("");
  });
});
