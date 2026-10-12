/**
 * Pasted Yandex Maps links (owner decision, 2026-10-12: Turkish clubs
 * use them). Read for coordinates, never fetched.
 *
 * THE TRAP: Yandex writes LONGITUDE FIRST, then latitude, the opposite of
 * every other service here. The fixed point below is Sultanahmet Square
 * in Istanbul, latitude 41.0054 north, longitude 28.9768 east: read the
 * wrong way round it would land in the sea off Somalia.
 *
 * Short share links (/maps/-/<code>) hold nothing and would need a
 * request to resolve. They are refused; Yandex is NOT on the outbound
 * allow-list.
 */
import { describe, it, expect, vi } from "vitest";
import { expandShortLink, parseMapInput } from "../map-link";

const ISTANBUL = { lat: 41.0054, lng: 28.9768 };

describe("Yandex Maps links", () => {
  it("ll= is longitude,latitude: a known Istanbul point comes out the right way round", () => {
    const got = parseMapInput("https://yandex.com.tr/harita/?ll=28.9768%2C41.0054&z=16");
    expect(got).toEqual({ kind: "coords", provider: "yandex", ...ISTANBUL });
    if (got.kind !== "coords") throw new Error("fixture");
    // Istanbul: north of 40, between 28 and 30 east.
    expect(got.lat).toBeGreaterThan(40);
    expect(got.lat).toBeLessThan(42);
    expect(got.lng).toBeGreaterThan(28);
    expect(got.lng).toBeLessThan(30);
  });

  it("the two links from the brief", () => {
    expect(parseMapInput("https://yandex.com.tr/harita/?ll=28.979530%2C41.015137&z=16")).toEqual({
      kind: "coords",
      provider: "yandex",
      lat: 41.015137,
      lng: 28.97953,
    });
    expect(parseMapInput("https://yandex.com/maps/?pt=28.9795,41.0151&z=17")).toEqual({
      kind: "coords",
      provider: "yandex",
      lat: 41.0151,
      lng: 28.9795,
    });
  });

  it("the pin (pt, or the 'what is here' point) wins over the map centre (ll)", () => {
    expect(parseMapInput("https://yandex.com/maps/?ll=29.5,41.5&pt=28.9768,41.0054&z=17")).toMatchObject(ISTANBUL);
    expect(parseMapInput("https://yandex.com/maps/?ll=29.5%2C41.5&whatshere%5Bpoint%5D=28.9768%2C41.0054&whatshere%5Bzoom%5D=17")).toMatchObject(
      ISTANBUL,
    );
    // pt may carry a marker style, and several points: the first is used.
    expect(parseMapInput("https://yandex.ru/maps/?pt=28.9768,41.0054,pm2rdm~30.1,40.2")).toMatchObject(ISTANBUL);
  });

  it("path forms that carry ll=", () => {
    for (const u of [
      "https://yandex.com.tr/harita/115707/istanbul/?ll=28.9768%2C41.0054&z=12",
      "https://yandex.com.tr/harita/org/sultanahmet_meydani/1234567890/?ll=28.9768%2C41.0054&z=17",
      "https://yandex.com/maps/org/some_place/1234567890/?ll=28.9768%2C41.0054&z=17",
      "https://yandex.ru/maps/11508/istanbul/?ll=28.9768%2C41.0054&mode=search&z=14",
    ]) {
      expect(parseMapInput(u), u).toEqual({ kind: "coords", provider: "yandex", ...ISTANBUL });
    }
  });

  it("the maps.yandex.* hosts", () => {
    for (const host of ["maps.yandex.com", "maps.yandex.com.tr", "maps.yandex.ru"]) {
      expect(parseMapInput(`https://${host}/?ll=28.9768,41.0054&z=16`), host).toEqual({ kind: "coords", provider: "yandex", ...ISTANBUL });
      expect(parseMapInput(`https://${host}/maps/?ll=28.9768,41.0054`), host).toMatchObject(ISTANBUL);
    }
  });

  it("a southern, western point keeps its signs", () => {
    // Buenos Aires: 34.6 south, 58.4 west.
    expect(parseMapInput("https://yandex.com/maps/?ll=-58.3816%2C-34.6037&z=12")).toMatchObject({ lat: -34.6037, lng: -58.3816 });
  });

  it("a short share link is refused: it holds nothing, and Yandex is never requested", async () => {
    for (const u of ["https://yandex.com.tr/harita/-/CDqXfK5Y", "https://yandex.com/maps/-/CCUkz4Vd", "https://yandex.ru/maps/-/CCUkz4Vd"]) {
      expect(parseMapInput(u), u).toEqual({ kind: "unsupported", reason: "short-link" });
    }
    const fetchImpl = vi.fn();
    const got = await expandShortLink(new URL("https://yandex.com.tr/harita/-/CDqXfK5Y"), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got).toEqual({ ok: false, reason: "left-allow-list" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a Yandex link that shows no place, or impossible coordinates", () => {
    expect(parseMapInput("https://yandex.com.tr/harita/")).toEqual({ kind: "unsupported", reason: "no-location" });
    expect(parseMapInput("https://yandex.com/maps/?text=halisaha")).toEqual({ kind: "unsupported", reason: "no-location" });
    // 95 cannot be a latitude: nothing is guessed by swapping the pair.
    expect(parseMapInput("https://yandex.com/maps/?ll=28.9768,95.0")).toEqual({ kind: "unsupported", reason: "no-location" });
    expect(parseMapInput("https://yandex.com/maps/?ll=0,0")).toEqual({ kind: "unsupported", reason: "no-location" });
  });

  it("only /maps and /harita are maps: the rest of Yandex is not", () => {
    for (const u of [
      "https://yandex.com/search/?text=x&ll=28.9768,41.0054",
      "https://yandex.com.tr/?ll=28.9768,41.0054",
      "https://yandex.ru/pogoda/?ll=28.9768,41.0054",
      "https://yandex.com/mapsfake/?ll=28.9768,41.0054",
    ]) {
      expect(parseMapInput(u), u).toEqual({ kind: "unsupported", reason: "unknown-host" });
    }
  });

  it.each([
    "https://yandex.com.tr.evil.example/harita/?ll=28.9768,41.0054",
    "https://evilyandex.com.tr/harita/?ll=28.9768,41.0054",
    "https://yandex.com.evil.example/maps/?ll=28.9768,41.0054",
    "https://yandex.co/maps/?ll=28.9768,41.0054",
    "https://yandex.net/maps/?ll=28.9768,41.0054",
    "https://www.yandex.com.tr/harita/?ll=28.9768,41.0054",
    "https://maps.yandex.com.tr.evil.example/?ll=28.9768,41.0054",
    "https://xn--yandex-9ua.com/maps/?ll=28.9768,41.0054",
    "https://yandex.com.tr@evil.example/harita/?ll=28.9768,41.0054",
    "https://yandex.com.tr:8443/harita/?ll=28.9768,41.0054",
    "https://yandex.com.tr./harita/?ll=28.9768,41.0054",
  ])("a look-alike or dressed-up host is not Yandex: %s", (u) => {
    expect(parseMapInput(u)).toEqual({ kind: "unsupported", reason: "unknown-host" });
  });
});
