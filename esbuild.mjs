import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

/** Extension bundle — runs in VS Code's Node.js host */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
};

/** Webview bundle — runs in browser context inside VS Code webview */
const webviewConfig = {
  entryPoints: ["webview/renderer.ts"],
  bundle: true,
  outfile: "dist/webview/renderer.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: false,
};

async function build() {
  if (isWatch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log("[esbuild] build complete");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
