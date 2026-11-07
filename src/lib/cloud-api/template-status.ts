/**
 * META'S TEMPLATE WEBHOOKS, WRITTEN (Cloud API plan 5.2 and 5.6, PR C6).
 * The thin adapter over `template-status-rules.ts`: one `CloudTemplateStatus`
 * upsert per change, keyed by (name, language). The webhook route (PR C5)
 * calls it after the signature check. Never throws: a row that fails is
 * logged (name and language only) and the others are still written. An
 * upcoming re-categorisation is logged and counted for the owner
 * dashboard (PR C8); nobody is messaged.
 */
import { db } from "../db";
import { templateStatusChanges } from "./template-status-rules";

export type TemplateStatusClient = Pick<typeof db, "cloudTemplateStatus">;

export async function applyTemplateStatusPayload(
  payload: unknown,
  client: TemplateStatusClient = db,
): Promise<{ written: number; failed: number; upcoming: number }> {
  const out = { written: 0, failed: 0, upcoming: 0 };
  for (const c of templateStatusChanges(payload)) {
    if (c.kind === "category-upcoming") {
      out.upcoming++;
      console.log(`[cloud-templates] ${c.name} ${c.language}: Meta will move it from ${c.currentCategory ?? "?"} to ${c.correctCategory}${c.at ? ` on ${c.at.toISOString()}` : ""}`);
      continue;
    }
    try {
      await client.cloudTemplateStatus.upsert({
        where: { name_language: { name: c.name, language: c.language } },
        create: { name: c.name, language: c.language, ...c.create },
        update: c.update,
      });
      out.written++;
      console.log(`[cloud-templates] ${c.name} ${c.language}: ${c.update.status ?? `category ${c.update.category}`}`);
    } catch (err) {
      out.failed++;
      console.error(`[cloud-templates] ${c.name} ${c.language}: status not written:`, err instanceof Error ? err.message : "failed");
    }
  }
  return out;
}
