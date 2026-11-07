/**
 * THE OFFICIAL NUMBER'S TEMPLATES: CODE AGAINST META (Cloud API plan 5.6,
 * PR C6). Lists every template on the WhatsApp Business Account, compares
 * it with `src/lib/cloud-api/templates.ts` and prints the difference.
 *
 *   npx tsx scripts/cloud-templates.ts            # dry run: reads, prints, sends nothing
 *   npx tsx scripts/cloud-templates.ts --apply    # submits the new and edits the changed
 *
 * `--apply` needs Kemal's go for that run: Meta reviews each submission
 * and a template rejected or re-categorised stays that way until edited
 * (plan section 6, items 1 and 2). Nothing is ever deleted.
 *
 * Reads WA_CLOUD_WABA_ID, WA_CLOUD_ACCESS_TOKEN and WA_CLOUD_GRAPH_VERSION
 * (default v26.0) from the environment or the repo-root `.env`. Submitting
 * a template costs nothing; only sends are charged. No model calls.
 */
import { config as loadEnv } from "dotenv";
import { parseSyncArgs, syncTemplates } from "../src/lib/cloud-api/template-sync";

loadEnv({ quiet: true });

async function main(): Promise<void> {
  const { apply } = parseSyncArgs(process.argv.slice(2));
  const r = await syncTemplates({ fetch: globalThis.fetch, env: process.env, apply, log: (l) => console.log(l) });
  if (apply) console.log(`Done: ${r.applied.length} submitted, ${r.skipped.length} skipped, ${r.failed.length} failed.`);
  if (r.failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
