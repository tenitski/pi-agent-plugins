import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverPiHooks } from "../src/pi-hooks.ts";
import { PLUGIN_SCHEMA_ID, type LoadedPlugin } from "../src/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-hooks-test-"));
}

/** Minimal LoadedPlugin whose piExtension.hooks is under test. */
function pluginWith(root: string, hooks: unknown): LoadedPlugin {
	return {
		manifest: { $schema: PLUGIN_SCHEMA_ID, name: "demo" },
		root,
		dataDir: join(root, ".data"),
		scope: "user",
		enabled: true,
		skills: [],
		mcpServers: [],
		piExtension: { hooks },
		diagnostics: [],
	};
}

function writeHook(root: string, rel: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, "export default () => {};\n");
}

test("accepts one valid hook and returns its absolute path", () => {
	const root = tempDir();
	writeHook(root, "dev.pi.agent/hooks.ts");
	const { hooks, diagnostics } = discoverPiHooks(
		pluginWith(root, ["./dev.pi.agent/hooks.ts"]),
	);
	assert.equal(hooks.length, 1);
	assert.ok(hooks[0]);
	assert.equal(hooks[0].relative, "./dev.pi.agent/hooks.ts");
	assert.ok(hooks[0].path.endsWith("dev.pi.agent/hooks.ts"));
	assert.equal(diagnostics.length, 0);
});

test("accepts multiple hooks and dedupes by resolved path", () => {
	const root = tempDir();
	writeHook(root, "a.ts");
	writeHook(root, "b.js");
	const { hooks, diagnostics } = discoverPiHooks(
		pluginWith(root, ["./a.ts", "./b.js", "./a.ts"]),
	);
	assert.equal(hooks.length, 2);
	assert.deepEqual(
		hooks.map((h) => h.relative),
		["./a.ts", "./b.js"],
	);
	assert.ok(diagnostics.some((d) => /duplicate/.test(d.message)));
});

test("missing hooks key yields no hooks and no diagnostics", () => {
	const root = tempDir();
	const { hooks, diagnostics } = discoverPiHooks(pluginWith(root, undefined));
	assert.equal(hooks.length, 0);
	assert.equal(diagnostics.length, 0);
});

test("non-array hooks value is a diagnostic, not a throw", () => {
	const root = tempDir();
	const { hooks, diagnostics } = discoverPiHooks(pluginWith(root, "nope"));
	assert.equal(hooks.length, 0);
	assert.equal(diagnostics.length, 1);
	assert.ok(diagnostics[0]);
	assert.match(diagnostics[0].message, /must be an array/);
});

test("rejects non-string, missing ./, unsupported ext, missing file, directory", () => {
	const root = tempDir();
	writeHook(root, "ok.ts");
	mkdirSync(join(root, "adir"), { recursive: true });
	const { hooks, diagnostics } = discoverPiHooks(
		pluginWith(root, [
			42,
			"noleadingdot.ts",
			"./bad.txt",
			"./does-not-exist.ts",
			"./adir",
			"./ok.ts",
		]),
	);
	assert.equal(hooks.length, 1);
	assert.deepEqual(
		hooks.map((h) => h.relative),
		["./ok.ts"],
	);
	assert.equal(diagnostics.length, 5);
});

test("rejects a symlink that escapes the plugin root", () => {
	const outside = tempDir();
	writeFileSync(join(outside, "evil.ts"), "export default () => {};\n");
	const root = tempDir();
	symlinkSync(join(outside, "evil.ts"), join(root, "escape.ts"));
	const { hooks, diagnostics } = discoverPiHooks(
		pluginWith(root, ["./escape.ts"]),
	);
	assert.equal(hooks.length, 0);
	assert.equal(diagnostics.length, 1);
	assert.ok(diagnostics[0]);
	assert.match(diagnostics[0].message, /escapes the plugin root/);
});

test("dedupes symlink-aliased hooks by canonical realpath", () => {
	const root = tempDir();
	// Create a real hook file
	writeHook(root, "real.ts");
	// Create two symlinks inside the root both pointing at real.ts
	symlinkSync(join(root, "real.ts"), join(root, "alias1.ts"));
	symlinkSync(join(root, "real.ts"), join(root, "alias2.ts"));
	const { hooks, diagnostics } = discoverPiHooks(
		pluginWith(root, ["./alias1.ts", "./alias2.ts"]),
	);
	// Exactly one hook should be returned
	assert.equal(hooks.length, 1);
	// A diagnostic mentioning duplicate should be present
	assert.ok(diagnostics.some((d) => /duplicate/.test(d.message)));
});
