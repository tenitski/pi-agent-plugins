export default async (pi, ctx) => {
	await Promise.resolve();
	globalThis.__hookCalls?.push({ name: "async-ok", scope: ctx.scope });
};
