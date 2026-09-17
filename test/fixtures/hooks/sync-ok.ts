export default (pi, ctx) => {
	pi.on("tool_call", () => undefined);
	globalThis.__hookCalls?.push({ name: "sync-ok", root: ctx.pluginRoot });
};
