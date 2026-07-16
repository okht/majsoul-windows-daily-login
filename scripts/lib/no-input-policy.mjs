import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";
import * as walk from "acorn-walk";

const PASSIVE_EDGE_FILE = "src/browser/passive-edge.mjs";
const FINGERPRINT_FILE = "src/browser/fingerprint.mjs";
const DEFAULT_AUTOMATED_ENTRIES = Object.freeze([
  "src/cli/verify-session.mjs",
  "src/cli/run.mjs"
]);
const PLAYWRIGHT_ALLOWED_MEMBERS = new Set([
  "launchPersistentContext",
  "pages",
  "newPage",
  "goto",
  "url",
  "title",
  "locator",
  "innerText",
  "screenshot",
  "close",
  "catch"
]);
const PLAYWRIGHT_HANDLE_RESULTS = new Set([
  "launchPersistentContext",
  "pages",
  "newPage",
  "locator"
]);
const FORBIDDEN_MEMBER_NAMES = new Set([
  "click",
  "dblclick",
  "tap",
  "press",
  "pressSequentially",
  "type",
  "fill",
  "clear",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "selectText",
  "select",
  "setInputFiles",
  "upload",
  "hover",
  "focus",
  "blur",
  "dragTo",
  "drag",
  "dispatchEvent",
  "scrollIntoViewIfNeeded",
  "mouse",
  "keyboard",
  "touchscreen",
  "clipboard",
  "down",
  "up",
  "move",
  "wheel",
  "insertText",
  "evaluate",
  "evaluateAll",
  "evaluateHandle",
  "$eval",
  "$$eval",
  "waitForFunction",
  "addInitScript",
  "addScriptTag",
  "setContent",
  "exposeBinding",
  "exposeFunction",
  "addLocatorHandler",
  "pause",
  "route",
  "routeFromHAR",
  "routeWebSocket",
  "unroute",
  "newCDPSession",
  "newBrowserCDPSession",
  "connectOverCDP",
  "connect",
  "send",
  "addCookies",
  "clearCookies",
  "storageState",
  "grantPermissions",
  "setGeolocation",
  "setOffline",
  "setExtraHTTPHeaders",
  "accept",
  "dismiss",
  "launch",
  "launchServer"
]);
const DYNAMIC_ESCAPE_MEMBERS = new Map([
  ["Reflect", new Set(["get", "apply"])],
  ["Object", new Set(["getOwnPropertyDescriptor"])],
  ["process", new Set(["getBuiltinModule"])]
]);
const CALL_ESCAPE_MEMBERS = new Set(["call", "apply", "bind"]);
const TARGET = "https://game.maj-soul.com/1/";

function normalizeFile(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function locationOf(node) {
  return {
    line: node?.loc?.start?.line ?? 1,
    column: (node?.loc?.start?.column ?? 0) + 1
  };
}

function diagnostic(file, node, code) {
  return { file: normalizeFile(file), ...locationOf(node), code };
}

function sortDiagnostics(values) {
  const unique = new Map();
  for (const value of values) {
    const key = [value.file, value.line, value.column, value.code].join("\0");
    unique.set(key, value);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = `${left.file}:${String(left.line).padStart(8, "0")}:${String(left.column).padStart(8, "0")}:${left.code}`;
    const rightKey = `${right.file}:${String(right.line).padStart(8, "0")}:${String(right.column).padStart(8, "0")}:${right.code}`;
    return leftKey.localeCompare(rightKey);
  });
}

function parseModule(source, file, diagnostics) {
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
      locations: true
    });
  } catch (error) {
    diagnostics.push({
      file,
      line: error?.loc?.line ?? 1,
      column: (error?.loc?.column ?? 0) + 1,
      code: "PARSE_ERROR"
    });
    return null;
  }
}

function moduleSpecifiers(ast, source) {
  if (ast) {
    const result = [];
    for (const node of ast.body) {
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportAllDeclaration" ||
          node.type === "ExportNamedDeclaration") &&
        node.source?.type === "Literal"
      ) {
        result.push({ value: node.source.value, node: node.source });
      }
    }
    return result;
  }

  const result = [];
  const expression = /\b(?:import|export)\s+(?:[^"'\r\n]*?\s+from\s+)?["']([^"'\r\n]+)["']/gu;
  let match;
  while ((match = expression.exec(source)) !== null) {
    const before = source.slice(0, match.index);
    const lines = before.split(/\r?\n/u);
    result.push({
      value: match[1],
      node: {
        loc: {
          start: {
            line: lines.length,
            column: lines.at(-1).length
          }
        }
      }
    });
  }
  return result;
}

function isAbsoluteSpecifier(specifier) {
  return (
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/u.test(specifier)
  );
}

function resolveRelativeImport(file, specifier, sources, diagnostics, node) {
  if (/[?#]/u.test(specifier)) {
    diagnostics.push(diagnostic(file, node, "IMPORT_SUFFIX_FORBIDDEN"));
    return null;
  }
  if (specifier.includes("\\")) {
    diagnostics.push(diagnostic(file, node, "IMPORT_ABSOLUTE"));
    return null;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier)
  );
  if (!resolved.startsWith("src/") || resolved.includes("../")) {
    diagnostics.push(diagnostic(file, node, "IMPORT_TRAVERSAL"));
    return null;
  }
  if (!specifier.endsWith(".mjs") || !sources.has(resolved)) {
    diagnostics.push(diagnostic(file, node, "IMPORT_MISSING"));
    return null;
  }
  return resolved;
}

function scanImportBoundaries(file, ast, diagnostics) {
  if (!ast) return;
  for (const node of ast.body) {
    const source = node.source?.value;
    if (source === "playwright-core") {
      if (file !== PASSIVE_EDGE_FILE) {
        diagnostics.push(
          diagnostic(file, node.source ?? node, "PLAYWRIGHT_IMPORT_BOUNDARY")
        );
      }
      const valid =
        node.type === "ImportDeclaration" &&
        node.specifiers.length === 1 &&
        node.specifiers[0].type === "ImportSpecifier" &&
        node.specifiers[0].imported?.name === "chromium" &&
        node.specifiers[0].local?.name === "chromium";
      if (!valid) {
        diagnostics.push(
          diagnostic(file, node.source ?? node, "PLAYWRIGHT_IMPORT_SHAPE")
        );
      }
    }
    if (source === "sharp") {
      if (file !== FINGERPRINT_FILE) {
        diagnostics.push(
          diagnostic(file, node.source ?? node, "SHARP_IMPORT_BOUNDARY")
        );
      }
      const valid =
        node.type === "ImportDeclaration" &&
        node.specifiers.length === 1 &&
        node.specifiers[0].type === "ImportDefaultSpecifier" &&
        node.specifiers[0].local?.name === "sharp";
      if (!valid) {
        diagnostics.push(
          diagnostic(file, node.source ?? node, "SHARP_IMPORT_SHAPE")
        );
      }
    }
  }
}

function staticString(node, constStrings = new Map()) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(node.left, constStrings);
    const right = staticString(node.right, constStrings);
    return left === undefined || right === undefined
      ? undefined
      : left + right;
  }
  if (node.type === "Identifier") return constStrings.get(node.name);
  return undefined;
}

function memberName(node, constStrings) {
  if (!node?.computed && node?.property?.type === "Identifier") {
    return node.property.name;
  }
  if (node?.property?.type === "PrivateIdentifier") {
    return node.property.name;
  }
  if (node?.computed && node.property.type === "Literal") {
    return String(node.property.value);
  }
  return staticString(node?.property, constStrings);
}

function collectConstStrings(ast) {
  const candidates = new Map();
  const reassigned = new Set();
  walk.full(ast, (node) => {
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier") {
          candidates.set(declaration.id.name, declaration.init);
        }
      }
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "Identifier"
    ) {
      reassigned.add(node.left.name);
    }
    if (node.type === "UpdateExpression" && node.argument.type === "Identifier") {
      reassigned.add(node.argument.name);
    }
  });

  const result = new Map();
  for (let pass = 0; pass < candidates.size + 1; pass += 1) {
    for (const [name, value] of candidates) {
      if (reassigned.has(name) || result.has(name)) continue;
      const resolved = staticString(value, result);
      if (resolved !== undefined) result.set(name, resolved);
    }
  }
  return result;
}

function patternIdentifiers(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") {
    return patternIdentifiers(pattern.left);
  }
  if (pattern.type === "RestElement") return patternIdentifiers(pattern.argument);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap(patternIdentifiers);
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      property.type === "RestElement"
        ? patternIdentifiers(property.argument)
        : patternIdentifiers(property.value)
    );
  }
  return [];
}

function objectKeysAllowed(node, allowed) {
  if (!node || node.type !== "ObjectExpression") return false;
  return node.properties.every((property) => {
    if (property.type !== "Property" || property.computed) return false;
    const key = property.key.type === "Identifier"
      ? property.key.name
      : String(property.key.value);
    return allowed.has(key);
  });
}

function validatePlaywrightArguments(
  file,
  node,
  name,
  diagnostics,
  constStrings,
  ancestors
) {
  if (name === "screenshot") {
    if (node.arguments.length === 0) return;
    const options = node.arguments[0];
    const valid =
      node.arguments.length === 1 &&
      objectKeysAllowed(options, new Set(["type"])) &&
      options.properties.every((property) =>
        (property.key.name ?? property.key.value) !== "type" ||
        staticString(property.value) === "png"
      );
    if (!valid) {
      diagnostics.push(diagnostic(file, node, "PW_ARGUMENT_FORBIDDEN"));
    }
  }

  if (name === "launchPersistentContext") {
    const options = node.arguments[1];
    let valid =
      options === undefined ||
      objectKeysAllowed(options, new Set(["channel", "headless", "viewport"]));
    if (valid && options?.type === "ObjectExpression") {
      for (const property of options.properties) {
        const key = property.key.name ?? property.key.value;
        if (key === "channel" && staticString(property.value, constStrings) !== "msedge") {
          valid = false;
        }
        if (
          key === "viewport" &&
          property.value.type === "ObjectExpression" &&
          !objectKeysAllowed(property.value, new Set(["width", "height"]))
        ) {
          valid = false;
        }
      }
    }
    if (!valid) {
      diagnostics.push(diagnostic(file, node, "PW_ARGUMENT_FORBIDDEN"));
    }
  }

  if (name === "goto") {
    const target = node.arguments[0];
    const literalTarget = staticString(target, constStrings);
    const enclosingOpenMethod = ancestors.some((ancestor) =>
      ancestor.type === "MethodDefinition" &&
      !ancestor.computed &&
      ancestor.key.name === "open" &&
      ancestor.value.params.some((parameter) =>
        parameter.type === "Identifier" && parameter.name === "url"
      )
    );
    const validTarget =
      literalTarget === TARGET ||
      literalTarget === undefined &&
      target?.type === "Identifier" &&
      target.name === "url" &&
      enclosingOpenMethod;
    const options = node.arguments[1];
    const validOptions =
      options === undefined ||
      objectKeysAllowed(options, new Set(["waitUntil", "timeout"]));
    if (!validTarget) {
      diagnostics.push(diagnostic(file, node, "PW_NAVIGATION_UNSAFE"));
    }
    if (!validOptions) {
      diagnostics.push(diagnostic(file, node, "PW_ARGUMENT_FORBIDDEN"));
    }
  }
}

function deepAuditPassiveEdge(file, ast, diagnostics) {
  if (!ast) return;
  const constStrings = collectConstStrings(ast);
  const tainted = new Set();
  const methodBindings = new Map();
  const privateFields = new Set();

  for (const node of ast.body) {
    if (
      node.type === "ImportDeclaration" &&
      node.source.value === "playwright-core"
    ) {
      for (const specifier of node.specifiers) tainted.add(specifier.local.name);
    }
  }

  function rawMember(node) {
    return (
      node?.type === "MemberExpression" &&
      node.object.type === "ThisExpression" &&
      node.property.type === "PrivateIdentifier" &&
      privateFields.has(node.property.name)
    );
  }

  function taintKind(node) {
    if (!node) return null;
    if (node.type === "Identifier") {
      if (methodBindings.has(node.name)) return "method";
      return tainted.has(node.name) ? "raw" : null;
    }
    if (node.type === "AwaitExpression" || node.type === "ChainExpression") {
      return taintKind(node.argument ?? node.expression);
    }
    if (node.type === "AssignmentExpression") return taintKind(node.right);
    if (
      node.type === "LogicalExpression" ||
      node.type === "ConditionalExpression"
    ) {
      const candidates = node.type === "ConditionalExpression"
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
      return candidates.some((candidate) => taintKind(candidate) === "raw")
        ? "raw"
        : candidates.some((candidate) => taintKind(candidate) === "method")
          ? "method"
          : null;
    }
    if (node.type === "ArrayExpression") {
      return node.elements.some((element) => taintKind(element)) ? "raw" : null;
    }
    if (node.type === "ObjectExpression") {
      return node.properties.some((property) =>
        property.type === "SpreadElement"
          ? taintKind(property.argument)
          : taintKind(property.value)
      ) ? "raw" : null;
    }
    if (rawMember(node)) return "raw";
    if (node.type === "MemberExpression") {
      const objectKind = taintKind(node.object);
      if (!objectKind) return null;
      const name = memberName(node, constStrings);
      if (name !== undefined && /^\d+$/u.test(name)) return "raw";
      return "method";
    }
    if (node.type === "CallExpression") {
      if (node.callee.type === "MemberExpression") {
        const receiver = taintKind(node.callee.object);
        const name = memberName(node.callee, constStrings);
        if (receiver) {
          return PLAYWRIGHT_HANDLE_RESULTS.has(name) ? "raw" : null;
        }
      }
      if (taintKind(node.callee) === "method") return "raw";
      return null;
    }
    return null;
  }

  function assignPattern(pattern, kind, methodName) {
    if (!kind) return false;
    let changed = false;
    for (const name of patternIdentifiers(pattern)) {
      if (kind === "method") {
        if (!methodBindings.has(name)) {
          methodBindings.set(name, methodName);
          changed = true;
        }
      } else if (!tainted.has(name)) {
        tainted.add(name);
        changed = true;
      }
    }
    return changed;
  }

  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    walk.full(ast, (node) => {
      if (node.type === "AssignmentPattern") {
        changed = assignPattern(node.left, taintKind(node.right)) || changed;
      }
      if (node.type === "VariableDeclarator") {
        const kind = taintKind(node.init);
        const methodName = node.init?.type === "MemberExpression"
          ? memberName(node.init, constStrings)
          : undefined;
        changed = assignPattern(node.id, kind, methodName) || changed;
      }
      if (node.type === "AssignmentExpression") {
        const kind = taintKind(node.right);
        if (
          kind &&
          node.left.type === "MemberExpression" &&
          node.left.object.type === "ThisExpression" &&
          node.left.property.type === "PrivateIdentifier" &&
          !privateFields.has(node.left.property.name)
        ) {
          privateFields.add(node.left.property.name);
          changed = true;
        } else {
          changed = assignPattern(node.left, kind) || changed;
        }
      }
    });
    if (!changed) break;
  }

  walk.fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors.at(-2);
    if (node.type === "MemberExpression" && taintKind(node.object)) {
      const name = memberName(node, constStrings);
      if (node.optional || parent?.type === "ChainExpression") {
        diagnostics.push(diagnostic(file, node, "PW_OPTIONAL_FORBIDDEN"));
      }
      if (name === undefined) {
        diagnostics.push(diagnostic(file, node, "PW_COMPUTED_UNKNOWN"));
      } else if (
        !/^\d+$/u.test(name) &&
        !PLAYWRIGHT_ALLOWED_MEMBERS.has(name)
      ) {
        diagnostics.push(diagnostic(file, node, "PW_MEMBER_FORBIDDEN"));
      }
      if (
        CALL_ESCAPE_MEMBERS.has(name) &&
        taintKind(node.object) === "method"
      ) {
        diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
      }
    }

    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      taintKind(node.init)
    ) {
      for (const property of node.id.properties) {
        const name = property.type === "Property"
          ? property.computed
            ? staticString(property.key, constStrings)
            : property.key.name ?? String(property.key.value)
          : undefined;
        diagnostics.push(diagnostic(
          file,
          property,
          name === undefined || PLAYWRIGHT_ALLOWED_MEMBERS.has(name)
            ? "PW_RAW_ESCAPE"
            : "PW_MEMBER_FORBIDDEN"
        ));
      }
    }

    if (node.type === "CallExpression") {
      if (node.callee.type === "MemberExpression") {
        const receiver = taintKind(node.callee.object);
        const name = memberName(node.callee, constStrings);
        if (receiver && PLAYWRIGHT_ALLOWED_MEMBERS.has(name)) {
          validatePlaywrightArguments(
            file,
            node,
            name,
            diagnostics,
            constStrings,
            ancestors
          );
        }
      } else if (
        !["super"].includes(node.callee.type) &&
        node.arguments.some((argument) => taintKind(argument))
      ) {
        diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
      }
    }

    if (
      node.type === "ReturnStatement" &&
      taintKind(node.argument)
    ) {
      diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
    }

    if (
      node.type === "AssignmentExpression" &&
      taintKind(node.right) &&
      node.left.type === "MemberExpression" &&
      !(
        node.left.object.type === "ThisExpression" &&
        node.left.property.type === "PrivateIdentifier"
      )
    ) {
      diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
    }

    if (
      node.type === "ExportDefaultDeclaration" &&
      taintKind(node.declaration)
    ) {
      diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
    }
    if (node.type === "ExportNamedDeclaration") {
      for (const specifier of node.specifiers) {
        if (taintKind(specifier.local)) {
          diagnostics.push(diagnostic(file, specifier, "PW_RAW_ESCAPE"));
        }
      }
    }
  });
}

function scanAutomatedDangers(file, ast, diagnostics) {
  if (!ast) return;
  walk.full(ast, (node) => {
    if (node.type === "ImportExpression") {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_IMPORT_FORBIDDEN"));
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      ["require", "createRequire"].includes(node.callee.name)
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_REQUIRE_FORBIDDEN"));
    }
    if (
      (node.type === "CallExpression" || node.type === "NewExpression") &&
      node.callee.type === "Identifier" &&
      ["eval", "Function"].includes(node.callee.name)
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_ESCAPE_FORBIDDEN"));
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier"
    ) {
      const owner = node.callee.object.name;
      const name = memberName(node.callee, new Map());
      if (DYNAMIC_ESCAPE_MEMBERS.get(owner)?.has(name)) {
        diagnostics.push(diagnostic(file, node, "DYNAMIC_ESCAPE_FORBIDDEN"));
      }
    }
  });
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors.at(-2);
    if (
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      DYNAMIC_ESCAPE_MEMBERS.get(node.object.name)?.has(
        memberName(node, new Map())
      )
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_ESCAPE_FORBIDDEN"));
    }
    if (
      node.type === "Identifier" &&
      ["eval", "Function", "require", "createRequire"].includes(node.name) &&
      parent?.type === "VariableDeclarator" &&
      parent.init === node
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_ESCAPE_FORBIDDEN"));
    }
  });
}

function scanPassiveEdgeConstructors(file, ast, diagnostics) {
  if (!ast) return;
  const bindings = new Set();
  for (const node of ast.body) {
    if (
      node.type === "ImportDeclaration" &&
      typeof node.source.value === "string" &&
      node.source.value.endsWith("/browser/passive-edge.mjs")
    ) {
      for (const specifier of node.specifiers) {
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.imported.name === "PassiveEdge"
        ) {
          bindings.add(specifier.local.name);
        }
      }
    }
  }
  if (file === PASSIVE_EDGE_FILE) bindings.add("PassiveEdge");

  walk.full(ast, (node) => {
    if (
      node.type !== "NewExpression" ||
      node.callee.type !== "Identifier" ||
      !bindings.has(node.callee.name)
    ) return;
    const options = node.arguments[0];
    if (!objectKeysAllowed(options, new Set(["profileDir", "headless"]))) {
      diagnostics.push(diagnostic(file, node, "PASSIVE_EDGE_CONSTRUCTOR"));
    }
  });
}

function buildAutomatedGraph(sources, asts, entries, diagnostics) {
  const roots = entries.map(normalizeFile).filter((file) => sources.has(file));
  const visited = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (
      file.startsWith("src/cli/") &&
      !roots.includes(file)
    ) {
      diagnostics.push(diagnostic(file, asts.get(file), "AUTOMATED_CLI_FORBIDDEN"));
    }
    for (const { value, node } of moduleSpecifiers(
      asts.get(file),
      sources.get(file)
    )) {
      if (typeof value !== "string") continue;
      if (isAbsoluteSpecifier(value)) {
        diagnostics.push(diagnostic(file, node, "IMPORT_ABSOLUTE"));
        continue;
      }
      if (!value.startsWith(".")) continue;
      const resolved = resolveRelativeImport(
        file,
        value,
        sources,
        diagnostics,
        node
      );
      if (resolved) pending.push(resolved);
    }
  }
  return visited;
}

export function auditSourceSet(sourceInput, options = {}) {
  const sources = new Map();
  for (const [file, source] of sourceInput) {
    sources.set(normalizeFile(file), String(source));
  }
  const diagnostics = [];
  const asts = new Map();
  for (const [file, source] of sources) {
    const ast = parseModule(source, file, diagnostics);
    asts.set(file, ast);
    scanImportBoundaries(file, ast, diagnostics);
  }

  const automatedEntries = options.automatedEntries ??
    DEFAULT_AUTOMATED_ENTRIES;
  const automatedGraph = buildAutomatedGraph(
    sources,
    asts,
    automatedEntries,
    diagnostics
  );
  for (const file of automatedGraph) {
    scanAutomatedDangers(file, asts.get(file), diagnostics);
    scanPassiveEdgeConstructors(file, asts.get(file), diagnostics);
  }
  if (sources.has(PASSIVE_EDGE_FILE)) {
    deepAuditPassiveEdge(
      PASSIVE_EDGE_FILE,
      asts.get(PASSIVE_EDGE_FILE),
      diagnostics
    );
  }
  return sortDiagnostics(diagnostics);
}

function lineColumnAt(source, index) {
  const before = source.slice(0, index).split(/\r?\n/u);
  return { line: before.length, column: before.at(-1).length + 1 };
}

export function grepForbiddenSource(source, file = "source.mjs") {
  const diagnostics = [];
  const names = [...FORBIDDEN_MEMBER_NAMES]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[$]/gu, "\\$&"))
    .join("|");
  const expression = new RegExp(
    `\\b(?:page|locator|context|browser|mouse|keyboard|touchscreen)\\s*(?:\\.\\s*(?:${names})\\b|\\[\\s*["'](?:${names})["']\\s*\\])|\\bInput\\.dispatch[A-Za-z]+`,
    "gu"
  );
  let match;
  while ((match = expression.exec(source)) !== null) {
    diagnostics.push({
      file: normalizeFile(file),
      ...lineColumnAt(source, match.index),
      code: "SOURCE_INPUT_TOKEN"
    });
  }
  return sortDiagnostics(diagnostics);
}

async function collectSourceFiles(root, relative = "", state) {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const nextRelative = path.join(relative, entry.name);
    const absolute = path.join(root, nextRelative);
    if (entry.isDirectory()) {
      await collectSourceFiles(root, nextRelative, state);
      continue;
    }
    if (!entry.name.endsWith(".mjs")) continue;
    const logical = normalizeFile(path.posix.join("src", nextRelative.replaceAll("\\", "/")));
    const resolved = await realpath(absolute);
    const relativeReal = path.relative(state.realRoot, resolved);
    if (
      relativeReal.startsWith("..") ||
      path.isAbsolute(relativeReal)
    ) {
      state.diagnostics.push({
        file: logical,
        line: 1,
        column: 1,
        code: "IMPORT_REALPATH_ESCAPE"
      });
      continue;
    }
    state.sources.set(logical, await readFile(resolved, "utf8"));
  }
}

export async function auditNoInputProject(options = {}) {
  const srcDir = path.resolve(options.srcDir ?? path.resolve("src"));
  const state = {
    sources: new Map(),
    diagnostics: [],
    realRoot: await realpath(srcDir)
  };
  await collectSourceFiles(srcDir, "", state);
  const astDiagnostics = auditSourceSet(state.sources, {
    automatedEntries: options.automatedEntries ?? DEFAULT_AUTOMATED_ENTRIES
  });
  const grepDiagnostics = [];
  for (const [file, source] of state.sources) {
    grepDiagnostics.push(...grepForbiddenSource(source, file));
  }
  return sortDiagnostics([
    ...state.diagnostics,
    ...astDiagnostics,
    ...grepDiagnostics
  ]);
}
