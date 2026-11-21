import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { escapeRegex } from "./utils/regex";
import { getHistoryShortcutLabel } from "./utils/historyShortcuts";
import { settingsSectionLabel } from "./motion/settingsMeta";

const studioSrcDir = import.meta.dirname;
const resolveExts = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const ext of resolveExts) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
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
    const importRe =
      /^\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source))) {
      const specifier = match[1]!;
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

  it("preserves extracted lightweight shell helper behavior", () => {
    expect(escapeRegex("a+b*(c)?[d]")).toBe("a\\+b\\*\\(c\\)\\?\\[d\\]");
    expect(getHistoryShortcutLabel("undo")).toMatch(/^(?:Cmd|Ctrl)\+Z$/);
    expect(getHistoryShortcutLabel("redo")).toMatch(/^(?:Cmd|Ctrl)\+Shift\+Z$/);
    expect(settingsSectionLabel("providers")).toBe("Model providers");
    expect(settingsSectionLabel("brand-kit")).toBe("Settings");
  });
});
