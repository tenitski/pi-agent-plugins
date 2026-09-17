/**
 * Pi client hooks (§8.1, client policy): discovery, context, and activation of
 * in-process hook modules declared under `extensions["dev.pi.agent"].hooks`.
 *
 * Discovery is pure and filesystem-only — it never imports a module. Module
 * execution (`activatePiHook`, Task 3) stays behind the trust decision.
 */

import { statSync } from "node:fs";
import { extname } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolvePluginRelative } from "./paths.ts";
import {
	warning,
	type Diagnostic,
	type LoadedPlugin,
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
	const raw = (plugin.piExtension as { hooks?: unknown } | undefined)?.hooks;
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
			skip(`not a regular file: ${value}`, resolved);
			continue;
		}
		if (seen.has(resolved)) {
			skip(`duplicate hook (same resolved path): ${value}`, resolved);
			continue;
		}
		seen.add(resolved);
		hooks.push({ plugin, path: resolved, relative: value });
	}

	return { hooks, diagnostics };
}
