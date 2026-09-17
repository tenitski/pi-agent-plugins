/** Runtime registry and host integration, separated from the Pi entry point. */

import { mkdirSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadAll } from "./loader.ts";
import {
	prepareDataDirs,
	projectAll,
	syncAdapterConfig,
} from "./mcp-bridge.ts";
import { resolvePluginRelative } from "./paths.ts";
import {
	projectManagedLedgerPath,
	projectPiMcpConfigPath,
	projectPluginsDir,
	userPluginsDir,
} from "./paths-client.ts";
import {
	activatePiHooks,
	discoverPiHooks,
	type LoadedPiHook,
} from "./pi-hooks.ts";
import { grantTrust, readState, setDisabled } from "./state.ts";
import {
	error,
	type Diagnostic,
	type LoadedPlugin,
	type PluginScope,
	type TrustCapability,
	type TrustedPluginRecord,
} from "./types.ts";

export interface Registry {
	plugins: LoadedPlugin[];
	diagnostics: Diagnostic[];
	/** Persisted trust records keyed by pluginTrustKey(). */
	records: Map<string, TrustedPluginRecord>;
}

export interface ResourcePaths {
	skillPaths: string[];
	promptPaths: string[];
	themePaths: string[];
}

export interface RuntimeSyncResult {
	changed: boolean;
	diagnostics: Diagnostic[];
}

/** Stable trust identity for one installed plugin instance. */
export function pluginTrustKey(plugin: LoadedPlugin): string {
	return plugin.scope === "user"
		? `user:${plugin.manifest.name}`
		: `project:${plugin.root}:${plugin.manifest.name}`;
}

export class PluginRuntime {
	registry: Registry = { plugins: [], diagnostics: [], records: new Map() };
	activeCwd = process.cwd();
	activeProjectTrusted = false;
	/** Diagnostics from the most recent activateHooks() call per scope, keyed by scope. */
	private hookDiagnosticsByScope = new Map<PluginScope, Diagnostic[]>();
	/** Hooks already activated this runtime instance, keyed `${pluginTrustKey}::${path}`. */
	private activatedHooks = new Set<string>();

	/** Diagnostics accumulated by activateHooks(), surfaced via allDiagnostics(). */
	get hookDiagnostics(): Diagnostic[] {
		return [
			...(this.hookDiagnosticsByScope.get("user") ?? []),
			...(this.hookDiagnosticsByScope.get("project") ?? []),
		];
	}

	initializeUser(): void {
		this.scan(process.cwd(), false);
		this.sync(false);
	}

	startSession(cwd: string, projectTrusted: boolean): RuntimeSyncResult {
		this.activeCwd = cwd;
		this.activeProjectTrusted = projectTrusted;
		this.scan(cwd, projectTrusted);
		return this.sync(projectTrusted);
	}

	scan(
		cwd = this.activeCwd,
		projectTrusted = this.activeProjectTrusted,
	): Registry {
		const state = readState();
		const roots: Array<{ dir: string; scope: PluginScope }> = [
			{ dir: userPluginsDir(), scope: "user" },
		];
		if (projectTrusted)
			roots.push({ dir: projectPluginsDir(cwd), scope: "project" });

		const report = loadAll(roots, new Set(state.disabled));

		const records = new Map<string, TrustedPluginRecord>();
		for (const record of state.trusted) records.set(record.key, record);
		// Migrate legacy name-only user trust to the scoped key as mcp-only.
		for (const plugin of report.plugins) {
			if (plugin.scope !== "user") continue;
			const legacy = records.get(plugin.manifest.name);
			const key = pluginTrustKey(plugin);
			if (legacy && !records.has(key)) {
				records.set(key, { key, capabilities: [...legacy.capabilities] });
			}
		}

		this.registry = {
			plugins: report.plugins,
			diagnostics: report.diagnostics,
			records,
		};
		return this.registry;
	}

	/** Capabilities that are actually in force for this plugin instance now. */
	effectiveCapabilities(plugin: LoadedPlugin): Set<TrustCapability> {
		const record = this.registry.records.get(pluginTrustKey(plugin));
		const effective = new Set<TrustCapability>();
		if (!record) return effective;
		if (record.capabilities.includes("mcp")) effective.add("mcp");
		if (record.capabilities.includes("pi-entrypoints")) {
			// Project plugins carry no codeIdentity; gate on project trust (already
			// applied by only scanning project plugins when trusted). User plugins
			// require the stored identity to match the installed marker.
			const ok =
				plugin.scope === "project" ||
				(plugin.codeIdentity !== undefined &&
					record.codeIdentity === plugin.codeIdentity);
			if (ok) effective.add("pi-entrypoints");
		}
		return effective;
	}

	/** Names of plugins that currently hold any effective trust capability. */
	get trustedNames(): Set<string> {
		return new Set(
			this.registry.plugins
				.filter((p) => this.effectiveCapabilities(p).size > 0)
				.map((p) => p.manifest.name),
		);
	}

	find(name: string): LoadedPlugin | undefined {
		return this.registry.plugins.find(
			(plugin) => plugin.manifest.name === name,
		);
	}

	setEnabled(name: string, enabled: boolean): RuntimeSyncResult {
		setDisabled(name, !enabled);
		this.scan();
		return this.sync();
	}

	trust(name: string): RuntimeSyncResult {
		const plugin = this.find(name);
		if (!plugin) return this.sync();
		const missing = this.missingCapabilities(plugin);
		const grants = missing.map((cap) => ({
			key: pluginTrustKey(plugin),
			capabilities: [cap] as TrustCapability[],
			...(cap === "pi-entrypoints" && plugin.codeIdentity
				? { codeIdentity: plugin.codeIdentity }
				: {}),
		}));
		if (grants.length > 0) {
			const merged = grantTrust(grants);
			this.registry.records = new Map(merged.trusted.map((r) => [r.key, r]));
		}
		return this.sync();
	}

	trustMany(names: readonly string[]): RuntimeSyncResult {
		let result: RuntimeSyncResult = { changed: false, diagnostics: [] };
		for (const name of names) result = this.trust(name);
		return result;
	}

	/** Capabilities the plugin declares but does not yet effectively hold. */
	missingCapabilities(plugin: LoadedPlugin): TrustCapability[] {
		const effective = this.effectiveCapabilities(plugin);
		const missing: TrustCapability[] = [];
		if (plugin.mcpServers.length > 0 && !effective.has("mcp"))
			missing.push("mcp");
		if (
			discoverPiHooks(plugin).hooks.length > 0 &&
			!effective.has("pi-entrypoints")
		)
			missing.push("pi-entrypoints");
		return missing;
	}

	pendingTrust(): LoadedPlugin[] {
		return this.registry.plugins.filter(
			(plugin) =>
				plugin.enabled && this.missingCapabilities(plugin).length > 0,
		);
	}

	allDiagnostics(): Diagnostic[] {
		return [
			...this.registry.diagnostics,
			...this.registry.plugins.flatMap((plugin) => plugin.diagnostics),
			...this.hookDiagnostics,
		];
	}

	/**
	 * Activate trusted in-process Pi hooks for one scope.
	 *
	 * Idempotent per runtime instance: a hook already activated (by trust key +
	 * path) is skipped so re-invocation (e.g. a rescanned session_start) never
	 * double-registers it.
	 */
	async activateHooks(
		pi: ExtensionAPI,
		scope: PluginScope,
	): Promise<Diagnostic[]> {
		const diagnostics: Diagnostic[] = [];
		const eligible = this.registry.plugins.filter(
			(plugin) =>
				plugin.enabled &&
				plugin.scope === scope &&
				this.effectiveCapabilities(plugin).has("pi-entrypoints"),
		);

		const toActivate: LoadedPiHook[] = [];
		for (const plugin of eligible) {
			const discovered = discoverPiHooks(plugin);
			diagnostics.push(...discovered.diagnostics);
			if (discovered.hooks.length === 0) continue;

			const pending = discovered.hooks.filter(
				(hook) => !this.activatedHooks.has(`${pluginTrustKey(plugin)}::${hook.path}`),
			);
			if (pending.length === 0) continue;

			try {
				mkdirSync(plugin.dataDir, { recursive: true, mode: 0o700 });
			} catch (cause) {
				diagnostics.push(
					error("9.1", `cannot prepare plugin data dir: ${String(cause)}`, {
						path: plugin.dataDir,
						component: plugin.manifest.name,
					}),
				);
				continue;
			}

			for (const hook of pending) {
				this.activatedHooks.add(`${pluginTrustKey(plugin)}::${hook.path}`);
				toActivate.push(hook);
			}
		}

		diagnostics.push(...(await activatePiHooks(pi, toActivate)));
		this.hookDiagnosticsByScope.set(scope, diagnostics);
		return diagnostics;
	}

	discoverResources(cwd: string): ResourcePaths {
		const projectTrusted = this.activeProjectTrusted && this.activeCwd === cwd;
		this.scan(cwd, projectTrusted);

		const enabled = this.registry.plugins.filter((plugin) => plugin.enabled);
		const skillPaths = enabled.flatMap((plugin) =>
			plugin.skills.map((skill) => skill.skillFile),
		);
		const promptPaths = enabled.flatMap((plugin) =>
			this.extensionPaths(plugin, "prompts"),
		);
		const themePaths = enabled.flatMap((plugin) =>
			this.extensionPaths(plugin, "themes"),
		);
		return { skillPaths, promptPaths, themePaths };
	}

	sync(includeProject = this.activeProjectTrusted): RuntimeSyncResult {
		const eligible = this.registry.plugins.filter(
			(plugin) =>
				plugin.enabled && this.effectiveCapabilities(plugin).has("mcp"),
		);
		const preparation = prepareDataDirs(eligible);
		const diagnostics = [...preparation.diagnostics];

		const userProjection = projectAll(
			preparation.plugins.filter((plugin) => plugin.scope === "user"),
		);
		const userResult = syncAdapterConfig(userProjection);
		diagnostics.push(...userResult.diagnostics);

		if (!includeProject) return { changed: userResult.changed, diagnostics };

		const projectProjection = projectAll(
			preparation.plugins.filter((plugin) => plugin.scope === "project"),
		);
		const projectResult = syncAdapterConfig(
			projectProjection,
			projectPiMcpConfigPath(this.activeCwd),
			projectManagedLedgerPath(this.activeCwd),
		);
		diagnostics.push(...projectResult.diagnostics);
		return {
			changed: userResult.changed || projectResult.changed,
			diagnostics,
		};
	}

	private extensionPaths(
		plugin: LoadedPlugin,
		key: "prompts" | "themes",
	): string[] {
		const value = plugin.piExtension?.[key];
		if (!Array.isArray(value)) return [];
		return value.flatMap((relative) => {
			if (typeof relative !== "string") return [];
			const resolved = resolvePluginRelative(plugin.root, relative);
			return resolved ? [resolved] : [];
		});
	}
}
