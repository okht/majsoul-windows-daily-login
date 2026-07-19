import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("profile", {});
const page = context.pages()[0];
const navigate = page.goto;
await navigate("https://game.maj-soul.com/1/");
