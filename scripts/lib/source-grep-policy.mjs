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

function normalizeFile(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function lineColumnAt(source, index) {
  const before = source.slice(0, index).split(/\r?\n/u);
  return { line: before.length, column: before.at(-1).length + 1 };
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

function decodedEscape(_match, braced, fixed, short) {
  const hex = braced ?? fixed ?? short;
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value) || value > 0x10ffff) return _match;
  return String.fromCodePoint(value);
}

function normalizeRawSource(source) {
  let normalized = source
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/gu, decodedEscape)
    .replace(/\?\.\s*(?=\[)/gu, "")
    .replace(/\?\./gu, ".");

  const concatenatedStrings =
    /(["'])([^"'\\\r\n]*)\1\s*\+\s*(["'])([^"'\\\r\n]*)\3/gu;
  for (let pass = 0; pass < 12; pass += 1) {
    const collapsed = normalized.replace(
      concatenatedStrings,
      (_match, quote, left, _rightQuote, right) =>
        quote + left + right + quote
    );
    if (collapsed === normalized) break;
    normalized = collapsed;
  }

  const constants = new Map();
  const constantPattern =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])([^"'\r\n]+)\2\s*;/gu;
  let constant;
  while ((constant = constantPattern.exec(normalized)) !== null) {
    if (FORBIDDEN_MEMBER_NAMES.has(constant[3])) {
      constants.set(constant[1], constant[3]);
    }
  }
  for (const [name, value] of constants) {
    const escapedName = name.replace(/[$]/gu, "\\$&");
    normalized = normalized.replace(
      new RegExp(`\\[\\s*${escapedName}\\s*\\]`, "gu"),
      `["${value}"]`
    );
  }
  return normalized;
}

export function grepForbiddenSource(source, file = "source.mjs") {
  const normalized = normalizeRawSource(String(source));
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
  while ((match = expression.exec(normalized)) !== null) {
    diagnostics.push({
      file: normalizeFile(file),
      ...lineColumnAt(normalized, match.index),
      code: "SOURCE_INPUT_TOKEN"
    });
  }
  return sortDiagnostics(diagnostics);
}
