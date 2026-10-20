import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

interface BoundaryLayout {
  repositoryRoot: string;
  agentRoot: string;
  toolProjectionFiles: ReadonlySet<string>;
}

const PACKAGE_ENTRIES = {
  "@deepfield/base/config": {
    packageDirectory: "packages/base", exportKey: "./config", target: "./src/config/index.ts",
  },
  "@deepfield/base/agent": {
    packageDirectory: "packages/base", exportKey: "./agent", target: "./src/agent/index.ts",
  },
  "@deepfield/base/agent/runtime": {
    packageDirectory: "packages/base", exportKey: "./agent/runtime", target: "./src/agent/runtime.ts",
  },
  "@deepfield/base/model": {
    packageDirectory: "packages/base", exportKey: "./model", target: "./src/model/index.ts",
  },
  "@deepfield/capability-sdk/execution": {
    packageDirectory: "packages/capability-sdk", exportKey: "./execution", target: "./src/execution.ts",
  },
  "@deepfield/capability-sdk/model-observation": {
    packageDirectory: "packages/capability-sdk", exportKey: "./model-observation", target: "./src/model-observation.ts",
  },
  "@deepfield/contracts/model-config": {
    packageDirectory: "packages/contracts",
    exportKey: "./model-config",
    target: "./src/model-config.ts",
  },
  "@deepfield/contracts/tools": {
    packageDirectory: "packages/contracts",
    exportKey: "./tools",
    target: "./src/tools.ts",
  },
  "@deepfield/base/tools": {
    packageDirectory: "packages/base",
    exportKey: "./tools",
    target: "./src/tools/index.ts",
  },
  "@deepfield/base/search": {
    packageDirectory: "packages/base",
    exportKey: "./search",
    target: "./src/search/index.ts",
  },
} as const;

function checkExecutionBoundary(
  entries: readonly string[],
  read: (path: string) => string,
  layout: BoundaryLayout,
): Set<string> {
  const visited = new Set<string>();
  const resolvedPackageEntries = new Set<string>();
  const tsconfig = JSON.parse(read(resolve(layout.repositoryRoot, "tsconfig.base.json"))) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };

  const assertAllowedSource = (path: string): void => {
    const insideAgent = path.startsWith(`${layout.agentRoot}/`);
    if (insideAgent && !path.endsWith(".test.ts")) {
      const name = path.slice(layout.agentRoot.length + 1);
      if (name !== "pi-chat-agent.ts" && name !== "pi-default-runtime.ts") return;
    }
    if (layout.toolProjectionFiles.has(path)) return;
    if ([
      resolve(layout.repositoryRoot, "packages/contracts/src/model-config.ts"),
      resolve(layout.repositoryRoot, "packages/contracts/src/tools.ts"),
      ...["execution", "model-observation"].map(file => resolve(layout.repositoryRoot, `packages/capability-sdk/src/${file}.ts`)),
      ...["index", "runtime", "message-utils", "errors"].map(file => resolve(layout.repositoryRoot, `packages/base/src/agent/${file}.ts`)),
      ...["index", "contracts", "observation", "errors"].map(file => resolve(layout.repositoryRoot, `packages/base/src/model/${file}.ts`)),
      ...["index", "llm", "search", "definition", "types", "config-error"].map(file => resolve(layout.repositoryRoot, `packages/base/src/config/${file}.ts`)),
      ...["index", "errors"].map(file => resolve(layout.repositoryRoot, `packages/base/src/errors/${file}.ts`)),
      ...["index", "contracts", "definition", "errors", "budget-contract", "budget", "audit", "tool-set", "events", "retry"].map((file) => resolve(layout.repositoryRoot, `packages/base/src/tools/${file}.ts`)),
      ...["index", "search-provider", "output-contracts", "source-date", "errors", "parsing-contracts", "html-limits"].map((file) => resolve(layout.repositoryRoot, `packages/base/src/search/${file}.ts`)),
    ].includes(path)) return;
    throw new Error(`Forbidden executor source dependency: ${path}`);
  };

  const resolveRelative = (importer: string, specifier: string): string => {
    const raw = resolve(dirname(importer), specifier);
    if (raw.endsWith(".js")) return `${raw.slice(0, -3)}.ts`;
    return raw;
  };

  const resolvePackageEntry = (specifier: keyof typeof PACKAGE_ENTRIES): string => {
    const entry = PACKAGE_ENTRIES[specifier];
    const packageRoot = resolve(layout.repositoryRoot, entry.packageDirectory);
    const manifest = JSON.parse(read(resolve(packageRoot, "package.json"))) as {
      exports?: Record<string, string>;
    };
    if (manifest.exports?.[entry.exportKey] !== entry.target) {
      throw new Error(`Unverified package export: ${specifier}`);
    }
    const expectedPath = `./${entry.packageDirectory}/${entry.target.slice(2)}`;
    const configuredPaths = tsconfig.compilerOptions?.paths?.[specifier];
    if (configuredPaths?.length !== 1 || configuredPaths[0] !== expectedPath) {
      throw new Error(`Unverified TypeScript path: ${specifier}`);
    }
    resolvedPackageEntries.add(specifier);
    return resolve(packageRoot, entry.target);
  };

  const visit = (path: string): void => {
    if (visited.has(path)) return;
    assertAllowedSource(path);
    visited.add(path);
    const source = parse(read(path), {
      sourceType: "module",
      plugins: ["typescript"],
      createImportExpressions: true,
    });

    const dependency = (node: unknown): void => {
      const literal = node as { type?: string; value?: unknown } | undefined;
      if (literal?.type !== "StringLiteral" || typeof literal.value !== "string") {
        throw new Error(`Unverifiable dynamic executor dependency in ${path}`);
      }
      const specifier = literal.value;
      if (specifier.startsWith(".")) {
        visit(resolveRelative(path, specifier));
        return;
      }
      if (specifier in PACKAGE_ENTRIES) {
        visit(resolvePackageEntry(specifier as keyof typeof PACKAGE_ENTRIES));
        return;
      }
      if (
        specifier === "@earendil-works/pi-agent-core" ||
        specifier === "@earendil-works/pi-ai" ||
        specifier === "node:crypto" ||
        specifier === "typebox" ||
        specifier.startsWith("typebox/")
      ) return;
      throw new Error(`Forbidden executor dependency: ${specifier}`);
    };

    const scan = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(scan);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (
        ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]
          .includes(String(node.type)) && node.source
      ) dependency(node.source);
      if (node.type === "TSImportType") dependency(node.argument);
      if (node.type === "TSExternalModuleReference") dependency(node.expression);
      if (node.type === "CallExpression") {
        const callee = node.callee as { type?: string; name?: string } | undefined;
        if (
          callee?.type === "Import" ||
          (callee?.type === "Identifier" && callee.name === "require")
        ) dependency((node.arguments as unknown[])[0]);
      }
      Object.values(node).forEach(scan);
    };
    scan(source);
  };

  entries.forEach(visit);
  return resolvedPackageEntries;
}

describe("Pi executor dependency boundary", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\/$/u, "");
  const agentRoot = resolve(repositoryRoot, "apps/desktop/src/worker/agent");
  const layout: BoundaryLayout = {
    repositoryRoot,
    agentRoot,
    toolProjectionFiles: new Set([
      resolve(repositoryRoot, "apps/desktop/src/worker/tools/tool-activity.ts"),
      resolve(repositoryRoot, "apps/desktop/src/worker/tools/tool-source-projection.ts"),
    ]),
  };

  it("keeps the executor and its three contract entries on neutral narrow dependencies", () => {
    const packageEntries = checkExecutionBoundary([
      resolve(agentRoot, "pi-agent-executor.ts"),
      resolve(agentRoot, "pi-execution-contract.ts"),
      resolve(agentRoot, "pi-runtime.ts"),
      resolve(agentRoot, "pi-executor-dependencies.ts"),
    ], (path) => readFileSync(path, "utf8"), layout);
    expect(packageEntries).toEqual(new Set(Object.keys(PACKAGE_ENTRIES)));
  });

  it("resolves the Tools safe export and alias through only its precise contract dependencies", () => {
    const entry = resolve(agentRoot, "tools-boundary-fixture.ts");
    const entries = checkExecutionBoundary([entry], (path) => path === entry
      ? 'import type { ToolBudgetSnapshot } from "@deepfield/base/tools";'
      : readFileSync(path, "utf8"), layout);
    expect(entries).toEqual(new Set(["@deepfield/base/tools"]));
  });

  it.each([
    {
      edge: "the SDK aggregate export",
      files: { "entry.ts": 'import type { PiExecutionRequest } from "@deepfield/capability-sdk";' },
      error: "@deepfield/capability-sdk",
    },
    {
      edge: "a type re-export through the local Chat factory",
      files: {
        "entry.ts": 'import type { X } from "./relay.js";',
        "relay.ts": 'export type { X } from "./pi-chat-agent.js";',
        "pi-chat-agent.ts": "export interface X {}",
      },
      error: "pi-chat-agent.ts",
    },
    {
      edge: "a local re-export through a package root barrel",
      files: {
        "entry.ts": 'export type { X } from "./relay.js";',
        "relay.ts": 'export type { ToolAccessPolicy as X } from "@deepfield/contracts";',
      },
      error: "@deepfield/contracts",
    },
    {
      edge: "a non-literal dynamic import",
      files: {
        "entry.ts": 'const dependency = "./relay.js"; void import(dependency);',
      },
      error: "Unverifiable dynamic executor dependency",
    },
    {
      edge: "a CommonJS package root import",
      files: {
        "entry.ts": 'require("@deepfield/tool-platform");',
      },
      error: "@deepfield/tool-platform",
    },
  ])("rejects $edge", ({ files, error }) => {
    const fixtureRoot = "/virtual/apps/desktop/src/worker/agent";
    const fixtureFiles = Object.fromEntries(
      Object.entries(files).map(([name, source]) => [resolve(fixtureRoot, name), source]),
    );
    const fixtureLayout: BoundaryLayout = {
      repositoryRoot,
      agentRoot: fixtureRoot,
      toolProjectionFiles: new Set(),
    };
    const read = (path: string): string => fixtureFiles[path] ?? readFileSync(path, "utf8");
    expect(() => checkExecutionBoundary([resolve(fixtureRoot, "entry.ts")], read, fixtureLayout))
      .toThrow(error);
  });
});
