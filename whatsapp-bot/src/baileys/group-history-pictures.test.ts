/**
 * PICTURE READING, PHASE 0: what a shared-history bundle does with a
 * picture, against a crafted GroupHistory payload (the real format can
 * carry a whole WebMessageInfo per entry, image messages included).
 *
 * What this settles in code:
 *   - an image entry decodes, with the url, directPath and mediaKey a
 *     download needs still on it (the format can carry them);
 *   - a captioned picture becomes a row whose text is the caption (it is
 *     kept as text today); a captionless one yields no row and is listed
 *     as `imageMessage` in the noText shapes;
 *   - the report counts pictures (`images=N (withPointer=K, captioned=C)`)
 *     and never prints a url, path, key or hash.
 *
 * What it cannot settle: whether a real phone PUTS pictures in the bundle.
 * That needs one real group (see the PR).
 */
import { describe, expect, it } from "vitest";
import { proto } from "baileys";
import { formatBundleReport, readGroupHistoryBundle, unpackBundle } from "./group-history-bundle.js";
import { encodeGroupHistory, encryptBundle, pack, servingFetch } from "./group-history-fixture.js";

const GROUP = "120363000000000000@g.us";
const ADMIN = "111111111111111@lid";
const T0 = 1_759_000_000;
const URL = "https://mmg.whatsapp.net/o1/v/t62.7118-24/SECRET_URL_PART";
const PATH = "/o1/v/t62.7118-24/SECRET_PATH_PART";
const MEDIA_KEY = Buffer.alloc(32, 0x42);

function entry(id: string, message: proto.IMessage, ts: number): proto.IWebMessageInfo {
  return { key: { id, remoteJid: GROUP, participant: ADMIN, fromMe: false }, message, messageTimestamp: ts, pushName: "Admin" };
}

const image = (caption?: string): proto.IMessage => ({
  imageMessage: {
    url: URL,
    directPath: PATH,
    mediaKey: MEDIA_KEY,
    mimetype: "image/jpeg",
    caption,
    fileLength: 120_000,
    fileSha256: Buffer.alloc(32, 1),
    fileEncSha256: Buffer.alloc(32, 2),
    jpegThumbnail: Buffer.alloc(800, 3),
  },
});

const ENTRIES = [
  entry("3EB0BBBBBBBBBBBB0001", { conversation: "who is in friday" }, T0),
  entry("3EB0BBBBBBBBBBBB0002", image("Friday list"), T0 + 10),
  entry("3EB0BBBBBBBBBBBB0003", image(), T0 + 20),
];

describe("pictures in a shared-history bundle", () => {
  it("an image entry decodes with everything a download needs still on it", () => {
    const decoded = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode(ENTRIES[2]).finish());
    expect(decoded.message?.imageMessage?.directPath).toBe(PATH);
    expect(Buffer.from(decoded.message!.imageMessage!.mediaKey!).equals(MEDIA_KEY)).toBe(true);
  });

  it("a caption is kept as its row's text; a captionless picture yields no row; both are counted", async () => {
    const r = await unpackBundle(pack(encodeGroupHistory(ENTRIES), "zlib"), GROUP);
    if (!r.ok) throw new Error(r.reason);
    expect(r.rows.map((x) => x.text)).toEqual(["who is in friday", "Friday list"]);
    expect(r.noTextShapes).toEqual([{ shape: "imageMessage", count: 1 }]);
    expect(r.imageCounts).toEqual({ images: 2, withPointer: 2, captioned: 1 });
  });

  it("the log line says how many pictures there were, and nothing that could fetch one", async () => {
    const plain = pack(encodeGroupHistory(ENTRIES), "zlib");
    const { enc, bundle } = encryptBundle(plain);
    const res = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle: servingFetch(enc).fetchBundle as never });
    expect(res.ok).toBe(true);
    const line = formatBundleReport(res.report).join("\n");
    expect(line).toContain("images=2 (withPointer=2, captioned=1)");
    for (const secret of ["SECRET_URL_PART", "SECRET_PATH_PART", MEDIA_KEY.toString("base64"), MEDIA_KEY.toString("hex"), "Friday list"]) {
      expect(line).not.toContain(secret);
    }
  });

  it("a bundle with no pictures says nothing about pictures (as edited= and noText= do)", async () => {
    const r = await unpackBundle(pack(encodeGroupHistory([ENTRIES[0]]), "zlib"), GROUP);
    if (!r.ok) throw new Error(r.reason);
    expect(r.imageCounts).toEqual({ images: 0, withPointer: 0, captioned: 0 });
    expect(formatBundleReport({ stage: "done", statedMessages: 1, imageCounts: r.imageCounts }).join("")).not.toContain("images=");
  });
});
