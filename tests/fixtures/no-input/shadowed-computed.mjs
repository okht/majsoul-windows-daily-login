import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("profile", {});
const page = context.pages()[0];
const key = "click";
{
  const key = "title";
  void key;
}
await page[key]();
