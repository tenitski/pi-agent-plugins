/**
 * Client-owned enable/disable state.
 *
 * Enablement UX is explicitly outside the spec, so this is a small local file
 * rather than anything derived from the manifest.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { statePath } from "./paths-client.ts";
import type { TrustCapability, TrustedPluginRecord } from "./types.ts";

export interface PluginState {
	/** Plugin names the user has explicitly disabled. */
	disabled: string[];
	/** Trust grants per installed plugin instance. */
	trusted: TrustedPluginRecord[];
}

const EMPTY: PluginState = { disabled: [], trusted: [] };
const CAPABILITIES: readonly TrustCapability[] = ["mcp", "pi-entrypoints"];

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
}

function parseCapabilities(value: unknown): TrustCapability[] {
	if (!Array.isArray(value)) return [];
	return CAPABILITIES.filter((cap) => value.includes(cap));
}

function mergeInto(
	byKey: Map<string, TrustedPluginRecord>,
	record: TrustedPluginRecord,
): void {
	const existing = byKey.get(record.key);
	if (!existing) {
		byKey.set(record.key, {
			key: record.key,
			capabilities: [...new Set(record.capabilities)],
			...(record.codeIdentity ? { codeIdentity: record.codeIdentity } : {}),
		});
		return;
	}
	existing.capabilities = [
		...new Set([...existing.capabilities, ...record.capabilities]),
	];
	if (record.codeIdentity) existing.codeIdentity = record.codeIdentity;
}

/** Accept legacy strings (→ mcp only) and new records; drop anything malformed. */
function parseTrusted(value: unknown): TrustedPluginRecord[] {
	if (!Array.isArray(value)) return [];
	const byKey = new Map<string, TrustedPluginRecord>();
	for (const entry of value) {
		if (typeof entry === "string") {
			mergeInto(byKey, { key: entry, capabilities: ["mcp"] });
			continue;
		}
		if (typeof entry === "object" && entry !== null) {
			const key = (entry as { key?: unknown }).key;
			if (typeof key !== "string") continue;
			const capabilities = parseCapabilities(
				(entry as { capabilities?: unknown }).capabilities,
			);
			const codeIdentity = (entry as { codeIdentity?: unknown }).codeIdentity;
			mergeInto(byKey, {
				key,
				capabilities,
				...(typeof codeIdentity === "string" ? { codeIdentity } : {}),
			});
		}
	}
	return [...byKey.values()];
}

/** Byte-order comparison, so persisted state does not vary with the host locale. */
function byCodeUnit(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

export function readState(path = statePath()): PluginState {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
			string,
			unknown
		>;
		return {
			disabled: stringArray(parsed.disabled),
			trusted: parseTrusted(parsed.trusted),
		};
	} catch {
		return { ...EMPTY };
	}
}

function writeState(state: PluginState, path = statePath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
	const normalized: PluginState = {
		disabled: [...new Set(state.disabled)].sort(byCodeUnit),
		trusted: [...state.trusted]
			.map((r) => ({
				key: r.key,
				capabilities: CAPABILITIES.filter((c) => r.capabilities.includes(c)),
				...(r.codeIdentity ? { codeIdentity: r.codeIdentity } : {}),
			}))
			.sort((a, b) => byCodeUnit(a.key, b.key)),
	};
	writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
}

export function setDisabled(
	name: string,
	disabled: boolean,
	path = statePath(),
): PluginState {
	const state = readState(path);
	const set = new Set(state.disabled);
	if (disabled) set.add(name);
	else set.delete(name);
	const next: PluginState = { ...state, disabled: [...set] };
	writeState(next, path);
	return next;
}

export function grantTrust(
	grants: ReadonlyArray<{
		key: string;
		capabilities: TrustCapability[];
		codeIdentity?: string;
	}>,
	path = statePath(),
): PluginState {
	const state = readState(path);
	const byKey = new Map(state.trusted.map((r) => [r.key, r] as const));
	for (const grant of grants) mergeInto(byKey, grant);
	const next: PluginState = { ...state, trusted: [...byKey.values()] };
	writeState(next, path);
	return next;
}
