import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditNoInputProject,
  auditSourceSet,
  grepForbiddenSource
} from "../scripts/lib/no-input-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.dirname(HERE);
const FIXTURES = path.join(HERE, "fixtures", "no-input");
const scratch = [];

async function fixture(name) {
  return readFile(path.join(FIXTURES, name + ".mjs"), "utf8");
}

function logicalPassiveEdge(source) {
  return new Map([["src/browser/passive-edge.mjs", source]]);
}

function passiveGuardFixture(guardPlacement) {
  const guard = `if (
      url !== TARGET &&
      !(this.#allowLoopback && isSafeLoopbackTarget(url))
    ) {
      throw targetRejected();
    }`;
  const before = guardPlacement === "before" ? guard : "";
  const after = guardPlacement === "after" ? guard : "";
  return `import { chromium } from "playwright-core";
const TARGET = "https://game.maj-soul.com/1/";
function isSafeLoopbackTarget() { return false; }
function targetRejected() { return new Error("rejected"); }
export class PassiveEdge {
  #browser;
  #allowLoopback;
  #context;
  #page;
  constructor() {
    this.#browser = chromium;
    this.#allowLoopback = true;
  }
  async open(url) {
    ${before}
    this.#context = await this.#browser.launchPersistentContext("profile", {
      channel: "msedge",
      headless: true,
      viewport: { width: 1, height: 1 }
    });
    this.#page = this.#context.pages()[0] ?? await this.#context.newPage();
    await this.#page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 1000
    });
    ${after}
  }
}
`;
}

async function temporaryProject(files) {
  const root = await mkdtemp(path.join(tmpdir(), "majsoul-no-input-"));
  scratch.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("zero-input AST policy", () => {
  it.each([
    ["direct-click", "PW_MEMBER_FORBIDDEN"],
    ["optional-click", "PW_OPTIONAL_FORBIDDEN"],
    ["bracket-click", "PW_MEMBER_FORBIDDEN"],
    ["escaped-click", "PW_MEMBER_FORBIDDEN"],
    ["concatenated-click", "PW_MEMBER_FORBIDDEN"],
    ["const-key-click", "PW_MEMBER_FORBIDDEN"],
    ["destructured-click", "PW_MEMBER_FORBIDDEN"],
    ["aliased-click", "PW_MEMBER_FORBIDDEN"],
    ["mouse-controller", "PW_MEMBER_FORBIDDEN"],
    ["keyboard-controller", "PW_MEMBER_FORBIDDEN"],
    ["evaluate", "PW_MEMBER_FORBIDDEN"],
    ["cdp", "PW_MEMBER_FORBIDDEN"],
    ["route", "PW_MEMBER_FORBIDDEN"],
    ["select", "PW_MEMBER_FORBIDDEN"],
    ["drag", "PW_MEMBER_FORBIDDEN"],
    ["raw-return", "PW_RAW_ESCAPE"],
    ["unresolved-computed", "PW_COMPUTED_UNKNOWN"],
    ["unsafe-navigation", "PW_NAVIGATION_UNSAFE"],
    ["const-unsafe-navigation", "PW_NAVIGATION_UNSAFE"]
  ])("rejects seeded capability %s with a bounded diagnostic", async (
    name,
    code
  ) => {
    const diagnostics = auditSourceSet(logicalPassiveEdge(await fixture(name)), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });

    expect(diagnostics.map((entry) => entry.code)).toContain(code);
    expect(diagnostics).toEqual([...diagnostics].sort((left, right) =>
      `${left.file}:${String(left.line).padStart(8, "0")}:${String(left.column).padStart(8, "0")}:${left.code}`
        .localeCompare(`${right.file}:${String(right.line).padStart(8, "0")}:${String(right.column).padStart(8, "0")}:${right.code}`)
    ));
    expect(diagnostics.every((entry) =>
      /^[A-Z0-9_]{1,40}$/u.test(entry.code) &&
      Number.isInteger(entry.line) &&
      Number.isInteger(entry.column)
    )).toBe(true);
  });

  it("rejects every tainted computed member despite lexical const shadowing", async () => {
    const diagnostics = auditSourceSet(
      logicalPassiveEdge(await fixture("shadowed-computed")),
      { automatedEntries: ["src/browser/passive-edge.mjs"] }
    );
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_COMPUTED_FORBIDDEN"
    );
  });

  it.each([
    "array-push-handle",
    "map-set-handle"
  ])("rejects a raw handle hidden through %s", async (name) => {
    const diagnostics = auditSourceSet(
      logicalPassiveEdge(await fixture(name)),
      { automatedEntries: ["src/browser/passive-edge.mjs"] }
    );
    expect(diagnostics.map((entry) => entry.code)).toContain("PW_RAW_ESCAPE");
  });

  it("rejects an allowed Playwright method extracted as an alias", async () => {
    const diagnostics = auditSourceSet(
      logicalPassiveEdge(await fixture("allowed-method-alias")),
      { automatedEntries: ["src/browser/passive-edge.mjs"] }
    );
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_MEMBER_REFERENCE"
    );
  });

  it.each([
    ["dynamic import", "await import(\"playwright-core\");", "DYNAMIC_IMPORT_FORBIDDEN"],
    ["require", "require(\"playwright-core\");", "DYNAMIC_REQUIRE_FORBIDDEN"],
    ["createRequire", "createRequire(import.meta.url);", "DYNAMIC_REQUIRE_FORBIDDEN"],
    [
      "Module.createRequire alias",
      `import Module from "node:module";
const req = Module.createRequire(import.meta.url);
req("playwright");`,
      "DYNAMIC_REQUIRE_FORBIDDEN"
    ],
    ["eval", "eval(\"1\");", "DYNAMIC_ESCAPE_FORBIDDEN"],
    ["Function", "Function(\"return 1\")();", "DYNAMIC_ESCAPE_FORBIDDEN"],
    ["Reflect.get", "Reflect.get({}, \"x\");", "DYNAMIC_ESCAPE_FORBIDDEN"],
    ["Reflect.apply", "Reflect.apply(() => 1, null, []);", "DYNAMIC_ESCAPE_FORBIDDEN"],
    ["descriptor", "Object.getOwnPropertyDescriptor({}, \"x\");", "DYNAMIC_ESCAPE_FORBIDDEN"],
    ["builtin module", "process.getBuiltinModule(\"fs\");", "DYNAMIC_ESCAPE_FORBIDDEN"],
    ["aliased reflection", "const getter = Reflect.get; getter({}, \"x\");", "DYNAMIC_ESCAPE_FORBIDDEN"],
    ["aliased eval", "const execute = eval; execute(\"1\");", "DYNAMIC_ESCAPE_FORBIDDEN"],
    [
      "indirect Function constructor",
      `const F = (() => {}).constructor;
F("return globalThis")();`,
      "DYNAMIC_ESCAPE_FORBIDDEN"
    ],
    [
      "aliased process builtin acquisition",
      `const runtime = process;
const Module = runtime.getBuiltinModule("module");
void Module;`,
      "DYNAMIC_ESCAPE_FORBIDDEN"
    ],
    [
      "destructured process builtin acquisition",
      `const { getBuiltinModule } = process;
const Module = getBuiltinModule("module");
void Module;`,
      "DYNAMIC_ESCAPE_FORBIDDEN"
    ],
    [
      "destructured Function constructor",
      `const { constructor: F } = (() => {});
F("return globalThis")();`,
      "DYNAMIC_ESCAPE_FORBIDDEN"
    ]
  ])("rejects %s anywhere in the automated graph", (_name, body, code) => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import "../safe.mjs";\n${body}\n`],
      ["src/safe.mjs", "export const safe = true;\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(code);
  });

  it.each([
    ["global alias", "const root = globalThis; root.eval(\"1\");", "DYNAMIC_GLOBAL_FORBIDDEN"],
    ["window alias", "const root = window; root[\"eval\"](\"1\");", "DYNAMIC_GLOBAL_FORBIDDEN"],
    ["indirect eval", "(0, eval)(\"1\");", "DYNAMIC_ESCAPE_FORBIDDEN"]
  ])("rejects %s capability acquisition", (_name, body, code) => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", body + "\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(code);
  });

  it.each([
    ["../../outside.mjs", "IMPORT_TRAVERSAL"],
    ["file:///C:/outside.mjs", "IMPORT_ABSOLUTE"],
    ["C:/outside.mjs", "IMPORT_ABSOLUTE"],
    ["data:text/javascript,globalThis.compromised=true", "IMPORT_ABSOLUTE"],
    ["#unsafe", "IMPORT_ALIAS_FORBIDDEN"],
    ["../safe.mjs?raw", "IMPORT_SUFFIX_FORBIDDEN"],
    ["../safe.mjs#hash", "IMPORT_SUFFIX_FORBIDDEN"],
    ["../missing.mjs", "IMPORT_MISSING"]
  ])("fails closed for graph import %s", (specifier, code) => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import ${JSON.stringify(specifier)};\n`],
      ["src/safe.mjs", "export const safe = true;\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(code);
  });

  it("rejects malformed modules and newly reached CLI modules", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", "import \"./surprise.mjs\";\nexport const = ;"],
      ["src/cli/surprise.mjs", "export const visible = true;\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain("PARSE_ERROR");
    expect(diagnostics.map((entry) => entry.code)).toContain("AUTOMATED_CLI_FORBIDDEN");
  });

  it("allows Playwright only in PassiveEdge and sharp only in fingerprint", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", "import { chromium } from \"playwright-core\";\nimport sharp from \"sharp\";\n"],
      ["src/browser/passive-edge.mjs", "import playwright from \"playwright-core\";\n"],
      ["src/browser/fingerprint.mjs", "export { default as sharp } from \"sharp\";\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "PLAYWRIGHT_IMPORT_BOUNDARY",
      "PLAYWRIGHT_IMPORT_SHAPE",
      "SHARP_IMPORT_BOUNDARY",
      "SHARP_IMPORT_SHAPE"
    ]));
  });

  it("rejects a namespace import of the PassiveEdge wrapper", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import * as Edge from "../browser/passive-edge.mjs";
new Edge.PassiveEdge({ profileDir: "p", browser: {}, allowLoopback: true });
`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_IMPORT_SHAPE"
    );
  });

  it("rejects an intermediate re-export of the PassiveEdge wrapper", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { PassiveEdge } from "../edge-wrapper.mjs";
new PassiveEdge({ profileDir: "p", browser: {}, allowLoopback: true });
`],
      ["src/edge-wrapper.mjs", `export { PassiveEdge } from "./browser/passive-edge.mjs";\n`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_REEXPORT_FORBIDDEN"
    );
  });

  it("rejects a locally imported PassiveEdge wrapper re-export", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { PassiveEdge } from "../edge-wrapper.mjs";
new PassiveEdge({ profileDir: "p", headless: true });
`],
      ["src/edge-wrapper.mjs", `import { PassiveEdge } from "./browser/passive-edge.mjs";
export { PassiveEdge };
`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_REEXPORT_FORBIDDEN"
    );
  });

  it("rejects a PassiveEdge export declaration alias", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { Edge } from "../edge-wrapper.mjs";
new Edge({ profileDir: "p", headless: true });
`],
      ["src/edge-wrapper.mjs", `import { PassiveEdge } from "./browser/passive-edge.mjs";
export const Edge = PassiveEdge;
`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_REEXPORT_FORBIDDEN"
    );
  });

  it("rejects a locally aliased PassiveEdge re-export", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { Edge } from "../edge-wrapper.mjs";
new Edge({ profileDir: "p", headless: true });
`],
      ["src/edge-wrapper.mjs", `import { PassiveEdge } from "./browser/passive-edge.mjs";
const Edge = PassiveEdge;
export { Edge };
`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_REEXPORT_FORBIDDEN"
    );
  });

  it.each([
    [
      "container assignment",
      `const box = {};
box.Edge = PassiveEdge;
export { box };`
    ],
    [
      "exported getter function",
      `function getEdge() { return PassiveEdge; }
export { getEdge };`
    ]
  ])("rejects PassiveEdge escape through %s", (_label, wrapperBody) => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", "import '../edge-wrapper.mjs';\n"],
      ["src/edge-wrapper.mjs", `import { PassiveEdge } from "./browser/passive-edge.mjs";
${wrapperBody}
`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_REEXPORT_FORBIDDEN"
    );
  });

  it.each([
    "playwright",
    "playwright-core/lib/server",
    "@playwright/test",
    "puppeteer",
    "puppeteer-core",
    "selenium-webdriver",
    "webdriverio",
    "@wdio/cli"
  ])("rejects alternate automation package import %s", (packageName) => {
    const diagnostics = auditSourceSet(new Map([
      ["src/safe.mjs", `import automation from ${JSON.stringify(packageName)};\nvoid automation;\n`]
    ]), { automatedEntries: ["src/safe.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "AUTOMATION_PACKAGE_FORBIDDEN"
    );
  });

  it("rejects an alternate automation package re-export", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/safe.mjs", `export * from "puppeteer";\n`]
    ]), { automatedEntries: ["src/safe.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "AUTOMATION_PACKAGE_FORBIDDEN"
    );
  });

  it.each([
    "browser",
    "allowLoopback",
    "unknown"
  ])("rejects PassiveEdge constructor key %s in the automated graph", (key) => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { PassiveEdge } from \"../browser/passive-edge.mjs\";\nnew PassiveEdge({ profileDir: \"p\", ${key}: true });\n`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_CONSTRUCTOR"
    );
  });

  it.each([
    "new PassiveEdge(options);",
    "new PassiveEdge({ profileDir: \"p\", ...options });",
    "new PassiveEdge({ [key]: value });"
  ])("rejects opaque PassiveEdge constructor arguments: %s", (statement) => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { PassiveEdge } from \"../browser/passive-edge.mjs\";\n${statement}\n`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_CONSTRUCTOR"
    );
  });

  it.each([
    ["await page.screenshot({ path: \"capture.png\" });", "PW_ARGUMENT_FORBIDDEN"],
    ["await page.screenshot({ ...options });", "PW_ARGUMENT_FORBIDDEN"],
    ["await browser.launchPersistentContext(\"p\", { channel: \"msedge\", proxy: {} });", "PW_ARGUMENT_FORBIDDEN"],
    ["await browser.launchPersistentContext(\"p\", { ...options });", "PW_ARGUMENT_FORBIDDEN"],
    ["await browser.launchPersistentContext(\"p\", { channel: \"chrome\" });", "PW_ARGUMENT_FORBIDDEN"],
    ["await browser.launchPersistentContext(\"p\", { viewport: { width: 1, ...options } });", "PW_ARGUMENT_FORBIDDEN"]
  ])("validates arguments of allowed Playwright calls: %s", (statement, code) => {
    const source = `import { chromium } from \"playwright-core\";\nconst browser = chromium;\nconst context = await browser.launchPersistentContext(\"p\", { channel: \"msedge\", headless: true, viewport: { width: 1, height: 1 } });\nconst page = context.pages()[0];\nconst options = {};\n${statement}\n`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(code);
  });

  it.each([
    ["missing", ""],
    ["after goto", "after"]
  ])("rejects an open(url) target guard that is %s", (_label, placement) => {
    const diagnostics = auditSourceSet(
      logicalPassiveEdge(passiveGuardFixture(placement)),
      { automatedEntries: ["src/browser/passive-edge.mjs"] }
    );
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_NAVIGATION_GUARD"
    );
  });

  it("accepts the exact conservative target guard before goto", () => {
    const diagnostics = auditSourceSet(
      logicalPassiveEdge(passiveGuardFixture("before")),
      { automatedEntries: ["src/browser/passive-edge.mjs"] }
    );
    expect(diagnostics.map((entry) => entry.code)).not.toContain(
      "PW_NAVIGATION_GUARD"
    );
    expect(diagnostics.map((entry) => entry.code)).not.toContain(
      "PW_NAVIGATION_UNSAFE"
    );
  });

  it.each([
    [
      "reassigned after validation",
      passiveGuardFixture("before").replace(
        "    this.#context = await",
        "    url = \"javascript:alert(1)\";\n    this.#context = await"
      )
    ],
    [
      "shadowed by a nested function",
      passiveGuardFixture("before").replace(
        `    await this.#page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 1000
    });`,
        `    async function navigate(url) {
      await this.#page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 1000
      });
    }
    void navigate;`
      )
    ]
  ])("rejects a guarded URL that is %s", (_label, source) => {
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_NAVIGATION_GUARD"
    );
  });

  it.each([
    ["TARGET", "const TARGET = url;"],
    [
      "isSafeLoopbackTarget",
      "const isSafeLoopbackTarget = () => true;"
    ]
  ])("rejects a guard with a method-local %s binding", (_name, declaration) => {
    const source = passiveGuardFixture("before").replace(
      "  async open(url) {",
      `  async open(url) {\n    ${declaration}`
    );
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_NAVIGATION_GUARD"
    );
  });

  it.each([
    [
      "conditionally nested throw",
      passiveGuardFixture("before").replace(
        "throw targetRejected();",
        "if (false) throw targetRejected();"
      )
    ],
    [
      "caught throw",
      passiveGuardFixture("before").replace(
        "throw targetRejected();",
        "try { throw targetRejected(); } catch {}"
      )
    ],
    [
      "block-shadowed URL",
      passiveGuardFixture("before").replace(
        "    await this.#page.goto(url, {",
        `    {
      const url = "javascript:alert(1)";
      await this.#page.goto(url, {`
      ).replace(
        `      timeout: 1000
    });`,
        `      timeout: 1000
      });
    }`
      )
    ],
    [
      "destructuring reassignment",
      passiveGuardFixture("before").replace(
        "    this.#context = await",
        `    ({ url } = { url: "javascript:alert(1)" });
    this.#context = await`
      )
    ],
    [
      "nested closure reassignment",
      passiveGuardFixture("before").replace(
        "    this.#context = await",
        `    const mutate = () => { url = "javascript:alert(1)"; };
    mutate();
    this.#context = await`
      )
    ],
    [
      "for-in reassignment",
      passiveGuardFixture("before").replace(
        "    this.#context = await",
        `    for (url in { "javascript:alert(1)": 1 }) {}
    this.#context = await`
      )
    ],
    [
      "top-level helper for-of reassignment",
      passiveGuardFixture("before").replace(
        "export class PassiveEdge",
        `for (isSafeLoopbackTarget of [() => true]) {}
export class PassiveEdge`
      )
    ]
  ])("rejects a guard with a %s", (_label, source) => {
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_NAVIGATION_GUARD"
    );
  });

  it("rejects a class-expression name that shadows the guarded URL", () => {
    const source = passiveGuardFixture("before").replace(
      `    await this.#page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 1000
    });`,
      `    const page = this.#page;
    const Container = class url {
      static {
        page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 1000
        });
      }
    };
    void Container;`
    );
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_NAVIGATION_GUARD"
    );
  });

  it("rejects a literal unsafe PassiveEdge.open call in the automated graph", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { PassiveEdge } from "../browser/passive-edge.mjs";
const edge = new PassiveEdge({ profileDir: "p", headless: true });
edge.open("javascript:alert(1)");
`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_OPEN_UNSAFE"
    );
  });

  it("tracks PassiveEdge constructor and instance aliases", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { PassiveEdge } from "../browser/passive-edge.mjs";
const Edge = PassiveEdge;
const edge = new Edge({ profileDir: "p", allowLoopback: true });
const alias = edge;
alias.open("javascript:alert(1)");
`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "PASSIVE_EDGE_CONSTRUCTOR",
        "PASSIVE_EDGE_OPEN_UNSAFE"
      ])
    );
  });

  it("tracks PassiveEdge subclasses", () => {
    const diagnostics = auditSourceSet(new Map([
      ["src/cli/verify-session.mjs", `import { PassiveEdge } from "../browser/passive-edge.mjs";
class Edge extends PassiveEdge {}
new Edge({ profileDir: "p", allowLoopback: true });
`],
      ["src/browser/passive-edge.mjs", "export class PassiveEdge {}\n"]
    ]), { automatedEntries: ["src/cli/verify-session.mjs"] });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PASSIVE_EDGE_CONSTRUCTOR"
    );
  });

  it.each([
    "const alias = page.goto; alias.call(page, \"https://game.maj-soul.com/1/\");",
    "const alias = page.goto; alias.apply(page, [\"https://game.maj-soul.com/1/\"]);",
    "const alias = page.goto; alias.bind(page)(\"https://game.maj-soul.com/1/\");"
  ])("rejects call/apply/bind escapes: %s", (statement) => {
    const source = `import { chromium } from \"playwright-core\";\nconst context = await chromium.launchPersistentContext(\"p\", {});\nconst page = context.pages()[0];\n${statement}\n`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain("PW_RAW_ESCAPE");
  });

  it("rejects tainted handles passed to unknown calls or stored publicly", () => {
    const source = `import { chromium } from \"playwright-core\";\nconst context = await chromium.launchPersistentContext(\"p\", {});\nconst page = context.pages()[0];\nconsume(page);\nthis.page = page;\n`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.filter((entry) => entry.code === "PW_RAW_ESCAPE"))
      .toHaveLength(2);
  });

  it("rejects a tainted handle hidden inside a spread argument", () => {
    const source = `import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("p", {});
const page = context.pages()[0];
consume(...[page]);
`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain("PW_RAW_ESCAPE");
  });

  it("propagates taint through an arbitrarily deep reverse alias chain", () => {
    const aliases = [];
    for (let index = 14; index >= 2; index -= 1) {
      aliases.push(`const a${index} = a${index - 1};`);
    }
    aliases.push("const a1 = page;");
    const source = `import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("p", {});
const page = context.pages()[0];
${aliases.join("\n")}
a14.click();
`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_MEMBER_FORBIDDEN"
    );
  });

  it.each([
    [
      "sequence expression alias",
      `const p = (0, page);
p.click();`,
      "PW_MEMBER_FORBIDDEN"
    ],
    ["constructor argument", "new Sink(page);", "PW_RAW_ESCAPE"],
    ["tagged template interpolation", "sink`${page}`;", "PW_RAW_ESCAPE"],
    ["named export declaration", "export const exposed = page;", "PW_RAW_ESCAPE"],
    ["throw expression", "throw page;", "PW_RAW_ESCAPE"],
    [
      "yield expression",
      "function* leak() { yield page; }\nvoid leak;",
      "PW_RAW_ESCAPE"
    ]
  ])("rejects a raw handle through %s", (_label, statement, code) => {
    const source = `import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("p", {});
const page = context.pages()[0];
function Sink() {}
function sink() {}
${statement}
`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(code);
  });

  it("propagates taint through a for-of binding", () => {
    const source = `import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("p", {});
for (const page of context.pages()) {
  page.click();
}
`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_MEMBER_FORBIDDEN"
    );
  });

  it("propagates taint from a private class field initializer", () => {
    const source = `import { chromium } from "playwright-core";
class Session {
  #engine = chromium;
  async run() {
    const context = await this.#engine.launchPersistentContext("p", {});
    const page = context.pages()[0];
    page.click();
  }
}
void Session;
`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "PW_MEMBER_FORBIDDEN"
    );
  });

  it("rejects assignment into an exported binding", () => {
    const source = `import { chromium } from "playwright-core";
const context = await chromium.launchPersistentContext("p", {});
const page = context.pages()[0];
export let exposed;
exposed = page;
`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain("PW_RAW_ESCAPE");
  });

  it("propagates a for-of handle into a private field", () => {
    const source = `import { chromium } from "playwright-core";
class Session {
  #view;
  async run() {
    const context = await chromium.launchPersistentContext("p", {});
    for (this.#view of context.pages()) {
      this.#view.click();
    }
  }
}
void Session;
`;
    const diagnostics = auditSourceSet(logicalPassiveEdge(source), {
      automatedEntries: ["src/browser/passive-edge.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["PW_RAW_ESCAPE", "PW_MEMBER_FORBIDDEN"])
    );
  });

  it("passes current source, ordinary indexing, PNG options, and Buffer zeroing", async () => {
    const diagnostics = await auditNoInputProject({
      srcDir: path.join(REPOSITORY, "src"),
      automatedEntries: ["src/cli/verify-session.mjs"]
    });
    expect(diagnostics).toEqual([]);

    const source = `const values = [1, 2];\nconst first = values[0];\nconst png = { type: \"png\" };\nconst bytes = Buffer.alloc(2);\nbytes.fill(0);\nexport { first, png };\n`;
    expect(auditSourceSet(new Map([["src/safe.mjs", source]]), {
      automatedEntries: ["src/safe.mjs"]
    })).toEqual([]);
  });

  it("keeps the source grep independent and receiver-aware", async () => {
    expect(grepForbiddenSource(await fixture("direct-click"), "seed.mjs"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_INPUT_TOKEN" })
      ]));
    expect(grepForbiddenSource(await fixture("select"), "select.mjs"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_INPUT_TOKEN" })
      ]));
    expect(grepForbiddenSource(await fixture("drag"), "drag.mjs"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_INPUT_TOKEN" })
      ]));
    expect(grepForbiddenSource("const b = Buffer.alloc(4); b.fill(0);", "safe.mjs"))
      .toEqual([]);
  });

  it.each([
    ["comment-separated member", "page/*gap*/.click()"],
    ["semicolonless const-key member", "const key = 'click'\npage[key]()"],
    ["commented const-key member", "const key = 'click' // comment\npage[key]()"],
    ["line-comment marker inside a string", `const u = "http://example"; page.click()`],
    ["block-comment markers inside strings", `const a = "/*"; page.click(); const b = "*/";`]
  ])("source grep rejects a %s", (_label, source) => {
    expect(grepForbiddenSource(source, "obfuscated.mjs").map((entry) => entry.code))
      .toContain("SOURCE_INPUT_TOKEN");
  });

  it.each([
    "direct-click",
    "optional-click",
    "bracket-click",
    "escaped-click",
    "concatenated-click",
    "const-key-click",
    "select",
    "drag"
  ])("independent source grep rejects seeded form %s", async (name) => {
    const diagnostics = grepForbiddenSource(
      await fixture(name),
      `${name}.mjs`
    );
    expect(diagnostics.map((entry) => entry.code)).toContain(
      "SOURCE_INPUT_TOKEN"
    );
  });

  it("realpath-checks source roots and rejects a symlink escape", async () => {
    if (process.platform !== "win32") return;
    const root = await temporaryProject({
      "src/cli/verify-session.mjs": "import \"../linked.mjs\";\n"
    });
    const outside = path.join(root, "outside.mjs");
    await writeFile(outside, "export const escaped = true;\n", "utf8");
    const linked = path.join(root, "src", "linked.mjs");
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(outside, linked, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) return;
      throw error;
    }
    expect(await realpath(linked)).toBe(await realpath(outside));
    const diagnostics = await auditNoInputProject({
      srcDir: path.join(root, "src"),
      automatedEntries: ["src/cli/verify-session.mjs"]
    });
    expect(diagnostics.map((entry) => entry.code)).toContain("IMPORT_REALPATH_ESCAPE");
  });

  it("locks package scripts to full tests followed by the guard", async () => {
    const packageJson = JSON.parse(await readFile(
      path.join(REPOSITORY, "package.json"),
      "utf8"
    ));
    expect(packageJson.devDependencies).toMatchObject({
      acorn: "8.17.0",
      "acorn-walk": "8.3.5"
    });
    expect(packageJson.scripts["check:no-input"]).toBe(
      "node scripts/check-no-input.mjs"
    );
    expect(packageJson.scripts.verify).toBe(
      "npm test && npm run check:no-input"
    );
  });
});
