/**
 * End-to-end onboarding test against the DEPLOYED server (which has
 * ANTHROPIC_API_KEY — local .env doesn't). Mimics exactly what the
 * bot forwards: one POST per user message to /api/whatsapp/analyze
 * with a synthetic groupId. Prints the bot's reply each turn. No
 * WhatsApp group needed; exercises the real onboarding router + LLM
 * extraction + org/sport/activity/match creation in production.
 *
 *   node --env-file=.env --import tsx scripts/sim-onboarding-remote.ts
 *
 * Afterwards it prints the created org slug; wipe it with:
 *   node --env-file=.env --import tsx scripts/wipe-org.ts <slug> --apply
 *
 * Override target with MATCHTIME_API_URL (defaults to prod).
 */
const API = process.env.MATCHTIME_API_URL || "https://matchtime.ai";
const KEY = process.env.WHATSAPP_API_KEY!;
if (!KEY) {
  console.error("WHATSAPP_API_KEY missing from env");
  process.exit(1);
}

const SCRIPT: string[] = [
  "@MatchTime setup",
  "we're the Thursday Ballers",
  "7 a side",
  "thursdays",
  "8:30pm",
  "PowerLeague Shoreditch",
  "every week",
  "just Man of the Match and player ratings please",
];

async function main() {
  const groupId = `sim-remote-${Date.now().toString(36)}@g.us`;
  console.log(`Target: ${API}\nSynthetic group: ${groupId}\n${"=".repeat(60)}`);

  let seq = 0;
  for (const body of SCRIPT) {
    const payload = {
      groupId,
      messages: [
        {
          waMessageId: `sim-${groupId}-${seq++}`,
          body,
          authorPhone: "",
          authorName: "Tester",
          timestamp: new Date().toISOString(),
        },
      ],
      history: [],
    };
    const res = await fetch(`${API}/api/whatsapp/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as {
      results?: Array<{ reply: string | null; intent?: string }>;
      ignored?: string;
    };
    console.log(`\n🧑  ${body}`);
    const reply = json.results?.find((r) => r.reply)?.reply ?? null;
    if (reply) console.log(`🤖  ${reply.replace(/\n/g, "\n    ")}`);
    else console.log(`🤖  (silent)  ${json.ignored ? `[ignored: ${json.ignored}]` : ""}`);
    // Small gap so the rows commit in order (lastHandledWaId dedupe).
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(
    `\n${"=".repeat(60)}\nDone. Find the created org:\n` +
      `  node --env-file=.env --import tsx scripts/wipe-org.ts --list\n` +
      `Then remove the test org:\n` +
      `  node --env-file=.env --import tsx scripts/wipe-org.ts <slug> --apply`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
