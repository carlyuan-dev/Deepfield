import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

// Follow the entire local import graph, including barrels and dynamic imports.
// Only the actual neutral TypeBox runtime dependencies are allowed externally.
function checkBoundary(entries: string[], read: (path: string) => string, root: string): void {
  const visited = new Set<string>();
  function visit(path: string) {
    if (visited.has(path)) return;
    if (!path.startsWith(`${root}/`)) throw new Error(`Base reverse dependency: ${path}`);
    visited.add(path);
    const source = parse(read(path), { sourceType: "module", plugins: ["typescript"], createImportExpressions: true });
    function dependency(node: unknown) {
      const literal = node as { type?: string; value?: string } | undefined;
      if (literal?.type !== "StringLiteral" || typeof literal.value !== "string") throw new Error("Unverifiable dynamic dependency");
      const name = literal.value;
      if (name === "typebox" || name === "typebox/value") return;
      if (!name.startsWith(".")) throw new Error(`Forbidden Base dependency: ${name}`);
      visit(resolve(dirname(path), name.replace(/\.js$/, ".ts")));
    }
    function scan(value: unknown) {
      if (Array.isArray(value)) { value.forEach(scan); return; }
      if (value === null || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(node.type)) && node.source) dependency(node.source);
      if (node.type === "TSImportType") dependency(node.argument);
      if (node.type === "TSExternalModuleReference") dependency(node.expression);
      if (node.type === "CallExpression") {
        const callee = node.callee as { type?: string; name?: string };
        if (callee.type === "Import" || (callee.type === "Identifier" && callee.name === "require")) dependency((node.arguments as unknown[])[0]);
      }
      Object.values(node).forEach(scan);
    }
    scan(source);
  }
  entries.forEach(visit);
}
describe("Base dependency direction", () => {
  it("keeps actual production source isolated from apps, UI and business packages", () => {
    const root = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
    const files = readdirSync(root, { recursive: true }).map(String).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    expect(() => checkBoundary(files.map((file) => resolve(root, file)), (path) => readFileSync(path, "utf8"), root)).not.toThrow();
  });
  it.each([
    'export * from "@deepfield/application"',
    'export { x } from "../../apps/desktop/x.js"',
    'const load = () => import("@deepfield/contracts")',
    'import type { X } from "electron"',
    'const react = require("react")',
    'type Business = import("@deepfield/persistence").Repositories',
    'const load = (name: string) => import(name)',
  ])("rejects forbidden transitive edges: %s", (edge) => {
    const files: Record<string, string> = { "/base/index.ts": 'export * from "./bridge.js";', "/base/bridge.ts": edge };
    expect(() => checkBoundary(["/base/index.ts"], (path) => files[path]!, "/base")).toThrow();
  });
  it("permits neutral TypeBox imports through local re-exports", () => {
    const files: Record<string, string> = { "/base/index.ts": 'export * from "./bridge.js"', "/base/bridge.ts": 'import { Type } from "typebox"; import { Value } from "typebox/value";' };
    expect(() => checkBoundary(["/base/index.ts"], (path) => files[path]!, "/base")).not.toThrow();
  });
});
