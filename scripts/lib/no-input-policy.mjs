import path from "node:path";
import { parse } from "acorn";
import * as walk from "acorn-walk";
import {
  buildAutomatedGraph,
  collectProjectSources
} from "./project-source-graph.mjs";
import { grepForbiddenSource } from "./source-grep-policy.mjs";

export { grepForbiddenSource };

const PASSIVE_EDGE_FILE = "src/browser/passive-edge.mjs";
const FINGERPRINT_FILE = "src/browser/fingerprint.mjs";
const DEFAULT_AUTOMATED_ENTRIES = Object.freeze([
  "src/cli/verify-session.mjs",
  "src/cli/run.mjs"
]);
const PLAYWRIGHT_ALLOWED_MEMBERS = new Set([
  "connectOverCDP",
  "launchPersistentContext",
  "contexts",
  "pages",
  "newPage",
  "goto",
  "url",
  "title",
  "locator",
  "innerText",
  "screenshot",
  "close",
  "catch",
  "find"
]);
const PLAYWRIGHT_HANDLE_RESULTS = new Set([
  "connectOverCDP",
  "launchPersistentContext",
  "contexts",
  "pages",
  "newPage",
  "locator"
]);
const DYNAMIC_ESCAPE_MEMBERS = new Map([
  ["Reflect", new Set(["get", "apply"])],
  ["Object", new Set(["getOwnPropertyDescriptor"])],
  ["process", new Set(["getBuiltinModule"])]
]);
const CALL_ESCAPE_MEMBERS = new Set(["call", "apply", "bind"]);
const DYNAMIC_GLOBAL_ROOTS = new Set([
  "globalThis",
  "global",
  "window",
  "self"
]);
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

function scanImportBoundaries(file, ast, diagnostics) {
  if (!ast) return;
  for (const node of ast.body) {
    const source = node.source?.value;
    if (isAlternateAutomationPackage(source)) {
      diagnostics.push(
        diagnostic(file, node.source ?? node, "AUTOMATION_PACKAGE_FORBIDDEN")
      );
    }
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

function isAlternateAutomationPackage(source) {
  if (typeof source !== "string" || source === "playwright-core") {
    return false;
  }
  return (
    source === "playwright" ||
    source.startsWith("playwright/") ||
    source.startsWith("playwright-core/") ||
    source === "@playwright/test" ||
    source.startsWith("@playwright/test/") ||
    source === "puppeteer" ||
    source.startsWith("puppeteer/") ||
    source === "puppeteer-core" ||
    source.startsWith("puppeteer-core/") ||
    source === "selenium-webdriver" ||
    source.startsWith("selenium-webdriver/") ||
    source === "webdriver" ||
    source.startsWith("webdriver/") ||
    source === "webdriverio" ||
    source.startsWith("webdriverio/") ||
    source.startsWith("@wdio/")
  );
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

function matchesTargetMismatch(node, urlName) {
  return (
    node?.type === "BinaryExpression" &&
    node.operator === "!==" &&
    ((node.left.type === "Identifier" &&
      node.left.name === urlName &&
      node.right.type === "Identifier" &&
      node.right.name === "TARGET") ||
      (node.right.type === "Identifier" &&
        node.right.name === urlName &&
        node.left.type === "Identifier" &&
        node.left.name === "TARGET"))
  );
}

function matchesAllowLoopback(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "ThisExpression" &&
    node.property.type === "PrivateIdentifier" &&
    node.property.name === "allowLoopback"
  );
}

function matchesSafeLoopbackCall(node, urlName) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "isSafeLoopbackTarget" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Identifier" &&
    node.arguments[0].name === urlName
  );
}

function isExactTargetGuard(node, urlName) {
  if (
    node?.type !== "IfStatement" ||
    node.test.type !== "LogicalExpression" ||
    node.test.operator !== "&&" ||
    !matchesTargetMismatch(node.test.left, urlName)
  ) {
    return false;
  }
  const negated = node.test.right;
  if (
    negated.type !== "UnaryExpression" ||
    negated.operator !== "!" ||
    negated.argument.type !== "LogicalExpression" ||
    negated.argument.operator !== "&&" ||
    !matchesAllowLoopback(negated.argument.left) ||
    !matchesSafeLoopbackCall(negated.argument.right, urlName)
  ) {
    return false;
  }
  return (
    node.alternate == null &&
    node.consequent.type === "BlockStatement" &&
    node.consequent.body.length === 1 &&
    node.consequent.body[0].type === "ThrowStatement"
  );
}

function collectGuardedGotoCalls(file, ast, diagnostics) {
  const guarded = new Set();
  let targetBindingCount = 0;
  let validTargetBinding = false;
  let helperBindingCount = 0;
  let validHelperBinding = false;
  for (const node of ast.body) {
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (
          declaration.id.type === "Identifier" &&
          declaration.id.name === "TARGET"
        ) {
          targetBindingCount += 1;
          validTargetBinding =
            node.kind === "const" && staticString(declaration.init) === TARGET;
        }
        if (
          declaration.id.type === "Identifier" &&
          declaration.id.name === "isSafeLoopbackTarget"
        ) {
          helperBindingCount += 1;
        }
      }
    }
    if (
      node.type === "FunctionDeclaration" &&
      node.id?.name === "isSafeLoopbackTarget"
    ) {
      helperBindingCount += 1;
      validHelperBinding = true;
    }
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "ClassDeclaration") &&
      node.id?.name === "TARGET"
    ) {
      targetBindingCount += 1;
    }
  }
  let guardBindingMutated = false;
  walk.full(ast, (node) => {
    const mutationTargets = node.type === "AssignmentExpression"
      ? [node.left]
      : node.type === "UpdateExpression"
        ? [node.argument]
        : node.type === "ForOfStatement" || node.type === "ForInStatement"
          ? node.left.type === "VariableDeclaration"
            ? node.left.declarations.map((declaration) => declaration.id)
            : [node.left]
          : [];
    if (
      mutationTargets.some((target) =>
        patternIdentifiers(target).some((name) =>
          name === "TARGET" || name === "isSafeLoopbackTarget"
        )
      )
    ) {
      guardBindingMutated = true;
    }
  });
  const authenticGuardBindings =
    targetBindingCount === 1 &&
    validTargetBinding &&
    helperBindingCount === 1 &&
    validHelperBinding &&
    !guardBindingMutated;

  walk.simple(ast, {
    MethodDefinition(method) {
      if (
        method.computed ||
        method.key.type !== "Identifier" ||
        method.key.name !== "open" ||
        method.value.params.length === 0 ||
        method.value.params[0].type !== "Identifier"
      ) {
        return;
      }
      const urlName = method.value.params[0].name;
      const guards = method.value.body.body.filter((statement) =>
        isExactTargetGuard(statement, urlName)
      );
      const gotoCalls = [];
      const invalidations = [];
      let hasLocalGuardBinding = false;
      const nearestFunction = (ancestors) =>
        [...ancestors].reverse().find((ancestor) =>
          [
            "FunctionExpression",
            "FunctionDeclaration",
            "ArrowFunctionExpression"
          ].includes(ancestor.type)
        );
      const recordLocalBinding = (pattern) => {
        if (
          patternIdentifiers(pattern).some((name) =>
            name === urlName ||
            name === "TARGET" ||
            name === "isSafeLoopbackTarget"
          )
        ) {
          hasLocalGuardBinding = true;
        }
      };
      const recordLoopInvalidation = (statement, _state, ancestors) => {
        const leftPatterns = statement.left.type === "VariableDeclaration"
          ? statement.left.declarations.map((declaration) => declaration.id)
          : [statement.left];
        if (
          leftPatterns.some((pattern) =>
            patternIdentifiers(pattern).includes(urlName)
          )
        ) {
          invalidations.push({
            node: statement,
            owner: nearestFunction(ancestors)
          });
        }
      };
      walk.ancestor(method.value, {
        VariableDeclarator(declaration) {
          recordLocalBinding(declaration.id);
        },
        FunctionDeclaration(fn) {
          recordLocalBinding(fn.id);
          for (const parameter of fn.params) recordLocalBinding(parameter);
        },
        FunctionExpression(fn) {
          if (fn === method.value) {
            for (const parameter of fn.params.slice(1)) {
              recordLocalBinding(parameter);
            }
            return;
          }
          recordLocalBinding(fn.id);
          for (const parameter of fn.params) recordLocalBinding(parameter);
        },
        ArrowFunctionExpression(fn) {
          for (const parameter of fn.params) recordLocalBinding(parameter);
        },
        ClassDeclaration(classNode) {
          recordLocalBinding(classNode.id);
        },
        ClassExpression(classNode) {
          recordLocalBinding(classNode.id);
        },
        CatchClause(clause) {
          recordLocalBinding(clause.param);
        },
        AssignmentExpression(assignment, _state, ancestors) {
          if (
            patternIdentifiers(assignment.left).includes(urlName)
          ) {
            invalidations.push({
              node: assignment,
              owner: nearestFunction(ancestors)
            });
          }
        },
        UpdateExpression(update, _state, ancestors) {
          if (
            update.argument.type === "Identifier" &&
            update.argument.name === urlName
          ) {
            invalidations.push({
              node: update,
              owner: nearestFunction(ancestors)
            });
          }
        },
        ForOfStatement: recordLoopInvalidation,
        ForInStatement: recordLoopInvalidation,
        CallExpression(call, _state, ancestors) {
          if (
            call.callee.type === "MemberExpression" &&
            memberName(call.callee, new Map()) === "goto"
          ) {
            gotoCalls.push({ call, owner: nearestFunction(ancestors) });
          }
        }
      });
      for (const { call, owner } of gotoCalls) {
        const target = call.arguments[0];
        const valid =
          authenticGuardBindings &&
          !hasLocalGuardBinding &&
          owner === method.value &&
          target?.type === "Identifier" &&
          target.name === urlName &&
          guards.some((guard) =>
            guard.start < call.start &&
            !invalidations.some(({ node: change, owner: changeOwner }) =>
              changeOwner !== method.value ||
              (change.start > guard.end && change.start < call.start)
            )
          );
        if (valid) guarded.add(call);
        else diagnostics.push(
          diagnostic(file, call, "PW_NAVIGATION_GUARD")
        );
      }
    }
  });
  return guarded;
}

function validatePlaywrightArguments(
  file,
  node,
  name,
  diagnostics,
  constStrings,
  guardedGotoCalls
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
    const validTarget =
      literalTarget === TARGET ||
      guardedGotoCalls.has(node);
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
  const exportedBindings = new Set();
  const guardedGotoCalls = collectGuardedGotoCalls(file, ast, diagnostics);

  for (const node of ast.body) {
    if (
      node.type === "ImportDeclaration" &&
      node.source.value === "playwright-core"
    ) {
      for (const specifier of node.specifiers) tainted.add(specifier.local.name);
    }
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration?.type === "VariableDeclaration") {
        for (const declaration of node.declaration.declarations) {
          for (const name of patternIdentifiers(declaration.id)) {
            exportedBindings.add(name);
          }
        }
      }
      if (
        (node.declaration?.type === "FunctionDeclaration" ||
          node.declaration?.type === "ClassDeclaration") &&
        node.declaration.id?.name
      ) {
        exportedBindings.add(node.declaration.id.name);
      }
      for (const specifier of node.specifiers) {
        if (specifier.local.type === "Identifier") {
          exportedBindings.add(specifier.local.name);
        }
      }
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
    if (node.type === "SpreadElement" || node.type === "RestElement") {
      return taintKind(node.argument);
    }
    if (node.type === "Identifier") {
      if (methodBindings.has(node.name)) return "method";
      return tainted.has(node.name) ? "raw" : null;
    }
    if (node.type === "AwaitExpression" || node.type === "ChainExpression") {
      return taintKind(node.argument ?? node.expression);
    }
    if (node.type === "AssignmentExpression") return taintKind(node.right);
    if (node.type === "SequenceExpression") {
      return taintKind(node.expressions.at(-1));
    }
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
    if (node.type === "TemplateLiteral") {
      return node.expressions.some((expression) => taintKind(expression))
        ? "raw"
        : null;
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

  function assignTarget(pattern, kind, methodName) {
    if (!pattern || !kind) return false;
    if (pattern.type === "Identifier") {
      return assignPattern(pattern, kind, methodName);
    }
    if (
      pattern.type === "AssignmentPattern" ||
      pattern.type === "RestElement"
    ) {
      return assignTarget(
        pattern.left ?? pattern.argument,
        kind,
        methodName
      );
    }
    if (pattern.type === "ArrayPattern") {
      let changed = false;
      for (const element of pattern.elements) {
        changed = assignTarget(element, kind, methodName) || changed;
      }
      return changed;
    }
    if (pattern.type === "ObjectPattern") {
      let changed = false;
      for (const property of pattern.properties) {
        changed = assignTarget(
          property.type === "RestElement" ? property.argument : property.value,
          kind,
          methodName
        ) || changed;
      }
      return changed;
    }
    if (
      pattern.type === "MemberExpression" &&
      pattern.object.type === "ThisExpression" &&
      pattern.property.type === "PrivateIdentifier" &&
      !privateFields.has(pattern.property.name)
    ) {
      privateFields.add(pattern.property.name);
      return true;
    }
    return false;
  }

  for (;;) {
    let changed = false;
    walk.full(ast, (node) => {
      if (node.type === "AssignmentPattern") {
        changed = assignTarget(node.left, taintKind(node.right)) || changed;
      }
      if (node.type === "VariableDeclarator") {
        const kind = taintKind(node.init);
        const methodName = node.init?.type === "MemberExpression"
          ? memberName(node.init, constStrings)
          : undefined;
        changed = assignTarget(node.id, kind, methodName) || changed;
      }
      if (node.type === "AssignmentExpression") {
        const kind = taintKind(node.right);
        changed = assignTarget(node.left, kind) || changed;
      }
      if (
        node.type === "PropertyDefinition" &&
        node.key.type === "PrivateIdentifier" &&
        taintKind(node.value) &&
        !privateFields.has(node.key.name)
      ) {
        privateFields.add(node.key.name);
        changed = true;
      }
      if (node.type === "ForOfStatement") {
        const kind = taintKind(node.right);
        if (node.left.type === "VariableDeclaration") {
          for (const declaration of node.left.declarations) {
            changed = assignTarget(declaration.id, kind) || changed;
          }
        } else {
          changed = assignTarget(node.left, kind) || changed;
        }
      }
    });
    if (!changed) break;
  }

  walk.fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors.at(-2);
    if (node.type === "MemberExpression" && taintKind(node.object)) {
      const name = memberName(node, constStrings);
      const pagesZeroIndex =
        node.computed &&
        node.property.type === "Literal" &&
        node.property.value === 0 &&
        node.object.type === "CallExpression" &&
        node.object.callee.type === "MemberExpression" &&
        memberName(node.object.callee, constStrings) === "pages" &&
        Boolean(taintKind(node.object.callee.object));
      if (node.optional || parent?.type === "ChainExpression") {
        diagnostics.push(diagnostic(file, node, "PW_OPTIONAL_FORBIDDEN"));
      }
      if (node.computed && !pagesZeroIndex) {
        diagnostics.push(diagnostic(file, node, "PW_COMPUTED_FORBIDDEN"));
      }
      if (name === undefined) {
        diagnostics.push(diagnostic(file, node, "PW_COMPUTED_UNKNOWN"));
      } else if (
        !/^\d+$/u.test(name) &&
        !PLAYWRIGHT_ALLOWED_MEMBERS.has(name)
      ) {
        diagnostics.push(diagnostic(file, node, "PW_MEMBER_FORBIDDEN"));
      }
      const directAllowedCall =
        parent?.type === "CallExpression" &&
        parent.callee === node &&
        !parent.optional &&
        !node.optional;
      if (
        name !== undefined &&
        PLAYWRIGHT_ALLOWED_MEMBERS.has(name) &&
        !directAllowedCall
      ) {
        diagnostics.push(diagnostic(file, node, "PW_MEMBER_REFERENCE"));
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
      if (node.arguments.some((argument) => taintKind(argument))) {
        diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
      }
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
            guardedGotoCalls
          );
        }
      }
    }

    if (
      node.type === "NewExpression" &&
      node.arguments.some((argument) => taintKind(argument))
    ) {
      diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
    }

    if (
      node.type === "TaggedTemplateExpression" &&
      node.quasi.expressions.some((expression) => taintKind(expression))
    ) {
      diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
    }

    if (
      node.type === "ReturnStatement" &&
      taintKind(node.argument)
    ) {
      diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
    }

    if (
      (node.type === "ThrowStatement" || node.type === "YieldExpression") &&
      taintKind(node.argument)
    ) {
      diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
    }

    if (
      node.type === "PropertyDefinition" &&
      node.key.type !== "PrivateIdentifier" &&
      taintKind(node.value)
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
      node.type === "AssignmentExpression" &&
      taintKind(node.right) &&
      patternIdentifiers(node.left).some((name) => exportedBindings.has(name))
    ) {
      diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
    }

    if (
      node.type === "ForOfStatement" &&
      node.left.type !== "VariableDeclaration" &&
      taintKind(node.right)
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
      if (
        node.declaration?.type === "VariableDeclaration" &&
        node.declaration.declarations.some((declaration) =>
          taintKind(declaration.init)
        )
      ) {
        diagnostics.push(diagnostic(file, node, "PW_RAW_ESCAPE"));
      }
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
  const processAliases = new Set(["process"]);
  const constStrings = collectConstStrings(ast);
  for (;;) {
    let changed = false;
    walk.full(ast, (node) => {
      const target = node.type === "VariableDeclarator"
        ? node.id
        : node.type === "AssignmentExpression"
          ? node.left
          : null;
      const value = node.type === "VariableDeclarator"
        ? node.init
        : node.type === "AssignmentExpression"
          ? node.right
          : null;
      if (
        target?.type === "Identifier" &&
        value?.type === "Identifier" &&
        processAliases.has(value.name) &&
        !processAliases.has(target.name)
      ) {
        processAliases.add(target.name);
        changed = true;
      }
    });
    if (!changed) break;
  }
  walk.full(ast, (node) => {
    if (node.type === "ObjectPattern") {
      for (const property of node.properties) {
        if (property.type !== "Property") continue;
        const name = property.computed
          ? staticString(property.key, constStrings)
          : property.key.name ?? String(property.key.value);
        if (name === "createRequire") {
          diagnostics.push(
            diagnostic(file, property, "DYNAMIC_REQUIRE_FORBIDDEN")
          );
        } else if (["constructor", "getBuiltinModule"].includes(name)) {
          diagnostics.push(
            diagnostic(file, property, "DYNAMIC_ESCAPE_FORBIDDEN")
          );
        }
      }
    }
    if (
      node.type === "ImportDeclaration" &&
      ["module", "node:module"].includes(node.source.value)
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_REQUIRE_FORBIDDEN"));
    }
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
      if (
        DYNAMIC_ESCAPE_MEMBERS.get(owner)?.has(name) ||
        (processAliases.has(owner) && name === "getBuiltinModule")
      ) {
        diagnostics.push(diagnostic(file, node, "DYNAMIC_ESCAPE_FORBIDDEN"));
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "Identifier" &&
      processAliases.has(node.init.name) &&
      node.id.name !== "process"
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_ESCAPE_FORBIDDEN"));
    }
  });
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors.at(-2);
    const isNonComputedPropertyName =
      (parent?.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed) ||
      (parent?.type === "Property" &&
        parent.key === node &&
        !parent.computed);
    if (
      node.type === "Identifier" &&
      DYNAMIC_GLOBAL_ROOTS.has(node.name) &&
      !isNonComputedPropertyName
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_GLOBAL_FORBIDDEN"));
    }
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
      node.type === "MemberExpression" &&
      memberName(node, new Map()) === "constructor"
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_ESCAPE_FORBIDDEN"));
    }
    if (
      node.type === "MemberExpression" &&
      memberName(node, new Map()) === "createRequire"
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_REQUIRE_FORBIDDEN"));
    }
    if (
      node.type === "Identifier" &&
      ["eval", "Function", "require", "createRequire"].includes(node.name) &&
      !isNonComputedPropertyName &&
      !(
        parent?.type === "Property" &&
        parent.key === node &&
        parent.shorthand
      )
    ) {
      diagnostics.push(diagnostic(file, node, "DYNAMIC_ESCAPE_FORBIDDEN"));
    }
  });
}

function relativeModuleTarget(file, specifier) {
  if (
    typeof specifier !== "string" ||
    !specifier.startsWith(".") ||
    /[?#\\]/u.test(specifier)
  ) {
    return null;
  }
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier)
  );
}

function scanPassiveEdgeImportSeam(file, ast, diagnostics) {
  if (!ast) return;
  const importedBindings = new Set();
  for (const node of ast.body) {
    if (
      relativeModuleTarget(file, node.source?.value) !== PASSIVE_EDGE_FILE
    ) {
      continue;
    }
    if (node.type !== "ImportDeclaration") {
      diagnostics.push(
        diagnostic(file, node, "PASSIVE_EDGE_REEXPORT_FORBIDDEN")
      );
      continue;
    }
    const valid =
      node.specifiers.length === 1 &&
      node.specifiers[0].type === "ImportSpecifier" &&
      node.specifiers[0].imported.name === "PassiveEdge" &&
      node.specifiers[0].local.name === "PassiveEdge";
    if (!valid) {
      diagnostics.push(
        diagnostic(file, node, "PASSIVE_EDGE_IMPORT_SHAPE")
      );
    } else {
      importedBindings.add(node.specifiers[0].local.name);
    }
  }
  const referencesImportedBinding = (node) => {
    if (!node) return false;
    let found = false;
    walk.full(node, (child) => {
      if (
        child.type === "Identifier" &&
        importedBindings.has(child.name)
      ) {
        found = true;
      }
    });
    return found;
  };
  const aliasesImportedBinding = (node) => {
    if (!node) return false;
    if (node.type === "Identifier") {
      return importedBindings.has(node.name);
    }
    if (
      node.type === "ChainExpression" ||
      node.type === "AwaitExpression"
    ) {
      return aliasesImportedBinding(node.expression ?? node.argument);
    }
    if (node.type === "AssignmentExpression") {
      return aliasesImportedBinding(node.right);
    }
    if (node.type === "SequenceExpression") {
      return aliasesImportedBinding(node.expressions.at(-1));
    }
    if (
      node.type === "LogicalExpression" ||
      node.type === "ConditionalExpression"
    ) {
      const candidates = node.type === "ConditionalExpression"
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
      return candidates.some(aliasesImportedBinding);
    }
    if (node.type === "ClassExpression") {
      return aliasesImportedBinding(node.superClass);
    }
    return false;
  };
  for (;;) {
    let changed = false;
    walk.full(ast, (node) => {
      const target = node.type === "VariableDeclarator"
        ? node.id
        : node.type === "AssignmentExpression"
          ? node.left
          : null;
      const value = node.type === "VariableDeclarator"
        ? node.init
        : node.type === "AssignmentExpression"
          ? node.right
          : null;
      if (
        target?.type === "Identifier" &&
        aliasesImportedBinding(value) &&
        !importedBindings.has(target.name)
      ) {
        importedBindings.add(target.name);
        changed = true;
      }
      if (
        node.type === "ClassDeclaration" &&
        node.id?.name &&
        referencesImportedBinding(node.superClass) &&
        !importedBindings.has(node.id.name)
      ) {
        importedBindings.add(node.id.name);
        changed = true;
      }
    });
    if (!changed) break;
  }
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    if (
      node.type !== "Identifier" ||
      !importedBindings.has(node.name)
    ) {
      return;
    }
    const parent = ancestors.at(-2);
    const importSpecifier = parent?.type === "ImportSpecifier";
    const directConstruction =
      parent?.type === "NewExpression" && parent.callee === node;
    const nonReferencePropertyKey =
      (parent?.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed) ||
      (parent?.type === "Property" &&
        parent.key === node &&
        !parent.computed &&
        !parent.shorthand) ||
      (parent?.type === "MethodDefinition" &&
        parent.key === node &&
        !parent.computed);
    if (!importSpecifier && !directConstruction && !nonReferencePropertyKey) {
      diagnostics.push(
        diagnostic(file, node, "PASSIVE_EDGE_REEXPORT_FORBIDDEN")
      );
    }
  });
  for (const node of ast.body) {
    if (
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportDefaultDeclaration"
    ) {
      continue;
    }
    let exportReferencesImportedBinding = node.type === "ExportNamedDeclaration" &&
      node.specifiers.some((specifier) =>
        specifier.local.type === "Identifier" &&
        importedBindings.has(specifier.local.name)
      );
    walk.full(node, (child) => {
      if (
        child.type === "Identifier" &&
        importedBindings.has(child.name)
      ) {
        exportReferencesImportedBinding = true;
      }
    });
    if (exportReferencesImportedBinding) {
      diagnostics.push(
        diagnostic(file, node, "PASSIVE_EDGE_REEXPORT_FORBIDDEN")
      );
    }
  }
}

function scanPassiveEdgeConstructors(file, ast, diagnostics) {
  if (!ast) return;
  const bindings = new Set();
  const instances = new Set();
  const constStrings = collectConstStrings(ast);
  for (const node of ast.body) {
    if (
      node.type === "ImportDeclaration" &&
      relativeModuleTarget(file, node.source.value) === PASSIVE_EDGE_FILE
    ) {
      for (const specifier of node.specifiers) {
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.imported.name === "PassiveEdge" &&
          specifier.local.name === "PassiveEdge"
        ) {
          bindings.add(specifier.local.name);
        }
      }
    }
  }
  if (file === PASSIVE_EDGE_FILE) bindings.add("PassiveEdge");

  function references(values, node) {
    if (!node) return false;
    if (node.type === "Identifier") return values.has(node.name);
    if (
      node.type === "ChainExpression" ||
      node.type === "AwaitExpression"
    ) {
      return references(values, node.expression ?? node.argument);
    }
    if (node.type === "AssignmentExpression") {
      return references(values, node.right);
    }
    if (node.type === "SequenceExpression") {
      return references(values, node.expressions.at(-1));
    }
    if (
      node.type === "LogicalExpression" ||
      node.type === "ConditionalExpression"
    ) {
      const candidates = node.type === "ConditionalExpression"
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
      return candidates.some((candidate) => references(values, candidate));
    }
    if (node.type === "ClassExpression") {
      return references(values, node.superClass);
    }
    return false;
  }

  function isPassiveEdgeConstruction(node) {
    return (
      node?.type === "NewExpression" &&
      references(bindings, node.callee)
    );
  }

  for (;;) {
    let changed = false;
    walk.full(ast, (node) => {
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier"
      ) {
        if (references(bindings, node.init) && !bindings.has(node.id.name)) {
          bindings.add(node.id.name);
          changed = true;
        }
        if (
          (isPassiveEdgeConstruction(node.init) ||
            references(instances, node.init)) &&
          !instances.has(node.id.name)
        ) {
          instances.add(node.id.name);
          changed = true;
        }
      }
      if (
        node.type === "AssignmentExpression" &&
        node.left.type === "Identifier"
      ) {
        if (references(bindings, node.right) && !bindings.has(node.left.name)) {
          bindings.add(node.left.name);
          changed = true;
        }
        if (
          (isPassiveEdgeConstruction(node.right) ||
            references(instances, node.right)) &&
          !instances.has(node.left.name)
        ) {
          instances.add(node.left.name);
          changed = true;
        }
      }
      if (
        node.type === "ClassDeclaration" &&
        node.id?.name &&
        references(bindings, node.superClass) &&
        !bindings.has(node.id.name)
      ) {
        bindings.add(node.id.name);
        changed = true;
      }
    });
    if (!changed) break;
  }

  walk.full(ast, (node) => {
    if (isPassiveEdgeConstruction(node)) {
      const options = node.arguments[0];
      if (!objectKeysAllowed(options, new Set(["profileDir", "headless"]))) {
        diagnostics.push(diagnostic(file, node, "PASSIVE_EDGE_CONSTRUCTOR"));
      }
    }
  });

  walk.full(ast, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression" ||
      memberName(node.callee, constStrings) !== "open"
    ) {
      return;
    }
    const receiver = node.callee.object;
    const owned =
      references(instances, receiver) ||
      isPassiveEdgeConstruction(receiver);
    if (!owned) return;
    if (staticString(node.arguments[0], constStrings) !== TARGET) {
      diagnostics.push(
        diagnostic(file, node, "PASSIVE_EDGE_OPEN_UNSAFE")
      );
    }
  });
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
    scanPassiveEdgeImportSeam(file, asts.get(file), diagnostics);
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

export async function auditNoInputProject(options = {}) {
  const srcDir = path.resolve(options.srcDir ?? path.resolve("src"));
  const project = await collectProjectSources(srcDir);
  const astDiagnostics = auditSourceSet(project.sources, {
    automatedEntries: options.automatedEntries ?? DEFAULT_AUTOMATED_ENTRIES
  });
  const grepDiagnostics = [];
  for (const [file, source] of project.sources) {
    grepDiagnostics.push(...grepForbiddenSource(source, file));
  }
  return sortDiagnostics([
    ...project.diagnostics,
    ...astDiagnostics,
    ...grepDiagnostics
  ]);
}
