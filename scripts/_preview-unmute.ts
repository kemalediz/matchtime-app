/* Local-sandbox preview runner. Calls the real /api/whatsapp/due-posts GET
 * handler against the embedded Postgres copy. No prod, no model. */
const T0 = process.argv[2];
const polls = (process.argv[3] ?? `${T0}`).split(",");
if (!process.env.DATABASE_URL?.includes("127.0.0.1:55871")) throw new Error("not the sandbox DB");
process.env.MT_TEST_MODE = "1";
process.env.WHATSAPP_API_KEY = "preview-key";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTH_SECRET = "preview-dummy-secret-not-prod-0123456789abcdef";
delete process.env.NEXTAUTH_URL;
const realFetch = globalThis.fetch;
const external: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  external.push(u);
  throw new Error(`[preview] blocked outbound fetch: ${u}`);
}) as typeof fetch;
void realFetch;
async function main() {
  const { GET } = await import("../src/app/api/whatsapp/due-posts/route");
  for (const t of polls) {
    const req = new Request(`http://localhost/api/whatsapp/due-posts?groupId=${encodeURIComponent("120363418762991368@g.us")}`, {
      headers: { "x-api-key": "preview-key", "x-test-now": t, "x-mt-platform-jobs": "1", "x-mt-pi-caps": "admin-group,quoted-id" },
    });
    const res = await GET(req);
    const body = await res.json();
    console.log(`===POLL ${t} status=${res.status}`);
    console.log(JSON.stringify(body, null, 1));
  }
  console.log(`===EXTERNAL_FETCHES ${JSON.stringify(external)}`);
  process.exit(0);
}
main().catch((e) => { console.error("RUNNER FAILED", e); process.exit(1); });
