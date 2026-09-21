import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import type { Plugin as CssPlugin } from "postcss";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const renderer = resolve(repoRoot, "apps/desktop/src/renderer");

export interface CapabilityUiBuildOptions {
  entry: string;
  css: string;
  capabilityId: string;
  outDir: string;
}

/** Every injected import is evaluated inside createView, after binding the runtime. */
export async function buildCapabilityUi(options: CapabilityUiBuildOptions): Promise<string[]> {
  if (!/^[a-z][a-z0-9-]*$/.test(options.capabilityId)) throw new Error("invalid_capability_id");
  const modules = new Set<string>();
  const shims: Record<string, string> = {
    react: 'export const {useCallback,useEffect,useMemo,useRef,useState,useId}=__capabilityRuntime.react;',
    "react/jsx-runtime": 'export const {jsx,jsxs,Fragment}=__capabilityRuntime.jsx;',
    [resolve(renderer, "features/industry-research/Modal.tsx")]: 'export const {Modal}=__capabilityRuntime;',
    [resolve(renderer, "components/MarkdownMessage.tsx")]: 'export const {MarkdownMessage}=__capabilityRuntime;',
    [resolve(renderer, "components/UrlPopoverLink.tsx")]: 'export const {UrlPopoverLink,isSafeHttpUrl}=__capabilityRuntime;',
  };
  const injection: Plugin = {
    name: "capability-ui-runtime",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "capability-ui-entry" || source === resolve("capability-ui-entry")) return "\0capability-ui-entry";
      const absolute = importer && source.startsWith(".") ? resolve(dirname(importer), source).replace(/\.js$/, ".tsx") : source;
      return shims[absolute] ? `\0capability-shim:${absolute}` : undefined;
    },
    load(id) {
      if (id === "\0capability-ui-entry") return `import ${JSON.stringify(options.css)}; export {View} from ${JSON.stringify(options.entry)};`;
      if (id.startsWith("\0capability-shim:")) return shims[id.slice("\0capability-shim:".length)];
    },
    moduleParsed(module) {
      modules.add(module.id);
      if (/node_modules\/(?:react|react-dom)\//.test(module.id)) throw new Error("capability_must_use_host_react");
    },
    generateBundle(_options, bundle) {
      // Wrap only after Vite's render/minify hooks have finalized the IIFE.
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") output.code = `export function createView(__capabilityRuntime) {\n${output.code}\nreturn CapabilityViewBundle.View;\n}`;
      }
    },
  };
  const scopeCss: CssPlugin = {
    postcssPlugin: "capability-css-scope",
    Once(root) {
      root.walkRules(rule => {
        if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
        rule.selectors = rule.selectors.map(selector => `:where([data-capability-ui="${options.capabilityId}"]) ${selector}`);
      });
    },
  };
  await build({
    configFile: false, logLevel: "silent",
    plugins: [injection],
    resolve: { alias: { "@deepfield/contracts": resolve(repoRoot, "packages/contracts/src/index.ts") } },
    esbuild: { jsx: "automatic", jsxDev: false },
    css: { postcss: { plugins: [scopeCss] } },
    build: {
      emptyOutDir: false, minify: false, cssMinify: false, outDir: options.outDir,
      lib: { entry: "capability-ui-entry", formats: ["iife"], name: "CapabilityViewBundle", fileName: () => "ui.js", cssFileName: "ui" },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  return [...modules].sort();
}
