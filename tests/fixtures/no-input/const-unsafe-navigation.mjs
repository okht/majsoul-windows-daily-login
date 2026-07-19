import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("profile", {});
const page = context.pages()[0];
const url = "javascript:alert(1)";
await page.goto(url);
