import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("profile", {});
const page = context.pages()[0];
await page.mouse.click(10, 10);
