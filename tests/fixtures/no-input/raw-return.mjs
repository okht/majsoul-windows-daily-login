import { chromium } from "playwright-core";
export async function leak() {
  const context = await chromium.launchPersistentContext("profile", {});
  return context.pages()[0];
}
