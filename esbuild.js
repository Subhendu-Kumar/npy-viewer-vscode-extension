const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log("[watch] build finished");
    });
  },
};

/**
 * Copies non-bundled runtime assets (the NumPy loader script, webview stylesheet)
 * into dist/ so they ship with the packaged extension.
 * @type {import('esbuild').Plugin}
 */
const copyAssetsPlugin = {
  name: "copy-assets",

  setup(build) {
    build.onEnd(() => {
      const assets = [
        ["src/python/npy_load.py", "dist/npy_load.py"],
        ["src/webview/style.css", "dist/webview.css"],
      ];
      for (const [from, to] of assets) {
        const src = path.join(__dirname, from);
        const dest = path.join(__dirname, to);
        if (!fs.existsSync(src)) {
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/extension.js",
  external: ["vscode"],
  logLevel: "silent",
  plugins: [copyAssetsPlugin, esbuildProblemMatcherPlugin],
};

/**
 * The webview runs in a browser context with no Node builtins and no module
 * loader, so it is bundled separately as a self-contained IIFE.
 * @type {import('esbuild').BuildOptions}
 */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  target: "es2022",
  outfile: "dist/webview.js",
  logLevel: "silent",
  plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
