import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("profile", {});
const page = context.pages()[0];
const invoke = page.click;
await invoke("#login");
