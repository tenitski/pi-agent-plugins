/** Agent Plugins 1.0.0 client extension for Pi. */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { discoverPiHooks } from "../src/pi-hooks.ts";
import { registerPluginCommand } from "../src/plugin-command.ts";
import { PluginRuntime } from "../src/runtime.ts";
import type { LoadedPlugin } from "../src/types.ts";

export default async function agentPlugins(pi: ExtensionAPI): Promise<void> {
	const runtime = new PluginRuntime();

	// Factory-time user sync lands before pi-mcp-adapter's session initialization.
	// A malformed plugin must never prevent Pi itself from starting.
	try {
		runtime.initializeUser();
		await runtime.activateHooks(pi, "user");
	} catch {
		// session_start rescans and reports diagnostics with UI context.
	}

	pi.on("resources_discover", (event) => runtime.discoverResources(event.cwd));

	pi.on("session_start", async (_event, ctx) => {
		runtime.startSession(ctx.cwd, ctx.isProjectTrusted());
		await runtime.activateHooks(pi, "project");
		const errors = runtime
			.allDiagnostics()
			.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`Agent Plugins: ${errors.length} problem(s). Run /plugin list for detail.`,
				"warning",
			);
		}
		await promptForTrust(runtime, ctx);
	});

	registerPluginCommand(pi, runtime);

	pi.registerEntryRenderer("agent-plugins-report", (entry, _options, theme) => {
		const data = entry.data as { text: string };
		return new Text(theme.fg("dim", data.text));
	});
}

/** Per-capability breakdown lines for one plugin's pending trust prompt. */
function capabilityLines(runtime: PluginRuntime, plugin: LoadedPlugin): string[] {
	const missing = runtime.missingCapabilities(plugin);
	const lines: string[] = [];
	if (missing.includes("pi-entrypoints")) {
		for (const hook of discoverPiHooks(plugin).hooks)
			lines.push(`Pi hook: ${hook.relative}`);
	}
	if (missing.includes("mcp")) {
		for (const server of plugin.mcpServers)
			lines.push(`MCP server: ${server.name}`);
	}
	return lines;
}

async function promptForTrust(
	runtime: PluginRuntime,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) return;
	const pending = runtime.pendingTrust();
	if (pending.length === 0) return;

	let trusted = false;
	for (const plugin of pending) {
		const lines = capabilityLines(runtime, plugin);
		const accepted = await ctx.ui.confirm(
			`Trust plugin "${plugin.manifest.name}"?`,
			[
				"Trusting lets the following run with your permissions:",
				...lines,
			].join("\n"),
		);
		if (!accepted) continue;
		runtime.trust(plugin.manifest.name);
		trusted = true;
	}
	if (trusted) {
		ctx.ui.notify(
			"Agent Plugins: trust granted. Run /plugin reload to apply changes.",
			"info",
		);
	}
}
