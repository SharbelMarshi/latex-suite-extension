/*
 * Bundles tests/*.test.ts (and the src modules they import) into .test-build/
 * so `node --test` can run them. The project has no test framework of its own;
 * this reuses the esbuild dependency that is already here and the test runner
 * built into Node 18+.
 *
 * Only modules free of Obsidian/DOM imports are testable this way, which is why
 * the parsing, anchoring and storage logic lives in *-core.ts / document-store.ts
 * separately from the rendering layers.
 */
import esbuild from "esbuild";
import fs from "fs";
import path from "path";

const TEST_DIR = "tests";
// not dot-prefixed: Node's test runner skips hidden directories
const OUT_DIR = "test-build";

const entryPoints = fs
	.readdirSync(TEST_DIR)
	.filter((file) => file.endsWith(".test.ts"))
	.map((file) => path.join(TEST_DIR, file));

if (entryPoints.length === 0) {
	console.error("No test files found in " + TEST_DIR);
	process.exit(1);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });

await esbuild.build({
	entryPoints,
	outdir: OUT_DIR,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "es2022",
	sourcemap: "inline",
	// src uses window.setTimeout (popout-window safe in Obsidian); Node has no
	// window, so alias it to the global object for the tests
	banner: { js: "globalThis.window ??= globalThis;" },
	logLevel: "info",
	external: ["node:*"],
});
