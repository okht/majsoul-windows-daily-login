import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("profile", {});
await context.newCDPSession(context.pages()[0]);
