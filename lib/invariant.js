//#region src/invariant.ts
const PACKAGE_NAME = "@deepseek-ai/dsh-experimental-agent-codex";
/** Cordis companion plugin name. */
const name = "agent-codex-invariant";
/** Invariant registry required by the companion. */
const inject = ["invariants"];
const install = Object.assign((ctx, fail) => {
	ctx.on("internal/dispatch", (_mode, eventName, args) => {
		if (eventName !== "session/event") return;
		const [session, event] = args;
		if (event.type !== "codex/thread-linked") return;
		if (session.events.some((candidate) => candidate.type === "codex/thread-linked")) fail(`session "${session.id}" contains more than one Codex thread link`);
		if (event.data.threadId.trim().length === 0 || event.data.appServerVersion.trim().length === 0) fail(`session "${session.id}" contains an empty Codex thread link field`);
		if (session.events.some((candidate) => candidate.type === "turn/start")) fail(`session "${session.id}" linked its Codex thread after turns had started`);
	}, { global: true });
}, { inject: ["sessions"] });
/** Register the package invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
