import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { escapeRegex } from "./utils/regex";
import { getHistoryShortcutLabel } from "./utils/historyShortcuts";
import { settingsSectionLabel } from "./motion/settingsMeta";

const studioSrcDir = import.meta.dirname;
const resolveExts = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
const jsToTsSwaps: readonly [RegExp, readonly string[]][] = [
  [/\.jsx$/i, [".tsx", ".ts"]],
  [/\.js$/i, [".ts", ".tsx"]],
  [/\.mjs$/i, [".mts", ".ts"]],
  [/\.cjs$/i, [".cts", ".ts"]],
];

function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const ext of resolveExts) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const [pattern, replacements] of jsToTsSwaps) {
    if (!pattern.test(base)) continue;
    for (const replacement of replacements) {
      const candidate = base.replace(pattern, replacement);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false; // Side-effect import: `import "pkg"`
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // Default value import
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}

function collectRuntimeSpecifiers(sourceText: string, fileName: string): string[] {
  const scriptKind = fileName.endsWith(".tsx") || fileName.endsWith(".jsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, scriptKind);
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!isTypeOnlyImport(statement.importClause)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      if (!isTypeOnlyExport(statement)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }

  return specifiers;
}

function collectStaticImportGraph(entryFile: string): {
  files: Set<string>;
  externalChains: Map<string, string[]>;
  fileChains: Map<string, string[]>;
} {
  const visited = new Set<string>([entryFile]);
  const parent = new Map<string, string | null>([[entryFile, null]]);
  const externalChains = new Map<string, string[]>();
  const fileChains = new Map<string, string[]>();
  const queue = [entryFile];

  const chainFor = (file: string, leaf?: string) => {
    const chain: string[] = leaf ? [leaf] : [];
    let current: string | null | undefined = file;
    while (current) {
      chain.unshift(path.relative(studioSrcDir, current));
      current = parent.get(current);
    }
    return chain;
  };

  fileChains.set(entryFile, chainFor(entryFile));

  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = readFileSync(current, "utf8");
    for (const specifier of collectRuntimeSpecifiers(source, current)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(current, specifier);
        if (resolved && !visited.has(resolved)) {
          visited.add(resolved);
          parent.set(resolved, current);
          fileChains.set(resolved, chainFor(resolved));
          queue.push(resolved);
        }
      } else if (!externalChains.has(specifier)) {
        externalChains.set(specifier, chainFor(current, specifier));
      }
    }
  }

  return { files: visited, externalChains, fileChains };
}

describe("Studio entry shell dependency boundary", () => {
  it("keeps @hyperframes/parsers barrel and heavy editor helpers out of main.tsx static graph", () => {
    const mainEntry = path.resolve(studioSrcDir, "main.tsx");
    const graph = collectStaticImportGraph(mainEntry);

    const forbiddenExternals = [
      "@hyperframes/parsers",
      "@babel/parser",
      "recast",
      "esprima",
      "acorn",
      "cssomnom",
      "linkedom",
    ];
    for (const pkg of forbiddenExternals) {
      expect(
        graph.externalChains.get(pkg),
        `main.tsx must not statically import ${pkg}`,
      ).toBeUndefined();
    }

    const forbiddenEditorModules = [
      path.resolve(studioSrcDir, "utils/sourcePatcher.ts"),
      path.resolve(studioSrcDir, "utils/studioHelpers.ts"),
    ];
    for (const mod of forbiddenEditorModules) {
      expect(
        graph.fileChains.get(mod),
        `main.tsx must not statically import ${path.relative(studioSrcDir, mod)}`,
      ).toBeUndefined();
    }
  });

  it("keeps WorkspaceBreadcrumb decoupled from SettingsCenter", () => {
    const breadcrumb = path.resolve(studioSrcDir, "motion/WorkspaceBreadcrumb.tsx");
    const settingsCenter = path.resolve(studioSrcDir, "motion/SettingsCenter.tsx");
    const graph = collectStaticImportGraph(breadcrumb);
    expect(graph.fileChains.get(settingsCenter)).toBeUndefined();
  });

  it("captures side-effect imports and resolves bundler .js -> .ts/.tsx specifiers", () => {
    const sample = [
      'import "@hyperframes/parsers";',
      'import type { Foo } from "type-only-pkg";',
      'import { type Bar } from "inline-type-only-pkg";',
      'import { type Baz, realValue } from "mixed-pkg";',
      'export { helper } from "./utils/regex.js";',
      'export type { SettingsSectionMeta } from "./motion/settingsMeta.js";',
    ].join("\n");

    expect(collectRuntimeSpecifiers(sample, "virtual.tsx")).toEqual([
      "@hyperframes/parsers",
      "mixed-pkg",
      "./utils/regex.js",
    ]);

    expect(
      resolveRelativeModule(path.resolve(studioSrcDir, "main.tsx"), "./utils/regex.js"),
    ).toBe(path.resolve(studioSrcDir, "utils/regex.ts"));
    expect(
      resolveRelativeModule(
        path.resolve(studioSrcDir, "components/editor/PropertyPanelFlat.tsx"),
        "./propertyPanelAudioFxGroup.js",
      ),
    ).toBe(path.resolve(studioSrcDir, "components/editor/propertyPanelAudioFxGroup.tsx"));
  });

  it("preserves extracted lightweight shell helper behavior", () => {
    expect(escapeRegex("a+b*(c)?[d]")).toBe("a\\+b\\*\\(c\\)\\?\\[d\\]");
    expect(getHistoryShortcutLabel("undo")).toMatch(/^(?:Cmd|Ctrl)\+Z$/);
    expect(getHistoryShortcutLabel("redo")).toMatch(/^(?:Cmd|Ctrl)\+Shift\+Z$/);
    expect(settingsSectionLabel("providers")).toBe("Model providers");
    expect(settingsSectionLabel("brand-kit")).toBe("Settings");
  });
});
