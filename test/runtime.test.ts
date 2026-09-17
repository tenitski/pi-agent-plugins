import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { install } from "../src/install.ts";
import { statePath } from "../src/paths-client.ts";
import { PluginRuntime, pluginTrustKey } from "../src/runtime.ts";
import { grantTrust, readState } from "../src/state.ts";
import { MCP_SCHEMA_ID, PLUGIN_SCHEMA_ID } from "../src/types.ts";
import type { TrustedPluginRecord } from "../src/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "agent-plugins-runtime-test-"));
}

function createPlugin(root: string, name: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name }),
	);
}

/** A plugin with one valid stdio MCP server, so trust has something to grant. */
function createPluginWithMcp(root: string, name: string): void {
	createPlugin(root, name);
	writeFileSync(
		join(root, "mcp.json"),
		JSON.stringify({
			$schema: MCP_SCHEMA_ID,
			mcpServers: { demo: { type: "stdio", command: "true" } },
		}),
	);
}

/**
 * A plugin declaring a dev.pi.agent hook whose default export registers a
 * "tool_call" handler that records to `globalThis.__hookCalls` when invoked.
 */
function createHookedPlugin(root: string, name: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({
			$schema: PLUGIN_SCHEMA_ID,
			name,
			extensions: { "dev.pi.agent": { hooks: ["./dev.pi.agent/hooks.ts"] } },
		}),
	);
	mkdirSync(join(root, "dev.pi.agent"), { recursive: true });
	writeFileSync(
		join(root, "dev.pi.agent", "hooks.ts"),
		[
			"export default (pi, ctx) => {",
			'\tpi.on("tool_call", () => {',
			"\t\tglobalThis.__hookCalls?.push({ name: ctx.pluginName });",
			"\t});",
			"};",
			"",
		].join("\n"),
	);
}

/** Fake ExtensionAPI recording every `.on(event, handler)` call. */
function fakePi(): { on: (...a: unknown[]) => void; calls: unknown[][] } {
	const calls: unknown[][] = [];
	return { on: (...a: unknown[]) => calls.push(a), calls };
}

function toolCallHandler(calls: unknown[][]): (...args: unknown[]) => unknown {
	const call = calls.find((c) => c[0] === "tool_call");
	assert.ok(call, "expected a tool_call handler to be registered");
	return call[1] as (...args: unknown[]) => unknown;
}

test("legacy string trust migrates to mcp capability only", () => {
	const dir = tempDir();
	const statePath = join(dir, "state.json");
	writeFileSync(
		statePath,
		JSON.stringify({ disabled: [], trusted: ["user:foo", "bar"] }),
	);
	const state = readState(statePath);
	const byKey = new Map(state.trusted.map((r) => [r.key, r] as const));
	assert.deepEqual(byKey.get("user:foo")?.capabilities, ["mcp"]);
	assert.deepEqual(byKey.get("bar")?.capabilities, ["mcp"]);
	assert.equal(byKey.get("user:foo")?.codeIdentity, undefined);
});

test("grantTrust merges capabilities and records codeIdentity by key", () => {
	const dir = tempDir();
	const statePath = join(dir, "state.json");
	writeFileSync(
		statePath,
		JSON.stringify({ disabled: [], trusted: ["user:foo"] }),
	);
	grantTrust(
		[
			{
				key: "user:foo",
				capabilities: ["pi-entrypoints"],
				codeIdentity: "install:v1:abc",
			},
		],
		statePath,
	);
	const rec = readState(statePath).trusted.find(
		(r: TrustedPluginRecord) => r.key === "user:foo",
	);
	assert.deepEqual(rec?.capabilities.sort(), ["mcp", "pi-entrypoints"]);
	assert.equal(rec?.codeIdentity, "install:v1:abc");
});

test("legacy user trust cannot be inherited by a project plugin with the same name", () => {
	const agentDir = tempDir();
	const project = tempDir();
	createPlugin(join(agentDir, "plugins", "shared-name"), "shared-name");
	createPluginWithMcp(
		join(project, ".pi", "plugins", "shared-name"),
		"shared-name",
	);
	mkdirSync(join(agentDir, "agent-plugins"), { recursive: true });
	writeFileSync(
		join(agentDir, "agent-plugins", "state.json"),
		JSON.stringify({ disabled: [], trusted: ["shared-name"] }),
	);

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		const runtime = new PluginRuntime();
		runtime.startSession(project, true);
		const active = runtime.find("shared-name");
		assert.ok(active);
		assert.equal(active.scope, "project");
		// Legacy bare-name trust must not carry over to the project instance.
		assert.equal(runtime.effectiveCapabilities(active).size, 0);
		assert.match(active.dataDir, /plugin-data[/\\]project/);

		runtime.trust("shared-name");
		// The project plugin declares an MCP server, so trust() grants "mcp" on
		// its own project-scoped key — but only because it was explicitly
		// trusted just now, not because of the legacy record.
		assert.ok(runtime.effectiveCapabilities(active).has("mcp"));

		const raw: unknown = JSON.parse(
			readFileSync(join(agentDir, "agent-plugins", "state.json"), "utf-8"),
		);
		assert.ok(typeof raw === "object" && raw !== null && !Array.isArray(raw));
		const trusted = (raw as { trusted?: unknown }).trusted;
		assert.ok(Array.isArray(trusted));
		const records = trusted as Array<{ key?: unknown } | string>;
		const keys = records.map((r) => (typeof r === "string" ? r : r.key));
		// The project key was granted...
		assert.ok(keys.includes(pluginTrustKey(active)));
		// ...but the original legacy bare-name record is untouched and distinct.
		assert.ok(keys.includes("shared-name"));
		assert.notEqual(pluginTrustKey(active), "shared-name");
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});

test("replacing installed code drops pi-entrypoints trust but keeps mcp", () => {
	const agentDir = tempDir();
	const pluginRoot = join(agentDir, "plugins", "demo");
	createPluginWithMcp(pluginRoot, "demo");
	mkdirSync(join(pluginRoot, "dev.pi.agent"), { recursive: true });
	writeFileSync(
		join(pluginRoot, "dev.pi.agent", "hooks.ts"),
		"export default () => {};\n",
	);
	writeFileSync(
		join(pluginRoot, "plugin.json"),
		JSON.stringify({
			$schema: PLUGIN_SCHEMA_ID,
			name: "demo",
			extensions: { "dev.pi.agent": { hooks: ["./dev.pi.agent/hooks.ts"] } },
		}),
	);
	writeFileSync(
		join(pluginRoot, ".pi-install-id"),
		`${JSON.stringify({ version: 1, id: "generation-1" })}\n`,
	);

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		const runtime = new PluginRuntime();
		runtime.initializeUser();
		const plugin = runtime.find("demo");
		assert.ok(plugin);
		assert.equal(plugin.codeIdentity, "install:v1:generation-1");

		runtime.trust("demo");
		runtime.scan();
		let rescanned = runtime.find("demo");
		assert.ok(rescanned);
		let effective = runtime.effectiveCapabilities(rescanned);
		assert.ok(effective.has("mcp"));
		assert.ok(effective.has("pi-entrypoints"));

		// Replace the installed code with a new generation.
		writeFileSync(
			join(pluginRoot, ".pi-install-id"),
			`${JSON.stringify({ version: 1, id: "generation-2" })}\n`,
		);
		runtime.scan();
		rescanned = runtime.find("demo");
		assert.ok(rescanned);
		effective = runtime.effectiveCapabilities(rescanned);
		assert.ok(effective.has("mcp"));
		assert.equal(effective.has("pi-entrypoints"), false);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});

test("mcp-trusted plugin with a hook still shows pending for pi-entrypoints", () => {
	const agentDir = tempDir();
	const pluginRoot = join(agentDir, "plugins", "demo-hook");
	createPluginWithMcp(pluginRoot, "demo-hook");
	mkdirSync(join(pluginRoot, "dev.pi.agent"), { recursive: true });
	writeFileSync(
		join(pluginRoot, "dev.pi.agent", "hooks.ts"),
		"export default () => {};\n",
	);
	writeFileSync(
		join(pluginRoot, "plugin.json"),
		JSON.stringify({
			$schema: PLUGIN_SCHEMA_ID,
			name: "demo-hook",
			extensions: { "dev.pi.agent": { hooks: ["./dev.pi.agent/hooks.ts"] } },
		}),
	);

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		const runtime = new PluginRuntime();
		runtime.scan();
		const plugin = runtime.find("demo-hook");
		assert.ok(plugin);

		// Grant only "mcp", not via trust() (which would grant every missing cap).
		grantTrust(
			[{ key: pluginTrustKey(plugin), capabilities: ["mcp"] }],
			statePath(),
		);
		runtime.scan();
		const rescanned = runtime.find("demo-hook");
		assert.ok(rescanned);

		const effective = runtime.effectiveCapabilities(rescanned);
		assert.ok(effective.has("mcp"));
		assert.equal(effective.has("pi-entrypoints"), false);

		const missing = runtime.missingCapabilities(rescanned);
		assert.ok(missing.includes("pi-entrypoints"));
		assert.equal(missing.includes("mcp"), false);

		assert.ok(
			runtime.pendingTrust().some((p) => p.manifest.name === "demo-hook"),
		);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});

test("project plugin gets pi-entrypoints from project trust with no code identity", () => {
	const agentDir = tempDir();
	const projectDir = tempDir();
	const pluginRoot = join(projectDir, ".pi", "plugins", "proj-hook");
	createPlugin(pluginRoot, "proj-hook");
	mkdirSync(join(pluginRoot, "dev.pi.agent"), { recursive: true });
	writeFileSync(
		join(pluginRoot, "dev.pi.agent", "hooks.ts"),
		"export default () => {};\n",
	);
	writeFileSync(
		join(pluginRoot, "plugin.json"),
		JSON.stringify({
			$schema: PLUGIN_SCHEMA_ID,
			name: "proj-hook",
			extensions: { "dev.pi.agent": { hooks: ["./dev.pi.agent/hooks.ts"] } },
		}),
	);

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		const runtime = new PluginRuntime();
		runtime.startSession(projectDir, true);
		let plugin = runtime.find("proj-hook");
		assert.ok(plugin);
		assert.equal(plugin.codeIdentity, undefined);

		grantTrust(
			[{ key: pluginTrustKey(plugin), capabilities: ["pi-entrypoints"] }],
			statePath(),
		);
		runtime.scan(projectDir, true);
		plugin = runtime.find("proj-hook");
		assert.ok(plugin);
		assert.equal(plugin.codeIdentity, undefined);

		assert.ok(runtime.effectiveCapabilities(plugin).has("pi-entrypoints"));
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});

test("trusted user hook activates during factory-style activation", async () => {
	const agentDir = tempDir();
	const src = tempDir();
	createHookedPlugin(src, "hooked-a");

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		(globalThis as { __hookCalls?: unknown[] }).__hookCalls = [];
		await install({ kind: "path", path: src }, {});

		const runtime = new PluginRuntime();
		runtime.initializeUser();
		runtime.trust("hooked-a");
		runtime.scan();

		const pi = fakePi();
		await runtime.activateHooks(pi as never, "user");
		assert.equal(pi.calls.filter((c) => c[0] === "tool_call").length, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});

test("activateHooks is idempotent: a second call does not re-register", async () => {
	const agentDir = tempDir();
	const src = tempDir();
	createHookedPlugin(src, "hooked-b");

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		(globalThis as { __hookCalls?: unknown[] }).__hookCalls = [];
		await install({ kind: "path", path: src }, {});

		const runtime = new PluginRuntime();
		runtime.initializeUser();
		runtime.trust("hooked-b");
		runtime.scan();

		const pi = fakePi();
		await runtime.activateHooks(pi as never, "user");
		await runtime.activateHooks(pi as never, "user");
		assert.equal(pi.calls.filter((c) => c[0] === "tool_call").length, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});

test("untrusted and disabled user hooks are not activated", async () => {
	const agentDir = tempDir();
	const untrustedSrc = tempDir();
	const disabledSrc = tempDir();
	createHookedPlugin(untrustedSrc, "untrusted-hook");
	createHookedPlugin(disabledSrc, "disabled-hook");

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		(globalThis as { __hookCalls?: unknown[] }).__hookCalls = [];
		await install({ kind: "path", path: untrustedSrc }, {});
		await install({ kind: "path", path: disabledSrc }, {});

		const runtime = new PluginRuntime();
		runtime.initializeUser();
		// Trusted for pi-entrypoints, but disabled — must not activate either.
		runtime.trust("disabled-hook");
		runtime.setEnabled("disabled-hook", false);

		const pi = fakePi();
		await runtime.activateHooks(pi as never, "user");
		assert.equal(pi.calls.filter((c) => c[0] === "tool_call").length, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});

test("trusted project hook activates only after project trust, and its handler fires", async () => {
	const agentDir = tempDir();
	const projectDir = tempDir();
	const pluginRoot = join(projectDir, ".pi", "plugins", "proj-hooked");
	createHookedPlugin(pluginRoot, "proj-hooked");

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		(globalThis as { __hookCalls?: unknown[] }).__hookCalls = [];
		const runtime = new PluginRuntime();

		// Untrusted project: the plugin is not even scanned, so nothing activates.
		runtime.startSession(projectDir, false);
		const untrustedPi = fakePi();
		await runtime.activateHooks(untrustedPi as never, "project");
		assert.equal(untrustedPi.calls.length, 0);

		// Trust the project and grant pi-entrypoints explicitly.
		runtime.startSession(projectDir, true);
		const plugin = runtime.find("proj-hooked");
		assert.ok(plugin);
		grantTrust(
			[{ key: pluginTrustKey(plugin), capabilities: ["pi-entrypoints"] }],
			statePath(),
		);
		runtime.scan(projectDir, true);

		const trustedPi = fakePi();
		await runtime.activateHooks(trustedPi as never, "project");
		const handler = toolCallHandler(trustedPi.calls);

		const before = (globalThis as { __hookCalls?: unknown[] }).__hookCalls
			?.length ?? 0;
		handler({});
		const after = (globalThis as { __hookCalls?: unknown[] }).__hookCalls
			?.length ?? 0;
		assert.equal(after, before + 1);
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});
