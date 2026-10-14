import { describe, expect, it, vi } from "vitest";
import { postPictureCheck, postPictureRead } from "./picture-api.js";

const META = {
  groupId: "1@g.us",
  waMessageId: "m1",
  senderPhone: "447700900001",
  senderAltPhone: null,
  senderLid: null,
  caption: "",
};

function fetchReturning(body: unknown, ok = true) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({ ok, json: async () => body }) as Response);
}

describe("picture api", () => {
  it("check sends the metadata only, no picture", async () => {
    const f = fetchReturning({ read: true, why: "admin" });
    expect(await postPictureCheck(META, f)).toEqual({ read: true, why: "admin" });
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/\/api\/whatsapp\/picture$/);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ mode: "check", ...META });
    expect(body.image).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-api-key"]).toBeDefined();
  });

  it("read sends the picture as base64 with its type", async () => {
    const f = fetchReturning({ read: true, transcript: "[Picture] x" });
    const r = await postPictureRead(META, { data: Buffer.from("abc"), mediaType: "image/jpeg" }, f);
    expect(r).toEqual({ read: true, transcript: "[Picture] x" });
    expect(JSON.parse(String(f.mock.calls[0][1].body)).image).toEqual({ data: Buffer.from("abc").toString("base64"), mediaType: "image/jpeg" });
  });

  it("a failed or refused call is null, never a throw", async () => {
    expect(await postPictureCheck(META, fetchReturning({}, false))).toBeNull();
    expect(await postPictureCheck(META, vi.fn(async () => Promise.reject(new Error("net"))))).toBeNull();
  });
});
