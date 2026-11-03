import { describe, expect, it } from "vitest";
import {
  Cassette,
  CassetteMissError,
  type RecordedCall,
  normaliseRequest,
  normaliseVolatileText,
  packCassette,
  requestKey,
  unpackCassette,
} from "./cassette";

const req = (over: Record<string, unknown> = {}) => ({
  model: "claude-haiku-5-5",
  max_tokens: 1024,
  system: [{ type: "text", text: "You are the front door of MatchTime.", cache_control: { type: "ephemeral", ttl: "1h" } }],
  messages: [{ role: "user", content: "[m1] Ann: IN" }],
  ...over,
});

const call = (body: Record<string, unknown>, text: string, status = 200): RecordedCall => ({
  request: body,
  status,
  body: JSON.stringify({ model: body.model, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 2 } }),
});

describe("requestKey", () => {
  it("is stable across key order and ignores transport-only fields", () => {
    const a = req();
    const b = { messages: a.messages, system: a.system, max_tokens: 1024, model: a.model, stream: false, metadata: { user_id: "x" } };
    expect(requestKey(a)).toBe(requestKey(b));
  });

  it("changes when the prompt changes", () => {
    expect(requestKey(req())).not.toBe(requestKey(req({ messages: [{ role: "user", content: "[m1] Ann: OUT" }] })));
    expect(requestKey(req())).not.toBe(
      requestKey(req({ system: [{ type: "text", text: "You are the front door of MatchTime!" }] })),
    );
  });

  it("changes when the model, the schema or the token ceiling changes", () => {
    expect(requestKey(req())).not.toBe(requestKey(req({ model: "claude-sonnet-5" })));
    expect(requestKey(req())).not.toBe(requestKey(req({ output_config: { format: { type: "json_schema", schema: {} } } })));
    expect(requestKey(req())).not.toBe(requestKey(req({ max_tokens: 2048 })));
  });

  it("does not change for a per-run id, a link token or a seconds-level timestamp in the prompt", () => {
    const a = req({ messages: [{ role: "user", content: "user cmhx0abcdefghijklmnopqrst rate at https://mt.test/r/Ab3dEf9hJk at 2027-01-08T10:30:12.345Z" }] });
    const b = req({ messages: [{ role: "user", content: "user cmhy9zyxwvutsrqponmlkjihg rate at https://mt.test/r/Zz9yXx8wVv at 2027-01-08T10:30:41.001Z" }] });
    expect(requestKey(a)).toBe(requestKey(b));
  });
});

describe("normaliseVolatileText", () => {
  it("masks cuids, uuids, link tokens and sub-minute time", () => {
    expect(normaliseVolatileText("id cmhx0abcdefghijklmnopqrst")).toBe("id <id>");
    expect(normaliseVolatileText("u 123e4567-e89b-12d3-a456-426614174000")).toBe("u <uuid>");
    expect(normaliseVolatileText("go https://localhost:3471/r/Ab3dEf9hJk?x=1 now")).toBe("go <app>/r/<tok> now");
    expect(normaliseVolatileText("2027-01-08T10:30:12.345Z")).toBe("2027-01-08T10:30Z");
  });

  it("keeps ordinary words, names and minute-level times intact", () => {
    const s = "Friday 20:30, Ann Archer is IN. Kickoff 2027-01-08 20:30.";
    expect(normaliseVolatileText(s)).toBe(s);
  });
});

describe("the app's address (it changes with MT_E2E_APP_PORT)", () => {
  it("becomes <app> whatever the port, host spelling or scheme", () => {
    expect(normaliseVolatileText("http://localhost:3471/r/iCSqhP4Vrk")).toBe("<app>/r/<tok>");
    expect(normaliseVolatileText("http://localhost:3472/r/gfvVRSbFg8")).toBe("<app>/r/<tok>");
    expect(normaliseVolatileText("http://127.0.0.1:3999/admin/matches/cmhx0abcdefghijklmnopqrst/cancel")).toBe("<app>/admin/<tok>");
    // A link with one path segment has no token, but its port is still masked.
    expect(normaliseVolatileText("Or sign up here: http://localhost:3471/month.")).toBe("Or sign up here: <app>/month.");
    expect(normaliseVolatileText("personal link:\nhttp://localhost:3472/r/XiyEAPf9P\nbye")).toBe("personal link:\n<app>/r/<tok>\nbye");
  });

  it("is masked when it follows a JSON-escaped newline (a prompt that quotes an earlier message)", () => {
    // In the request the text holds a backslash and an n, then the link: no word boundary before "http".
    const quoted = String.raw`"Pay Colin directly):\nhttp://localhost:3472/r/XiyEAPf9P can also pay"`;
    expect(normaliseVolatileText(quoted)).toBe(String.raw`"Pay Colin directly):\n<app>/r/<tok> can also pay"`);
    expect(normaliseVolatileText(String.raw`sign up:\nhttp://localhost:3471/month`)).toBe(String.raw`sign up:\n<app>/month`);
  });

  it("leaves other hosts alone", () => {
    expect(normaliseVolatileText("https://matchtime.app/month")).toBe("https://matchtime.app/month");
    expect(normaliseVolatileText("http://localhost.example.com:3471/month")).toBe("http://localhost.example.com:3471/month");
  });

  it("is idempotent, so a transcript normalised twice does not change", () => {
    const once = normaliseVolatileText("go http://localhost:3471/r/Ab3dEf9hJk now");
    expect(normaliseVolatileText(once)).toBe(once);
  });

  it("does not change a request's key: a recording made on one port replays on another", () => {
    const on = (port: number) =>
      req({ messages: [{ role: "user", content: `Pay Colin directly:\nhttp://localhost:${port}/r/Tok${port}x and sign up at http://localhost:${port}/month` }] });
    expect(requestKey(on(3472))).toBe(requestKey(on(3471)));
    const cassette = new Cassette([call(on(3471), "ok")]);
    expect(JSON.parse(cassette.take(on(3472)).body).content[0].text).toBe("ok");
    expect(cassette.stats()).toMatchObject({ hits: 1, misses: 0, reordered: 0 });
  });

  it("does not hide a real difference next to the address", () => {
    const a = req({ messages: [{ role: "user", content: "sign up at http://localhost:3471/month" }] });
    const b = req({ messages: [{ role: "user", content: "sign up at http://localhost:3472/months" }] });
    expect(requestKey(a)).not.toBe(requestKey(b));
  });
});

describe("normaliseRequest", () => {
  it("keeps only the fields that decide the answer", () => {
    expect(Object.keys(normaliseRequest({ ...req(), stream: false, metadata: {} }) as object).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "system",
    ]);
  });
});

describe("Cassette", () => {
  it("serves each recorded answer in the order it was recorded, per request", () => {
    const c = new Cassette([call(req(), "first"), call(req({ model: "claude-sonnet-5" }), "other"), call(req(), "second")]);
    expect(JSON.parse(c.take(req()).body).content[0].text).toBe("first");
    expect(JSON.parse(c.take(req()).body).content[0].text).toBe("second");
    expect(JSON.parse(c.take(req({ model: "claude-sonnet-5" })).body).content[0].text).toBe("other");
    expect(c.stats()).toMatchObject({ hits: 3, repeats: 0, misses: 0 });
  });

  it("serves the last answer again when a request comes more often than it was recorded, and counts it", () => {
    const c = new Cassette([call(req(), "only")]);
    c.take(req());
    expect(JSON.parse(c.take(req()).body).content[0].text).toBe("only");
    expect(c.stats()).toMatchObject({ hits: 1, repeats: 1, misses: 0 });
  });

  it("FAILS on a request it never saw, and names what was asked and the nearest recorded request", () => {
    const c = new Cassette([call(req(), "x")]);
    const changed = req({ messages: [{ role: "user", content: "[m1] Ann: OUT" }] });
    let err: unknown;
    try {
      c.take(changed);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CassetteMissError);
    const miss = (err as CassetteMissError).miss;
    expect(miss.model).toBe("claude-haiku-5-5");
    expect(miss.key).toBe(requestKey(changed));
    expect(miss.nearest?.key).toBe(requestKey(req()));
    expect(miss.firstDifference).toContain("OUT");
    expect(c.stats().misses).toBe(1);
    expect(c.missList()).toHaveLength(1);
  });

  it("serves a request whose only difference is the ORDER of its lines, and reports it as reordered, not as a hit", () => {
    const recorded = req({ messages: [{ role: "user", content: "RECENT:\n  MatchTime: Adding Nabil\n  Hamzah: updated list\nNOW: Tue" }] });
    const asked = req({ messages: [{ role: "user", content: "RECENT:\n  Hamzah: updated list\n  MatchTime: Adding Nabil\nNOW: Tue" }] });
    const c = new Cassette([call(recorded, "ok")]);
    expect(JSON.parse(c.take(asked).body).content[0].text).toBe("ok");
    expect(c.stats()).toMatchObject({ hits: 0, reordered: 1, misses: 0 });
    expect(c.reorderedList()[0].site).toContain("front door");
  });

  it("still misses when a line's words changed, whatever the order", () => {
    const recorded = req({ messages: [{ role: "user", content: "A\nB" }] });
    const c = new Cassette([call(recorded, "ok")]);
    expect(() => c.take(req({ messages: [{ role: "user", content: "B\nA!" }] }))).toThrow(CassetteMissError);
  });

  it("re-keys from the stored request when loaded, so a better normaliser needs no re-recording", () => {
    const packed = packCassette({ club: "x", calls: [call(req(), "a")], meter: { calls: 1, costUsd: 0.01 } });
    const stored = JSON.parse(JSON.stringify(packed));
    // Tamper with the stored key: it must be ignored.
    stored.entries[0].key = "stale";
    const c = new Cassette(unpackCassette(stored).calls);
    expect(JSON.parse(c.take(req()).body).content[0].text).toBe("a");
  });
});

describe("packCassette / unpackCassette", () => {
  it("stores each long prompt once and restores the calls exactly", () => {
    const long = "S".repeat(5000);
    const calls = [
      call(req({ system: [{ type: "text", text: long }] }), "a"),
      call(req({ system: [{ type: "text", text: long }], messages: [{ role: "user", content: "two" }] }), "b"),
    ];
    const packed = packCassette({ club: "c", calls, meter: { calls: 2, costUsd: 0 } });
    expect(Object.keys(packed.blobs)).toHaveLength(1);
    expect(JSON.stringify(packed).length).toBeLessThan(long.length * 1.5);
    expect(unpackCassette(packed).calls).toEqual(calls);
  });
});
