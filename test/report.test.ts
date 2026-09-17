import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatInfo, type TrustView } from "../src/report.ts";
import { PLUGIN_SCHEMA_ID, type LoadedPlugin, type TrustCapability } from "../src/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "report-test-"));
}

/** A minimal plugin declaring one dev.pi.agent hook and no MCP servers. */
function pluginWithHook(root: string): LoadedPlugin {
	mkdirSync(join(root, "dev.pi.agent"), { recursive: true });
	writeFileSync(join(root, "dev.pi.agent", "hooks.ts"), "export default () => {};\n");
	return {
		manifest: { $schema: PLUGIN_SCHEMA_ID, name: "demo" },
		root,
		dataDir: join(root, ".data"),
		scope: "user",
		enabled: true,
		skills: [],
		mcpServers: [],
		piExtension: { hooks: ["./dev.pi.agent/hooks.ts"] },
		diagnostics: [],
	};
}

function trustView(effective: TrustCapability[], missing: TrustCapability[]): TrustView {
	return {
		effective: () => new Set(effective),
		missing: () => missing,
	};
}

test("formatInfo lists declared hooks and their pending capability status", () => {
	const plugin = pluginWithHook(tempDir());
	const output = formatInfo(plugin, trustView([], ["pi-entrypoints"]));

	assert.match(output, /hooks:\n\s+\.\/dev\.pi\.agent\/hooks\.ts/);
	assert.match(output, /pi-entrypoints: pending/);
});

test("formatInfo reports a granted pi-entrypoints capability as trusted", () => {
	const plugin = pluginWithHook(tempDir());
	const output = formatInfo(plugin, trustView(["pi-entrypoints"], []));

	assert.match(output, /pi-entrypoints: trusted/);
});
