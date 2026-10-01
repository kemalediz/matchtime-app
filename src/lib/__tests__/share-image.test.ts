/**
 * Sharing a card as an IMAGE (Kemal, 2026-10-01). On a phone the share
 * sheet must offer WhatsApp with the PNG attached; anywhere that cannot
 * share files (desktop, older browsers) the PNG is downloaded and the
 * page says how to send it. A player who closes the share sheet has
 * done nothing wrong, so that is silent.
 */
import { describe, it, expect, vi } from "vitest";
import { shareImage, type ShareDeps } from "../share-image";

const PNG = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const REQ = { url: "/api/badge-card/u-1/mom-machine?org=o-1", filename: "matchtime-mom-machine.png", text: "I just earned 👑 MoM Machine" };

function deps(over: Partial<ShareDeps> = {}): ShareDeps & {
  download: ReturnType<typeof vi.fn>;
  fetchImage: ReturnType<typeof vi.fn>;
} {
  return {
    fetchImage: vi.fn(() => Promise.resolve(PNG)),
    download: vi.fn(),
    nav: {
      canShare: vi.fn(() => true),
      share: vi.fn(() => Promise.resolve()),
    },
    ...over,
  } as never;
}

describe("shareImage", () => {
  it("shares the PNG as a file with the text when the browser can share files", async () => {
    const d = deps();
    expect(await shareImage(REQ, d)).toBe("shared");
    expect(d.fetchImage).toHaveBeenCalledWith(REQ.url);
    const payload = (d.nav!.share as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.text).toBe(REQ.text);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toBe(REQ.filename);
    expect(payload.files[0].type).toBe("image/png");
    // canShare was asked about the files, not just text.
    const asked = (d.nav!.canShare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(asked.files).toHaveLength(1);
    expect(d.download).not.toHaveBeenCalled();
  });

  it("downloads the PNG when the browser cannot share files", async () => {
    const d = deps({ nav: { canShare: vi.fn(() => false), share: vi.fn() } });
    expect(await shareImage(REQ, d)).toBe("downloaded");
    expect(d.nav!.share).not.toHaveBeenCalled();
    expect(d.download).toHaveBeenCalledTimes(1);
    expect(d.download.mock.calls[0][0]).toBe(PNG);
    expect(d.download.mock.calls[0][1]).toBe(REQ.filename);
  });

  it("downloads when there is no Web Share API at all (desktop)", async () => {
    const d = deps({ nav: {} });
    expect(await shareImage(REQ, d)).toBe("downloaded");
    expect(d.download).toHaveBeenCalledTimes(1);
  });

  it("downloads when there is no navigator", async () => {
    const d = deps({ nav: undefined });
    expect(await shareImage(REQ, d)).toBe("downloaded");
  });

  it("is silent when the player cancels the share sheet: no download, no error", async () => {
    const abort = Object.assign(new Error("Share canceled"), { name: "AbortError" });
    const d = deps({ nav: { canShare: () => true, share: vi.fn(() => Promise.reject(abort)) } });
    expect(await shareImage(REQ, d)).toBe("cancelled");
    expect(d.download).not.toHaveBeenCalled();
  });

  it("falls back to a download when sharing fails for another reason", async () => {
    // e.g. Safari's NotAllowedError when the tap's activation has lapsed.
    const denied = Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
    const d = deps({ nav: { canShare: () => true, share: vi.fn(() => Promise.reject(denied)) } });
    expect(await shareImage(REQ, d)).toBe("downloaded");
    expect(d.download).toHaveBeenCalledTimes(1);
  });

  it("falls back to a download when canShare itself throws", async () => {
    const d = deps({ nav: { canShare: () => { throw new TypeError("bad"); }, share: vi.fn() } });
    expect(await shareImage(REQ, d)).toBe("downloaded");
  });

  it("reports failure when the image cannot be fetched", async () => {
    const d = deps({ fetchImage: vi.fn(() => Promise.reject(new Error("404"))) });
    expect(await shareImage(REQ, d)).toBe("failed");
    expect(d.download).not.toHaveBeenCalled();
  });
});
