import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
