/**
 * Pi client hooks (§8.1, client policy): discovery, context, and activation of
 * in-process hook modules declared under `extensions["dev.pi.agent"].hooks`.
 *
 * Discovery is pure and filesystem-only — it never imports a module. Module
 * execution (`activatePiHook`, Task 3) stays behind the trust decision.
 */

import { statSync } from "node:fs";
import { extname } from "node:path";

import { createJiti } from "jiti";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveExisting, resolvePluginRelative } from "./paths.ts";
import {
	error,
	warning,
	type Diagnostic,
	type LoadedPlugin,
	type PiClientExtension,
	type PluginManifest,
	type PluginScope,
} from "./types.ts";

const HOOK_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);

/** Immutable per-plugin context handed to a hook module's default export. */
export interface AgentPluginContext {
	pluginName: string;
	pluginRoot: string;
	pluginData: string;
	scope: PluginScope;
	manifest: Readonly<PluginManifest>;
}

/** The default-export contract a hook module must satisfy. */
export type AgentPluginHook = (
	pi: ExtensionAPI,
	context: AgentPluginContext,
) => void | Promise<void>;

/** A validated, contained hook path ready to load once trust is established. */
export interface LoadedPiHook {
	plugin: LoadedPlugin;
	/** Absolute, contained path to the hook module. */
	path: string;
	/** Original `./`-relative value, for diagnostics. */
	relative: string;
}

/** Filesystem-only validation of `extensions["dev.pi.agent"].hooks`. */
export function discoverPiHooks(plugin: LoadedPlugin): {
	hooks: LoadedPiHook[];
	diagnostics: Diagnostic[];
} {
	const raw = (plugin.piExtension as PiClientExtension | undefined)?.hooks;
	if (raw === undefined) return { hooks: [], diagnostics: [] };
	if (!Array.isArray(raw)) {
		return {
			hooks: [],
			diagnostics: [
				warning(
					"8.1",
					'ignoring extensions["dev.pi.agent"].hooks: value must be an array',
					{ path: plugin.root },
				),
			],
		};
	}

	const hooks: LoadedPiHook[] = [];
	const diagnostics: Diagnostic[] = [];
	const seen = new Set<string>();

	for (const value of raw) {
		const skip = (message: string, path = plugin.root): void => {
			diagnostics.push(
				warning("8.1", `skipping hook: ${message}`, {
					path,
					...(typeof value === "string" ? { component: value } : {}),
				}),
			);
		};

		if (typeof value !== "string") {
			skip("value must be a string");
			continue;
		}
		if (!value.startsWith("./")) {
			skip(`path must start with "./": ${value}`);
			continue;
		}
		if (!HOOK_EXTENSIONS.has(extname(value))) {
			skip(`unsupported extension (need .ts/.js/.mjs/.cjs): ${value}`);
			continue;
		}
		const resolved = resolvePluginRelative(plugin.root, value);
		if (!resolved) {
			skip(`path escapes the plugin root: ${value}`);
			continue;
		}
		let isFile = false;
		try {
			isFile = statSync(resolved).isFile();
		} catch {
			isFile = false;
		}
		if (!isFile) {
			skip(`does not exist or is not a regular file: ${value}`, resolved);
			continue;
		}
		const canonical = resolveExisting(resolved);
		if (seen.has(canonical)) {
			skip(`duplicate hook (same resolved path): ${value}`, canonical);
			continue;
		}
		seen.add(canonical);
		hooks.push({ plugin, path: canonical, relative: value });
	}

	return { hooks, diagnostics };
}

/** Frozen context + defensively cloned, frozen manifest. */
export function buildHookContext(hook: LoadedPiHook): AgentPluginContext {
	const p = hook.plugin;
	return Object.freeze({
		pluginName: p.manifest.name,
		pluginRoot: p.root,
		pluginData: p.dataDir,
		scope: p.scope,
		manifest: Object.freeze(structuredClone(p.manifest)) as Readonly<PluginManifest>,
	});
}

const jiti = createJiti(import.meta.url);

/** Load and run one trusted hook. Throws a labeled Error on any failure. */
export async function activatePiHook(
	pi: ExtensionAPI,
	hook: LoadedPiHook,
): Promise<void> {
	let mod: unknown;
	try {
		mod = await jiti.import(hook.path, { default: true });
	} catch (cause) {
		throw hookError(hook, "module import failed", cause);
	}
	if (typeof mod !== "function") {
		throw hookError(hook, "module has no callable default export");
	}
	try {
		await (mod as AgentPluginHook)(pi, buildHookContext(hook));
	} catch (cause) {
		throw hookError(hook, "hook factory threw", cause);
	}
}

/** Activate many; isolate failures as diagnostics so siblings still load. */
export async function activatePiHooks(
	pi: ExtensionAPI,
	hooks: readonly LoadedPiHook[],
): Promise<Diagnostic[]> {
	const diagnostics: Diagnostic[] = [];
	for (const hook of hooks) {
		try {
			await activatePiHook(pi, hook);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			diagnostics.push(
				error("8.1", message, {
					path: hook.path,
					component: `${hook.plugin.manifest.name}:${hook.relative}`,
				}),
			);
		}
	}
	return diagnostics;
}

function hookError(hook: LoadedPiHook, what: string, cause?: unknown): Error {
	const detail = cause instanceof Error ? `: ${cause.message}` : "";
	return new Error(
		`hook ${hook.plugin.manifest.name} (${hook.relative}) ${what}${detail}`,
	);
}
