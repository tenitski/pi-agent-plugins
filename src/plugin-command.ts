/** `/plugin` command registration and subcommand handlers. */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { install, parseSource, uninstall } from "./install.ts";
import { projectPluginsDir, userPluginsDir } from "./paths-client.ts";
import { discoverPiHooks } from "./pi-hooks.ts";
import { formatDiagnostic, formatInfo, formatList, type TrustView } from "./report.ts";
import type { PluginRuntime } from "./runtime.ts";
import {
	PI_NAMESPACE,
	SUPPORTED_SPEC_VERSION,
	type LoadedPlugin,
} from "./types.ts";

/** Adapts the runtime's capability queries to the shape `report.ts` consumes. */
function trustView(runtime: PluginRuntime): TrustView {
	return {
		effective: (plugin) => runtime.effectiveCapabilities(plugin),
		missing: (plugin) => runtime.missingCapabilities(plugin),
	};
}

const SUBCOMMANDS = [
	"list",
	"info",
	"install",
	"uninstall",
	"enable",
	"disable",
	"trust",
	"reload",
	"doctor",
] as const;

type CommandHandler = (
	argument: string,
	ctx: ExtensionCommandContext,
) => Promise<void>;

interface CommandEnvironment {
	pi: ExtensionAPI;
	runtime: PluginRuntime;
}

export function registerPluginCommand(
	pi: ExtensionAPI,
	runtime: PluginRuntime,
): void {
	const environment = { pi, runtime };
	const handlers = createHandlers(environment);

	pi.registerCommand("plugin", {
		description: `Manage Agent Plugins ${SUPPORTED_SPEC_VERSION} packages (skills + MCP servers + Pi hooks)`,
		getArgumentCompletions: (prefix) => completions(prefix, runtime),
		handler: async (args, ctx) => {
			const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const handler = handlers[sub];
			if (!handler) {
				fail(
					ctx,
					`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`,
				);
				return;
			}
			runtime.scan(ctx.cwd, ctx.isProjectTrusted());
			await handler(rest.join(" "), ctx);
		},
	});
}

function createHandlers(
	environment: CommandEnvironment,
): Record<string, CommandHandler> {
	const { pi, runtime } = environment;
	return {
		list: async (_argument, ctx) =>
			show(pi, ctx, formatList(runtime.registry.plugins, trustView(runtime))),
		info: async (argument, ctx) => showPluginInfo(pi, runtime, argument, ctx),
		install: async (argument, ctx) => handleInstall(pi, runtime, argument, ctx),
		uninstall: async (argument, ctx) => handleUninstall(runtime, argument, ctx),
		enable: async (argument, ctx) => handleEnable(runtime, argument, true, ctx),
		disable: async (argument, ctx) =>
			handleEnable(runtime, argument, false, ctx),
		trust: async (argument, ctx) => handleTrust(runtime, argument, ctx),
		reload: async (_argument, ctx) => handleReload(runtime, ctx),
		doctor: async (_argument, ctx) => show(pi, ctx, formatDoctor(runtime)),
	};
}

function completions(
	prefix: string,
	runtime: PluginRuntime,
): Array<{ value: string; label: string }> | null {
	const [sub, ...rest] = prefix.split(/\s+/);
	const takesName =
		sub && ["info", "uninstall", "enable", "disable", "trust"].includes(sub);
	if (takesName && rest.length > 0) {
		const partial = rest.join(" ");
		const items = runtime.registry.plugins.flatMap((plugin) => {
			const name = plugin.manifest.name;
			return name.startsWith(partial)
				? [{ value: `${sub} ${name}`, label: name }]
				: [];
		});
		return items.length > 0 ? items : null;
	}

	const items = SUBCOMMANDS.flatMap((name) =>
		name.startsWith(prefix) ? [{ value: name, label: name }] : [],
	);
	return items.length > 0 ? items : null;
}

function requirePlugin(
	runtime: PluginRuntime,
	name: string,
	ctx: ExtensionContext,
): LoadedPlugin | undefined {
	const plugin = runtime.find(name);
	if (!plugin) fail(ctx, `Unknown plugin: ${name || "(none given)"}`);
	return plugin;
}

function showPluginInfo(
	pi: ExtensionAPI,
	runtime: PluginRuntime,
	name: string,
	ctx: ExtensionContext,
): void {
	const plugin = requirePlugin(runtime, name, ctx);
	if (plugin) show(pi, ctx, formatInfo(plugin, trustView(runtime)));
}

async function handleInstall(
	pi: ExtensionAPI,
	runtime: PluginRuntime,
	spec: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!spec) {
		fail(
			ctx,
			"Usage: /plugin install <npm:package | git-url | github.com/user/repo | ./path>",
		);
		return;
	}
	const source = parseSource(spec);
	if ("error" in source) {
		fail(ctx, source.error);
		return;
	}

	try {
		const options = ctx.signal ? { signal: ctx.signal } : {};
		const result = await install(source, options);
		runtime.scan();
		const plugin = runtime.find(result.manifest.name);
		const serverCount = plugin?.mcpServers.length ?? 0;
		ctx.ui.notify(
			`Installed ${result.manifest.name}${serverCount > 0 ? ` (${serverCount} MCP server(s) need /plugin trust)` : ""}. Run /plugin reload to load it.`,
			"info",
		);
		if (plugin) show(pi, ctx, formatInfo(plugin, trustView(runtime)));
	} catch (cause) {
		fail(ctx, cause instanceof Error ? cause.message : String(cause));
	}
}

async function handleUninstall(
	runtime: PluginRuntime,
	name: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const plugin = requirePlugin(runtime, name, ctx);
	if (!plugin) return;
	if (plugin.scope === "project") {
		fail(
			ctx,
			"Project-local plugins are managed in the repository, not by /plugin.",
		);
		return;
	}

	const removed = uninstall(plugin.manifest.name);
	runtime.scan();
	runtime.sync();
	ctx.ui.notify(
		removed
			? `Removed ${plugin.manifest.name}. Its PLUGIN_DATA was preserved.`
			: `Nothing to remove for ${plugin.manifest.name}.`,
		removed ? "info" : "warning",
	);
}

async function handleEnable(
	runtime: PluginRuntime,
	name: string,
	enabled: boolean,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const plugin = requirePlugin(runtime, name, ctx);
	if (!plugin) return;
	runtime.setEnabled(plugin.manifest.name, enabled);
	ctx.ui.notify(
		`${plugin.manifest.name} ${enabled ? "enabled" : "disabled"}. Run /plugin reload to apply changes.`,
		"info",
	);
}

async function handleTrust(
	runtime: PluginRuntime,
	name: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const plugin = requirePlugin(runtime, name, ctx);
	if (!plugin) return;
	const granted = runtime.missingCapabilities(plugin);
	runtime.trust(plugin.manifest.name);
	ctx.ui.notify(
		granted.length > 0
			? `Trusted ${plugin.manifest.name} for: ${granted.join(", ")}. Reloading…`
			: `${plugin.manifest.name} has no pending capabilities to trust. Reloading…`,
		"info",
	);
	await ctx.reload();
}

async function handleReload(
	runtime: PluginRuntime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { diagnostics } = runtime.sync();
	const errors = diagnostics.filter(
		(diagnostic) => diagnostic.severity === "error",
	);
	if (errors.length > 0) {
		ctx.ui.notify(
			`Agent Plugins: cannot reload; ${errors.length} MCP sync error(s).`,
			"error",
		);
		return;
	}
	await ctx.reload();
}

function formatDoctor(runtime: PluginRuntime): string {
	const trustedCount = runtime.registry.plugins.filter(
		(plugin) => runtime.effectiveCapabilities(plugin).size > 0,
	).length;
	let hooksDeclared = 0;
	let hooksTrusted = 0;
	for (const plugin of runtime.registry.plugins) {
		const declared = discoverPiHooks(plugin).hooks.length;
		hooksDeclared += declared;
		if (declared > 0 && runtime.effectiveCapabilities(plugin).has("pi-entrypoints"))
			hooksTrusted += declared;
	}
	const lines = [
		`Agent Plugins ${SUPPORTED_SPEC_VERSION} client`,
		"",
		`namespace:     ${PI_NAMESPACE}`,
		`user root:     ${userPluginsDir()}`,
		`project root:  ${projectPluginsDir(runtime.activeCwd)}`,
		`plugins:       ${runtime.registry.plugins.length}`,
		`trusted:       ${trustedCount}`,
		`hooks:         ${hooksDeclared} declared, ${hooksTrusted} trusted`,
		"",
		"components:    skills (native), MCP servers (via pi-mcp-adapter), Pi hooks (in-process)",
		"transports:    stdio, streamable-http without configured headers",
		"",
	];
	// hookDiagnostics is already folded into allDiagnostics(); no need to append it again.
	const diagnostics = runtime.allDiagnostics();
	if (diagnostics.length === 0) return [...lines, "No diagnostics."].join("\n");
	return [...lines, "diagnostics:", ...diagnostics.map(formatDiagnostic)].join(
		"\n",
	);
}

function show(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
	if (ctx.hasUI) pi.appendEntry("agent-plugins-report", { text });
	else process.stdout.write(`${text}\n`);
}

function fail(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "error");
	else process.stderr.write(`${message}\n`);
}
