import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { install } from "../src/install.ts";
import { readInstallGeneration } from "../src/paths-client.ts";
import { activatePiHook, activatePiHooks, buildHookContext, discoverPiHooks } from "../src/pi-hooks.ts";
import { PLUGIN_SCHEMA_ID, type LoadedPlugin } from "../src/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-hooks-test-"));
}

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "hooks");

function fakePi(): { on: (...a: unknown[]) => void; calls: unknown[] } {
	const calls: unknown[] = [];
	return { on: (...a) => calls.push(a), calls };
}

function hookFor(root: string, file: string): import("../src/pi-hooks.ts").LoadedPiHook {
	return { plugin: pluginWith(root, [`./${file}`]), path: join(FIXTURES, file), relative: `./${file}` };
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

test("install stamps a fresh code identity and overwrites an author-shipped marker", async () => {
	const src = tempDir();
	writeFileSync(
		join(src, "plugin.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name: "demo" }),
	);
	writeFileSync(
		join(src, ".pi-install-id"),
		JSON.stringify({ version: 1, id: "author-controlled" }),
	);
	const target = tempDir();

	const first = await install({ kind: "path", path: src }, { targetDir: target });
	const id1 = readInstallGeneration(first.root);
	assert.ok(id1?.startsWith("install:v1:"));
	assert.notEqual(id1, "install:v1:author-controlled");

	const second = await install(
		{ kind: "path", path: src },
		{ targetDir: target, force: true },
	);
	const id2 = readInstallGeneration(second.root);
	assert.ok(id2?.startsWith("install:v1:"));
	assert.notEqual(id2, id1); // reinstall → new generation
});

test("buildHookContext freezes context and manifest", () => {
	const ctx = buildHookContext(hookFor(FIXTURES, "sync-ok.ts"));
	assert.throws(() => ((ctx as { pluginName: string }).pluginName = "x"));
	assert.ok(Object.isFrozen(ctx.manifest));
	assert.ok(ctx.pluginRoot.length > 0);
});

test("activatePiHook runs a sync default export with pi + context", async () => {
	(globalThis as { __hookCalls?: unknown[] }).__hookCalls = [];
	const pi = fakePi();
	await activatePiHook(pi as never, hookFor(FIXTURES, "sync-ok.ts"));
	assert.equal(pi.calls.length, 1); // pi.on("tool_call", …) registered
});

test("activatePiHook awaits an async default export", async () => {
	(globalThis as { __hookCalls?: unknown[] }).__hookCalls = [];
	await activatePiHook(fakePi() as never, hookFor(FIXTURES, "async-ok.ts"));
	assert.equal((globalThis as unknown as { __hookCalls: unknown[] }).__hookCalls.length, 1);
});

test("activatePiHooks converts each failure to a diagnostic without aborting siblings", async () => {
	const root = FIXTURES;
	const hooks = ["no-default.ts", "default-not-function.ts", "import-throws.ts", "rejects.ts", "sync-ok.ts"].map(
		(f) => hookFor(root, f),
	);
	const diagnostics = await activatePiHooks(fakePi() as never, hooks);
	assert.equal(diagnostics.length, 4); // four bad, one good
	assert.ok(diagnostics.every((d) => d.severity === "error" && d.section === "8.1"));
});
