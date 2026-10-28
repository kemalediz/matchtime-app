/**
 * /admin/settings is tabs of collapsible cards (2026-10-28). Specs that
 * work with a card open it the way an organiser does: its tab, then its
 * header. Card ids and tabs come from the app's own map.
 */
import { expect, type Page } from "@playwright/test";
import { SETTINGS_TABS, tabOfCard, type SettingsCardId, type SettingsTab } from "@/lib/settings-anchors";

/** Show `tab`. */
export async function openSettingsTab(page: Page, tab: SettingsTab): Promise<void> {
  const button = page.getByTestId(`settings-tab-${tab}`);
  await button.click({ timeout: 30_000 });
  await expect(button).toHaveAttribute("aria-selected", "true");
}

/** Show the card's tab and expand the card (waiting for it to load). */
export async function openSettingsCard(page: Page, id: SettingsCardId): Promise<void> {
  await openSettingsTab(page, tabOfCard(id));
  const toggle = page.getByTestId(`settings-card-toggle-${id}`);
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** Expand every card on `tab` (the ones this club has). */
export async function expandSettingsTab(page: Page, tab: SettingsTab): Promise<void> {
  await openSettingsTab(page, tab);
  const toggles = page.getByTestId(`settings-panel-${tab}`).locator('[data-testid^="settings-card-toggle-"]');
  for (const toggle of await toggles.all()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
}

export { SETTINGS_TABS };
