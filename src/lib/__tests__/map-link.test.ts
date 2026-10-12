/**
 * Pasted map links: what is read out of the URL itself, and the one
 * place the server makes a request for a link (a short Google link),
 * with every refusal that keeps that from being a way to make the
 * server fetch something else.
 *
 * `fetch` is always a stub here. No test in this file touches the network.
 */
import { describe, it, expect, vi } from "vitest";
import { expandShortLink, parseMapInput, SHORT_LINK_MAX_HOPS } from "../map-link";

describe("plain text is an address, not a link", () => {
  it("returns the text", () => {
    expect(parseMapInput("  12 Whiston Road, London E2 8BN ")).toEqual({
      kind: "address",
      text: "12 Whiston Road, London E2 8BN",
    });
  });

  it("empty input is nothing", () => {
    expect(parseMapInput("   ")).toEqual({ kind: "unsupported", reason: "empty" });
  });

  it("a link inside a pasted WhatsApp share is used, the words around it are not", () => {
    const got = parseMapInput("Powerleague Shoreditch\nhttps://www.google.com/maps/@51.5229,-0.0757,17z");
    expect(got).toMatchObject({ kind: "coords", lat: 51.5229, lng: -0.0757 });
  });
});

describe("Google Maps links", () => {
  it("the pin (!3d !4d) wins over the viewport centre (@)", () => {
    const got = parseMapInput(
      "https://www.google.com/maps/place/Powerleague+Shoreditch/@51.5200,-0.0700,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d51.5229437!4d-0.0757291!16s",
    );
    expect(got).toEqual({
      kind: "coords",
      provider: "google",
      lat: 51.5229437,
      lng: -0.0757291,
      label: "Powerleague Shoreditch",
    });
  });

  it("the viewport centre when there is no pin", () => {
    expect(parseMapInput("https://www.google.co.uk/maps/@51.5229,-0.0757,17z")).toMatchObject({
      kind: "coords",
      provider: "google",
      lat: 51.5229,
      lng: -0.0757,
    });
  });

  it("coordinates in q, query, ll or destination", () => {
    for (const u of [
      "https://maps.google.com/?q=51.5229,-0.0757",
      "https://www.google.com/maps/search/?api=1&query=51.5229%2C-0.0757",
      "https://maps.google.com/maps?ll=51.5229,-0.0757&z=16",
      "https://www.google.com/maps/dir/?api=1&destination=51.5229,-0.0757",
      "https://maps.google.com/?q=loc:51.5229,-0.0757",
    ]) {
      expect(parseMapInput(u), u).toMatchObject({ kind: "coords", lat: 51.5229, lng: -0.0757 });
    }
  });

  it("a place id in the URL", () => {
    expect(
      parseMapInput("https://www.google.com/maps/search/?api=1&query=Powerleague&query_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4"),
    ).toEqual({ kind: "placeId", provider: "google", placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4" });
    expect(parseMapInput("https://maps.google.com/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4")).toMatchObject({
      kind: "placeId",
    });
  });

  it("only a place name in the URL: the name is what gets looked up", () => {
    expect(
      parseMapInput("https://www.google.com/maps/place/Powerleague+Shoreditch,+Braithwaite+St,+London/data=!4m2!3m1!1s0x0:0x1"),
    ).toEqual({ kind: "text", provider: "google", text: "Powerleague Shoreditch, Braithwaite St, London" });
    expect(parseMapInput("https://maps.google.com/?q=Goals+North+Cheam&ftid=0x1:0x2")).toEqual({
      kind: "text",
      provider: "google",
      text: "Goals North Cheam",
    });
  });

  it("a short link is recognised, and is not read until it is expanded", () => {
    const got = parseMapInput("https://maps.app.goo.gl/AbCdEf123");
    expect(got.kind).toBe("short");
    expect(parseMapInput("goo.gl/maps/AbCdEf123").kind).toBe("short");
    // goo.gl is only a map link under /maps/.
    expect(parseMapInput("https://goo.gl/AbCdEf")).toEqual({ kind: "unsupported", reason: "unknown-host" });
  });

  it("a Google link that is not a map, or shows no place", () => {
    expect(parseMapInput("https://www.google.com/search?q=powerleague")).toEqual({ kind: "unsupported", reason: "unknown-host" });
    expect(parseMapInput("https://www.google.com/maps")).toEqual({ kind: "unsupported", reason: "no-location" });
  });
});

describe("the other map services", () => {
  it("Apple Maps", () => {
    expect(parseMapInput("https://maps.apple.com/?ll=51.5229,-0.0757&q=Powerleague")).toMatchObject({
      kind: "coords",
      provider: "apple",
      lat: 51.5229,
      lng: -0.0757,
    });
    expect(parseMapInput("https://maps.apple.com/place?coordinate=51.5229,-0.0757&name=Pitch")).toMatchObject({
      kind: "coords",
      provider: "apple",
    });
    expect(parseMapInput("https://maps.apple.com/?address=12+Whiston+Road,London")).toEqual({
      kind: "text",
      provider: "apple",
      text: "12 Whiston Road,London",
    });
    expect(parseMapInput("https://maps.apple/p/AbCdEf")).toEqual({ kind: "unsupported", reason: "short-link" });
  });

  it("Waze", () => {
    expect(parseMapInput("https://waze.com/ul?ll=51.5229,-0.0757&navigate=yes")).toMatchObject({
      kind: "coords",
      provider: "waze",
      lat: 51.5229,
      lng: -0.0757,
    });
    expect(parseMapInput("https://www.waze.com/live-map/directions?to=ll.51.5229%2C-0.0757")).toMatchObject({
      kind: "coords",
      provider: "waze",
    });
    expect(parseMapInput("https://waze.com/ul/hgcpvj7n3k")).toEqual({ kind: "unsupported", reason: "short-link" });
  });

  it("OpenStreetMap", () => {
    expect(parseMapInput("https://www.openstreetmap.org/?mlat=51.5229&mlon=-0.0757#map=17/51.5/-0.07")).toMatchObject({
      kind: "coords",
      provider: "osm",
      lat: 51.5229,
      lng: -0.0757,
    });
    expect(parseMapInput("https://www.openstreetmap.org/#map=17/51.5229/-0.0757")).toMatchObject({
      kind: "coords",
      provider: "osm",
      lat: 51.5229,
      lng: -0.0757,
    });
    expect(parseMapInput("https://osm.org/go/euu4~Vk")).toEqual({ kind: "unsupported", reason: "short-link" });
  });

  it("what3words has no coordinates in the link, so it is recognised and refused", () => {
    expect(parseMapInput("https://what3words.com/filled.count.soap")).toEqual({ kind: "unsupported", reason: "what3words" });
    expect(parseMapInput("https://w3w.co/filled.count.soap")).toEqual({ kind: "unsupported", reason: "what3words" });
  });
});

describe("links that are never trusted", () => {
  it("coordinates off the planet, or at 0,0", () => {
    expect(parseMapInput("https://maps.google.com/?q=91.0,10.0")).toMatchObject({ kind: "unsupported" });
    expect(parseMapInput("https://maps.google.com/?q=10.0,181.0")).toMatchObject({ kind: "unsupported" });
    expect(parseMapInput("https://maps.google.com/?q=0,0")).toMatchObject({ kind: "unsupported" });
  });

  it.each([
    ["an unknown host", "https://evil.example/maps/@51.5,-0.1,17z"],
    ["a look-alike host", "https://maps.app.goo.gl.evil.example/abc"],
    ["a look-alike suffix", "https://evilmaps.app.goo.gl/abc"],
    ["an IPv4 literal", "https://169.254.169.254/latest/meta-data"],
    ["a decimal IP", "https://2130706433/"],
    ["an IPv6 literal", "https://[::1]/maps"],
    ["localhost", "http://localhost:3000/admin"],
    ["userinfo before an allowed host", "https://maps.app.goo.gl@evil.example/abc"],
    ["userinfo on an allowed host", "https://user:pass@maps.app.goo.gl/abc"],
    ["an odd port on an allowed host", "https://maps.app.goo.gl:8443/abc"],
    ["port 80 spelled out", "https://www.google.com:80/maps/@51.5,-0.1,17z"],
    ["a trailing dot host", "https://maps.app.goo.gl./abc"],
    ["another scheme", "ftp://maps.app.goo.gl/abc"],
    ["a file URL", "file:///etc/passwd"],
    ["javascript", "javascript://maps.app.goo.gl/%0aalert(1)"],
  ])("%s is refused and never fetched", (_name, url) => {
    const got = parseMapInput(url);
    expect(got.kind).toBe("unsupported");
  });
});

describe("expanding a short Google link", () => {
  const short = () => {
    const p = parseMapInput("https://maps.app.goo.gl/AbCdEf123");
    if (p.kind !== "short") throw new Error("fixture");
    return p.url;
  };
  const redirect = (location: string | null, status = 302) =>
    new Response(null, { status, headers: location ? { location } : {} });

  it("asks the short host once, follows nothing itself, and reads the target from the Location header", async () => {
    const fetchImpl = vi.fn(async () =>
      redirect("https://www.google.com/maps/place/Powerleague+Shoreditch/@51.52,-0.07,17z/data=!3d51.5229437!4d-0.0757291"),
    );
    const got = await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got).toEqual({
      ok: true,
      target: { kind: "coords", provider: "google", lat: 51.5229437, lng: -0.0757291, label: "Powerleague Shoreditch" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://maps.app.goo.gl/AbCdEf123");
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  it("never fetches the target, even when the target is Google", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://www.google.com/maps/@51.5,-0.1,17z"));
    await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["https://maps.app.goo.gl/AbCdEf123"]);
  });

  it("the request is rebuilt from the checked parts: https, no port, no userinfo, no fragment", async () => {
    const p = parseMapInput("http://MAPS.app.goo.gl/AbCdEf123?g_st=iw#frag");
    if (p.kind !== "short") throw new Error("fixture");
    const fetchImpl = vi.fn(async () => redirect("https://www.google.com/maps/@51.5,-0.1,17z"));
    await expandShortLink(p.url, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://maps.app.goo.gl/AbCdEf123?g_st=iw");
  });

  it.each([
    ["another site", "https://evil.example/maps/@51.5,-0.1,17z"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["an internal host", "https://localhost/admin"],
    ["plain http, even to Google", "http://www.google.com/maps/@51.5,-0.1,17z"],
    ["Google with a port", "https://www.google.com:8443/maps/@51.5,-0.1,17z"],
    ["Google with userinfo", "https://a:b@www.google.com/maps/@51.5,-0.1,17z"],
    ["a look-alike of Google", "https://www.google.com.evil.example/maps/@51.5,-0.1,17z"],
    ["a Google page that is not a map", "https://www.google.com/url?q=https://evil.example"],
    ["a relative path on the short host that is not a map link", "/somewhere-else"],
  ])("a redirect to %s is refused and nothing more is fetched", async (_name, location) => {
    const fetchImpl = vi.fn(async () => redirect(location));
    const got = await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got.ok).toBe(false);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(SHORT_LINK_MAX_HOPS);
    for (const c of fetchImpl.mock.calls) {
      expect(new URL((c as unknown as [string])[0]).hostname).toMatch(/^(maps\.app\.goo\.gl|goo\.gl)$/);
    }
  });

  it("a chain that starts on the allow-list and then leaves it is refused at the hop that leaves", async () => {
    const hops = ["https://goo.gl/maps/Second", "https://evil.example/steal"];
    const fetchImpl = vi.fn(async () => redirect(hops.shift() ?? null));
    const got = await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got).toEqual({ ok: false, reason: "left-allow-list" });
    expect(fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
      "https://maps.app.goo.gl/AbCdEf123",
      "https://goo.gl/maps/Second",
    ]);
  });

  it("a chain that never ends stops after a fixed number of hops", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://maps.app.goo.gl/Again"));
    const got = await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got).toEqual({ ok: false, reason: "too-many-hops" });
    expect(fetchImpl).toHaveBeenCalledTimes(SHORT_LINK_MAX_HOPS);
  });

  it("no redirect, or a page instead of a redirect: refused, and the body is never read", async () => {
    const body = { cancel: vi.fn(async () => undefined) };
    const page = { status: 200, headers: new Headers(), body, text: vi.fn(), arrayBuffer: vi.fn(), json: vi.fn() };
    const fetchImpl = vi.fn(async () => page);
    const got = await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got).toEqual({ ok: false, reason: "no-redirect" });
    expect(body.cancel).toHaveBeenCalled();
    expect(page.text).not.toHaveBeenCalled();
    expect(page.arrayBuffer).not.toHaveBeenCalled();
    expect(page.json).not.toHaveBeenCalled();
  });

  it("an over-long Location header is refused", async () => {
    const fetchImpl = vi.fn(async () => redirect(`https://www.google.com/maps/@51.5,-0.1,17z?x=${"a".repeat(5000)}`));
    expect(await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      ok: false,
      reason: "left-allow-list",
    });
  });

  it("a slow host is cut off by the timeout and nothing is thrown", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const started = Date.now();
    const got = await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 50 });
    expect(got).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a target with nothing to read", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://www.google.com/maps"));
    expect(await expandShortLink(short(), { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      ok: false,
      reason: "no-location",
    });
  });

  it("a URL that is not a short link is refused before any request", async () => {
    const fetchImpl = vi.fn();
    const got = await expandShortLink(new URL("https://evil.example/abc"), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got).toEqual({ ok: false, reason: "left-allow-list" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
