import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

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
    (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier) &&
      !specifier.startsWith("node:")) ||
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

export function buildAutomatedGraph(
  sources,
  asts,
  entries,
  diagnostics
) {
  const roots = entries.map(normalizeFile).filter((file) => sources.has(file));
  const visited = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.startsWith("src/cli/") && !roots.includes(file)) {
      diagnostics.push(
        diagnostic(file, asts.get(file), "AUTOMATED_CLI_FORBIDDEN")
      );
    }
    for (const { value, node } of moduleSpecifiers(
      asts.get(file),
      sources.get(file)
    )) {
      if (typeof value !== "string") continue;
      if (value.startsWith("#")) {
        diagnostics.push(
          diagnostic(file, node, "IMPORT_ALIAS_FORBIDDEN")
        );
        continue;
      }
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

async function collectSourceFiles(root, relative, state) {
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
    const logical = normalizeFile(
      path.posix.join("src", nextRelative.replaceAll("\\", "/"))
    );
    const resolved = await realpath(absolute);
    const relativeReal = path.relative(state.realRoot, resolved);
    if (relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) {
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

export async function collectProjectSources(srcDir) {
  const root = path.resolve(srcDir);
  const state = {
    sources: new Map(),
    diagnostics: [],
    realRoot: await realpath(root)
  };
  await collectSourceFiles(root, "", state);
  return {
    sources: state.sources,
    diagnostics: state.diagnostics
  };
}
