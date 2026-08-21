import { extname } from "node:path";
import z from "@deepseek-ai/schemastery";
import { Inbox, agentEvents, assembleContextFor, emitAgentEvent } from "@deepseek-ai/dsh-agent";
import { SessionPreparation, canonicalHeader } from "@deepseek-ai/dsh-session";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
//#region src/agent.ts
function errorMessage(error) {
	if (error instanceof Error) {
		const causes = [error.message];
		let cause = error.cause;
		while (cause instanceof Error) {
			causes.push(cause.message);
			cause = cause.cause;
		}
		return causes.join(": ");
	}
	return String(error);
}
function messageTexts(messages) {
	const texts = [];
	for (const message of messages) for (const block of message.content) {
		if (block.type !== "text") throw new Error(`agent-codex: user message ${String(message.id)} contains unsupported ${JSON.stringify(block.type)} content`);
		texts.push(block.text);
	}
	if (texts.every((text) => text.trim().length === 0)) throw new Error("agent-codex: a Codex turn requires non-empty text input");
	return texts;
}
/** One live Harness Agent backed by one Codex thread and app-server process. */
var CodexAgent = class {
	runtimeCtx;
	id;
	options;
	session;
	wire;
	inbox;
	/** Per-Agent registration scope disposed with the Agent handle. */
	scope;
	ctx;
	dispatch;
	phase;
	activityDone = Promise.resolve();
	steering = Promise.resolve();
	constructor(runtimeCtx, id, options, session, wire) {
		this.runtimeCtx = runtimeCtx;
		this.id = id;
		this.options = options;
		this.session = session;
		this.wire = wire;
		this.dispatch = agentEvents(runtimeCtx, this);
		this.inbox = new Inbox(session, {
			inserted: (message) => {
				this.dispatch.emit("agent/inbox/inserted", { message });
			},
			discarded: (message) => {
				this.dispatch.emit("agent/inbox/discarded", { message });
			},
			claimed: (message, turn) => {
				this.dispatch.emit("agent/inbox/claimed", {
					message,
					turn
				});
			}
		});
		const lastTurn = session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
		this.phase = {
			kind: "idle",
			lastTurn
		};
		this.scope = createScope(runtimeCtx, this);
		this.ctx = this.scope.ctx.extend({ agent: this });
	}
	get status() {
		return this.phase.kind === "running" ? "running" : "idle";
	}
	send(message, target, wakeup) {
		const afterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
		this.inbox.append(afterAbort ? "next-turn" : target, message);
		if (!wakeup) return;
		if (target === "next-step" && this.phase.kind === "running" && !afterAbort) this.steering = this.steering.then(() => this.flushSteering()).catch((error) => {
			this.runtimeCtx.logger.warn(`agent-codex "${this.id}": steering failed: ${errorMessage(error)}`);
		});
		this.wake(afterAbort);
	}
	followup(message) {
		this.send(message, "next-turn", true);
	}
	steer(message) {
		this.send(message, "next-step", true);
	}
	inject(message) {
		this.send(message, "next-step", false);
	}
	cancel(cause, options = {}) {
		if (!options.keepInbox) {
			this.inbox.clear();
			if (this.phase.kind !== "idle") this.phase.wakeRequested = false;
		}
		if (this.phase.kind === "idle") return;
		this.phase.abort.abort(cause);
		if (this.phase.kind === "running") this.wire.interrupt();
	}
	runMaintenance(task) {
		if (this.phase.kind !== "idle") throw new Error(`agent "${this.id}" already has active work`);
		const done = Promise.withResolvers();
		const maintenance = {
			kind: "maintenance",
			abort: new AbortController(),
			lastTurn: this.phase.lastTurn,
			wakeRequested: false
		};
		this.phase = maintenance;
		this.activityDone = done.promise;
		return (async () => {
			try {
				return await task(maintenance.abort.signal);
			} finally {
				this.phase = {
					kind: "idle",
					lastTurn: maintenance.lastTurn
				};
				if (maintenance.wakeRequested && this.inbox.hasPending) this.wake();
				done.resolve();
			}
		})();
	}
	async whenIdle() {
		let observed;
		do
			await (observed = this.activityDone);
		while (observed !== this.activityDone);
	}
	setPhase(next) {
		const previous = this.status;
		this.phase = next;
		if (previous !== this.status) this.dispatch.emit("agent/status", { status: this.status });
	}
	wake(afterAbort = false) {
		if (this.phase.kind !== "idle") {
			if (this.phase.abort.signal.reason?.kind !== "disposed" && (this.phase.kind === "maintenance" || afterAbort)) this.phase.wakeRequested = true;
			return;
		}
		const done = Promise.withResolvers();
		this.activityDone = done.promise;
		this.setPhase({
			kind: "running",
			abort: new AbortController(),
			turn: this.phase.lastTurn,
			step: 0,
			wakeRequested: false
		});
		this.runtimeCtx.agents.withInitiator(this, () => this.drive()).finally(done.resolve);
	}
	async drive() {
		try {
			while (this.inbox.hasPending && this.phase.kind === "running") await this.runTurn();
		} catch {} finally {
			if (this.phase.kind !== "running") return;
			const { turn, wakeRequested } = this.phase;
			this.setPhase({
				kind: "idle",
				lastTurn: turn
			});
			if (wakeRequested && this.inbox.hasPending) this.wake();
		}
	}
	async flushSteering() {
		if (this.phase.kind !== "running" || this.phase.abort.signal.aborted || this.inbox.nextStep.length === 0) return;
		const phase = this.phase;
		const messages = this.inbox.claim("next-step", phase.turn);
		try {
			await this.wire.steer(messageTexts(messages), phase.abort.signal);
			for (const message of messages) this.session.append("user/message", message, { surfaceOp: "append" });
		} catch (error) {
			for (const message of messages.toReversed()) this.inbox.prepend("next-step", message);
			throw error;
		}
	}
	async runTurn() {
		if (this.phase.kind !== "running") throw new Error(`agent-codex "${this.id}": turn outside running phase`);
		const phase = this.phase;
		const turn = phase.turn + 1;
		const step = 1;
		phase.turn = turn;
		phase.step = step;
		this.session.append("turn/start", { turn });
		let reason = { kind: "completed" };
		let stepStarted = false;
		let assistantLogged = false;
		let streamedText = "";
		let usage;
		const chunkSeqs = [];
		try {
			const messages = this.inbox.claim("next-turn", turn);
			if (messages.length === 0) return;
			const texts = messageTexts(messages);
			this.session.append("step/start", {
				turn,
				step
			});
			stepStarted = true;
			for (const message of messages) this.session.append("user/message", message, { surfaceOp: "append" });
			chunkSeqs.push(this.session.append("assistant/chunk", {
				turn,
				step,
				chunk: {
					type: "block-start",
					index: 0,
					blockType: "text"
				}
			}).seq);
			const result = await this.wire.runTurn(texts, {
				delta: (text) => {
					streamedText += text;
					chunkSeqs.push(this.session.append("assistant/chunk", {
						turn,
						step,
						chunk: {
							type: "text-delta",
							index: 0,
							text
						}
					}).seq);
				},
				usage: (value) => {
					usage = value;
				}
			}, phase.abort.signal);
			if (result.text.length > 0) {
				chunkSeqs.push(this.session.append("assistant/chunk", {
					turn,
					step,
					chunk: {
						type: "block-end",
						index: 0,
						block: {
							type: "text",
							text: result.text
						}
					}
				}).seq);
				if (usage !== void 0) chunkSeqs.push(this.session.append("assistant/chunk", {
					turn,
					step,
					chunk: {
						type: "usage",
						usage
					}
				}).seq);
				this.session.append("assistant/message", {
					turn,
					step,
					message: createAssistantMessage({
						content: [{
							type: "text",
							text: result.text
						}],
						source: {
							provider: this.options.provider ?? "codex",
							model: this.options.model ?? "codex-default"
						}
					}),
					...usage === void 0 ? {} : { usage },
					...result.status === "interrupted" ? { interrupted: true } : {}
				}, {
					surfaceOp: "append",
					sourceEventSeqs: chunkSeqs
				});
				assistantLogged = true;
			}
			if (result.status === "interrupted") reason = {
				kind: "aborted",
				reason: phase.abort.signal.reason ?? { kind: "user" }
			};
		} catch (error) {
			if (phase.abort.signal.aborted) {
				reason = {
					kind: "aborted",
					reason: phase.abort.signal.reason
				};
				if (stepStarted && !assistantLogged && streamedText.length > 0) {
					chunkSeqs.push(this.session.append("assistant/chunk", {
						turn,
						step,
						chunk: {
							type: "block-end",
							index: 0,
							block: {
								type: "text",
								text: streamedText
							}
						}
					}).seq);
					if (usage !== void 0) chunkSeqs.push(this.session.append("assistant/chunk", {
						turn,
						step,
						chunk: {
							type: "usage",
							usage
						}
					}).seq);
					this.session.append("assistant/message", {
						turn,
						step,
						message: createAssistantMessage({
							content: [{
								type: "text",
								text: streamedText
							}],
							source: {
								provider: this.options.provider ?? "codex",
								model: this.options.model ?? "codex-default"
							}
						}),
						interrupted: true,
						...usage === void 0 ? {} : { usage }
					}, {
						surfaceOp: "append",
						sourceEventSeqs: chunkSeqs
					});
				}
			} else reason = {
				kind: "error",
				error: {
					code: "CODEX_APP_SERVER",
					message: errorMessage(error)
				}
			};
			this.dispatch.emit("agent/error", {
				turn,
				step,
				error
			});
			throw error;
		} finally {
			await this.steering;
			if (stepStarted) this.session.append("step/end", {
				turn,
				step
			});
			this.session.append("turn/end", {
				turn,
				reason
			});
		}
		if (this.inbox.hasPending) {
			phase.abort = new AbortController();
			phase.step = 0;
			phase.wakeRequested = false;
		}
	}
};
//#endregion
//#region src/types.ts
/**
* Cast a validated non-empty app-server thread id at the wire boundary.
* @param value - Non-empty thread id returned by app-server.
* @returns The branded durable Codex thread identity.
*/
const CodexThreadId = (value) => value;
//#endregion
//#region src/wire.ts
function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`agent-codex: app-server returned invalid ${label}`);
	return value;
}
function string(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`agent-codex: app-server returned invalid ${label}`);
	return value;
}
function optionalString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function count(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function tokenUsage(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const fields = value;
	const rawInput = count(fields.inputTokens);
	const outputTokens = count(fields.outputTokens);
	if (rawInput === void 0 || outputTokens === void 0) return void 0;
	const cacheReadTokens = count(fields.cachedInputTokens ?? fields.cacheReadTokens) ?? 0;
	const cacheWriteTokens = count(fields.cacheWriteTokens) ?? 0;
	const reasoningTokens = count(fields.reasoningOutputTokens ?? fields.reasoningTokens);
	return {
		inputTokens: Math.max(0, rawInput - cacheReadTokens - cacheWriteTokens),
		outputTokens,
		...cacheReadTokens === 0 ? {} : { cacheReadTokens },
		...cacheWriteTokens === 0 ? {} : { cacheWriteTokens },
		...reasoningTokens === void 0 ? {} : { reasoningTokens }
	};
}
function unattendedDecision(params) {
	const available = params.availableDecisions;
	if (!Array.isArray(available)) return "decline";
	if (available.includes("cancel")) return "cancel";
	if (available.includes("decline")) return "decline";
	throw new Error("agent-codex: app-server offered no safe unattended approval decision");
}
/** One initialized app-server connection with one active thread and at most one active turn. */
var CodexAppServerWire = class {
	transport;
	fatal = Promise.withResolvers();
	threadId;
	turnId;
	active;
	closed = false;
	constructor(input, output) {
		this.transport = new JsonRpcLineTransport(input, output);
		this.fatal.promise.catch(() => {});
		this.transport.onRequest((method, params) => this.handleRequest(method, params));
		this.transport.onNotification((method, params) => {
			try {
				this.handleNotification(method, params);
			} catch (error) {
				this.fail(error);
			}
		});
		input.on("end", () => {
			this.fail(/* @__PURE__ */ new Error("agent-codex: app-server protocol stream closed"));
		});
		input.on("error", (error) => {
			this.fail(error);
		});
		output.on("error", (error) => {
			this.fail(error);
		});
	}
	/** Begin reading app-server frames. */
	start() {
		this.transport.start();
	}
	/**
	* Perform the required initialize/initialized handshake.
	* @param signal - Cancels the handshake and pending protocol request.
	* @returns The app-server version, or `unknown` when the server omits it.
	*/
	async initialize(signal) {
		const response = object(await this.guarded(this.transport.request("initialize", {
			clientInfo: {
				name: "deepseek-harness",
				title: "DeepSeek Harness",
				version: "0.1.0"
			},
			capabilities: {
				experimentalApi: false,
				requestAttestation: false
			}
		}, signal)), "initialize response");
		const version = optionalString((response.serverInfo === void 0 ? void 0 : object(response.serverInfo, "serverInfo"))?.version) ?? optionalString(response.version) ?? "unknown";
		this.transport.notify("initialized");
		await this.guarded(this.transport.flush(), signal);
		return version;
	}
	/**
	* Create and retain a durable Codex thread.
	* @param options - Thread workspace, policy, model, and developer instructions.
	* @param signal - Cancels the thread creation request.
	* @returns The durable thread identity returned by app-server.
	*/
	async startThread(options, signal) {
		const thread = object(object(await this.guarded(this.transport.request("thread/start", {
			cwd: options.cwd,
			approvalPolicy: options.approvalPolicy,
			sandbox: options.sandbox,
			ephemeral: false,
			...options.model === void 0 ? {} : { model: options.model },
			...options.developerInstructions === void 0 || options.developerInstructions.length === 0 ? {} : { developerInstructions: options.developerInstructions }
		}, signal)), "thread/start response").thread, "thread/start thread");
		const id = CodexThreadId(string(thread.id, "thread/start thread id"));
		this.threadId = id;
		return id;
	}
	/**
	* Resume one user-managed Codex thread and verify its identity.
	* @param threadId - Durable Codex thread identity recorded by Harness.
	* @param signal - Cancels the resume request.
	*/
	async resumeThread(threadId, signal) {
		if (string(object(object(await this.guarded(this.transport.request("thread/resume", { threadId }, signal)), "thread/resume response").thread, "thread/resume thread").id, "thread/resume thread id") !== threadId) throw new Error("agent-codex: app-server resumed a different thread");
		this.threadId = threadId;
	}
	/**
	* Start one text turn and await its authoritative terminal notification.
	* @param texts - Ordered non-empty user text blocks for the turn.
	* @param observer - Receives final-answer deltas and latest token usage.
	* @param signal - Cancels the active turn wait.
	* @returns Terminal turn status, assembled text, and optional usage.
	*/
	async runTurn(texts, observer, signal) {
		if (this.active !== void 0) throw new Error("agent-codex: a Codex turn is already active");
		const threadId = this.requireThread();
		const completion = Promise.withResolvers();
		this.active = {
			observer,
			completion,
			itemPhases: /* @__PURE__ */ new Map(),
			text: ""
		};
		try {
			const turn = object(object(await this.guarded(this.transport.request("turn/start", {
				threadId,
				input: texts.map((text) => ({
					type: "text",
					text,
					text_elements: []
				}))
			}, signal)), "turn/start response").turn, "turn/start turn");
			this.turnId = string(turn.id, "turn/start turn id");
			return await this.guarded(completion.promise, signal);
		} finally {
			this.active = void 0;
			this.turnId = void 0;
		}
	}
	/**
	* Add user text to the active Codex turn.
	* @param texts - Ordered non-empty user text blocks to steer with.
	* @param signal - Cancels the steering request.
	*/
	async steer(texts, signal) {
		const threadId = this.requireThread();
		if (this.turnId === void 0) throw new Error("agent-codex: no active turn to steer");
		await this.guarded(this.transport.request("turn/steer", {
			threadId,
			turnId: this.turnId,
			input: texts.map((text) => ({
				type: "text",
				text,
				text_elements: []
			}))
		}, signal));
	}
	/** Best-effort interruption of the active remote turn. */
	interrupt() {
		if (this.threadId === void 0 || this.turnId === void 0 || this.closed) return;
		this.transport.request("turn/interrupt", {
			threadId: this.threadId,
			turnId: this.turnId
		}).catch(() => {});
	}
	/** Close framing and reject outstanding protocol requests. */
	close() {
		if (this.closed) return;
		this.closed = true;
		this.transport.close();
	}
	requireThread() {
		if (this.threadId === void 0) throw new Error("agent-codex: no Codex thread is attached");
		return this.threadId;
	}
	guarded(pending, signal) {
		const guarded = Promise.race([pending, this.fatal.promise]);
		if (signal === void 0) return guarded;
		if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error(`agent-codex: app-server request aborted: ${String(signal.reason)}`));
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error(`agent-codex: app-server request aborted: ${String(signal.reason)}`));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			guarded.then(resolve, reject).finally(() => {
				signal.removeEventListener("abort", onAbort);
			});
		});
	}
	fail(value) {
		const error = value instanceof Error ? value : new Error(String(value));
		this.active?.completion.reject(error);
		this.fatal.reject(error);
	}
	validateIds(params, nullableTurn = false) {
		if (params.threadId !== this.threadId) throw new Error("agent-codex: app-server request referenced another thread");
		if (nullableTurn && params.turnId === null) return;
		if (this.turnId !== void 0 && params.turnId !== this.turnId) throw new Error("agent-codex: app-server request referenced another turn");
	}
	handleRequest(method, params) {
		this.validateIds(params, method === "mcpServer/elicitation/request");
		switch (method) {
			case "item/commandExecution/requestApproval":
			case "item/fileChange/requestApproval": return Promise.resolve({ decision: unattendedDecision(params) });
			case "item/permissions/requestApproval": return Promise.resolve({
				permissions: {},
				scope: "turn"
			});
			case "item/tool/requestUserInput": return Promise.resolve({ answers: {} });
			case "mcpServer/elicitation/request": return Promise.resolve({
				action: "decline",
				content: null,
				_meta: null
			});
			default: return Promise.reject(/* @__PURE__ */ new Error(`agent-codex: unsupported app-server request ${JSON.stringify(method)}`));
		}
	}
	handleNotification(method, params) {
		if (params.threadId !== void 0 && params.threadId !== this.threadId) return;
		const active = this.active;
		if (active === void 0) return;
		if (method === "turn/started") {
			const turn = object(params.turn, "turn/started turn");
			this.turnId ??= string(turn.id, "turn/started turn id");
			return;
		}
		if (params.turnId !== void 0 && this.turnId !== void 0 && params.turnId !== this.turnId) return;
		if (method === "item/started") {
			const item = object(params.item, "item/started item");
			const id = optionalString(item.id);
			if (id !== void 0 && item.type === "agentMessage") active.itemPhases.set(id, item.phase);
			return;
		}
		if (method === "item/agentMessage/delta") {
			const itemId = optionalString(params.itemId);
			if ((itemId === void 0 ? void 0 : active.itemPhases.get(itemId)) === "commentary") return;
			const delta = string(params.delta, "agent message delta");
			active.text += delta;
			active.observer.delta(delta);
			return;
		}
		if (method === "item/completed") {
			const item = object(params.item, "item/completed item");
			if (item.type !== "agentMessage" || item.phase === "commentary") return;
			const text = string(item.text, "completed agent message text");
			if (active.text.length === 0) active.text = text;
			return;
		}
		if (method === "thread/tokenUsage/updated") {
			const container = object(params.tokenUsage, "token usage");
			const usage = tokenUsage(container.last ?? container);
			if (usage !== void 0) {
				active.usage = usage;
				active.observer.usage(usage);
			}
			return;
		}
		if (method !== "turn/completed") return;
		const turn = object(params.turn, "turn/completed turn");
		const status = turn.status;
		if (status === "completed" || status === "interrupted") {
			active.completion.resolve({
				status,
				text: active.text,
				...active.usage === void 0 ? {} : { usage: active.usage }
			});
			return;
		}
		const error = turn.error === void 0 ? "" : `: ${JSON.stringify(turn.error)}`;
		active.completion.reject(/* @__PURE__ */ new Error(`agent-codex: Codex turn ended with status ${String(status)}${error}`));
	}
};
//#endregion
//#region \0@oxc-project+runtime@0.146.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "agent-codex";
/** Services required by the bridge. Deliberately excludes LLM and Harness tool services. */
const inject = [
	"agents",
	"sessions",
	"subprocess",
	"systemPrompt"
];
const DEFAULT_COMMAND = "codex";
const DEFAULT_ARGS = [
	"app-server",
	"--listen",
	"stdio://"
];
const WINDOWS_COMMAND_INTERPRETER = "cmd.exe";
const DEFAULT_DISPOSE_GRACE_MS = 3e3;
/** Runtime schema for the Codex AgentFactory bridge. */
const Config = z.object({
	command: z.string().min(1).default(DEFAULT_COMMAND),
	args: z.array(z.string()).default(DEFAULT_ARGS),
	env: z.dict(z.string()).default({}),
	cwd: z.string().min(1),
	approvalPolicy: z.union([
		"untrusted",
		"on-failure",
		"on-request",
		"never"
	]).default("never"),
	sandbox: z.union([
		"read-only",
		"workspace-write",
		"danger-full-access"
	]).default("workspace-write"),
	disposeGraceMs: z.number().min(1).max(2147483647).default(DEFAULT_DISPOSE_GRACE_MS)
});
function abortError(signal, id) {
	return signal.reason instanceof Error ? signal.reason : new Error(`agent-codex: agent "${id}" creation aborted`, { cause: signal.reason });
}
function isWindowsCommandShim(executable) {
	const extension = extname(executable).toLowerCase();
	return extension === ".bat" || extension === ".cmd";
}
async function raceAbort(pending, signal, id) {
	if (signal.aborted) throw abortError(signal, id);
	return await new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(abortError(signal, id));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(pending).then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
}
async function disposeProcess(wire, child) {
	wire?.close();
	if (child === void 0) return;
	try {
		child.stdin?.end();
	} catch {}
	child.terminate();
	await child.waitForExit();
	await child.done.catch(() => {});
}
/** Factory implementation retained only by its Cordis registration effect. */
var CodexAgentFactory = class {
	ctx;
	config;
	shutdown = new AbortController();
	active = /* @__PURE__ */ new Set();
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
	}
	/** Stop and drain every app-server process created by this factory. */
	async dispose() {
		this.shutdown.abort(/* @__PURE__ */ new Error("agent-codex: provider disposed"));
		await Promise.all([...this.active].map((dispose) => dispose()));
	}
	async createAgent(ownerCtx, options) {
		const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
			...options.seed === void 0 ? {} : { seed: options.seed },
			...options.meta === void 0 ? {} : { meta: options.meta }
		}));
		return this.prepareAndPublish(ownerCtx, preparation, options.sessionId, options.agentOptions ?? {}, options.setup, options.signal, "startup");
	}
	async resume(ownerCtx, options) {
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence === void 0) throw new Error("agent-codex: cannot resume without a session-persistence provider");
		const ownerAbort = new AbortController();
		const unfollow = ownerCtx.effect(() => () => {
			ownerAbort.abort(/* @__PURE__ */ new Error(`agent-codex: owner disposed while loading "${options.resumeSessionId}"`));
		}, `agentCodex.resumeLoad(${options.resumeSessionId})`);
		const signal = AbortSignal.any([
			this.shutdown.signal,
			ownerAbort.signal,
			...options.signal === void 0 ? [] : [options.signal]
		]);
		let preparation;
		try {
			preparation = await raceAbort(persistence.prepare(options.resumeSessionId, signal), signal, options.resumeSessionId);
		} finally {
			await unfollow();
		}
		if (preparation === void 0) throw new Error(`agent-codex: persistence returned no session preparation for "${options.resumeSessionId}"`);
		return this.prepareAndPublish(ownerCtx, preparation, options.resumeSessionId, options.agentOptions ?? {}, options.setup, options.signal, "resume");
	}
	async prepareAndPublish(ownerCtx, preparation, id, agentOptions, setup, callerSignal, source) {
		try {
			var _usingCtx$1 = _usingCtx();
			const ownedPreparation = _usingCtx$1.u(preparation);
			ownerCtx.fiber.assertActive();
			const ownerAbort = new AbortController();
			const signal = AbortSignal.any([
				this.shutdown.signal,
				ownerAbort.signal,
				...callerSignal === void 0 ? [] : [callerSignal]
			]);
			const session = ownedPreparation.session;
			const cwd = session.header.cwd ?? this.config.cwd;
			if (cwd === void 0) throw new Error(`agent-codex: session "${id}" has no cwd and the plugin has no fallback cwd`);
			let child;
			let wire;
			let agent;
			let detachAgent;
			let detachSession;
			let disposing;
			const dispose = () => disposing ??= (async () => {
				ownerAbort.abort(/* @__PURE__ */ new Error(`agent-codex: agent "${id}" disposed`));
				if (agent !== void 0) {
					agent.cancel({ kind: "disposed" });
					await agent.whenIdle();
				}
				await disposeProcess(wire, child);
				await agent?.scope.dispose();
				detachAgent?.();
				detachSession?.();
				this.active.delete(dispose);
			})();
			this.active.add(dispose);
			const unfollowOwner = ownerCtx.effect(() => () => dispose(), `agentCodex.lifecycle(${id})`);
			try {
				const executable = await raceAbort(this.ctx.subprocess.resolveExecutable(this.config.command, this.config.env, signal), signal, id);
				let argv = [executable, ...this.config.args];
				if (isWindowsCommandShim(executable)) {
					const interpreter = await raceAbort(this.ctx.subprocess.resolveExecutable(WINDOWS_COMMAND_INTERPRETER, this.config.env, signal), signal, id);
					if (isWindowsCommandShim(interpreter)) throw new Error("agent-codex: cmd.exe resolved to a command shim instead of a native executable");
					argv = [
						interpreter,
						"/d",
						"/s",
						"/c",
						executable,
						...this.config.args
					];
				}
				child = this.ctx.subprocess.spawn({
					argv,
					cwd,
					env: this.config.env,
					stdio: {
						stdin: "pipe",
						stdout: "pipe",
						stderr: { maxBytes: 65536 }
					},
					graceMs: this.config.disposeGraceMs,
					signal
				});
				child.done.catch(() => {});
				if (child.stdin === void 0 || child.stdout === void 0) throw new Error("agent-codex: subprocess provider did not expose app-server stdio");
				wire = new CodexAppServerWire(child.stdout, child.stdin);
				agent = new CodexAgent(this.ctx, id, agentOptions, session, wire);
				(await raceAbort(setup?.(agent.ctx), signal, id))?.commit();
				signal.throwIfAborted();
				wire.start();
				const appServerVersion = await wire.initialize(signal);
				const link = session.events.findLast((event) => event.type === "codex/thread-linked");
				const adoptBlankSession = source === "resume" && link === void 0 && !session.events.some((event) => event.type === "turn/start");
				if (source === "startup" || adoptBlankSession) {
					const assembly = await this.ctx.systemPrompt.assemble(assembleContextFor(agent, signal));
					const developerInstructions = renderPrompt(assembly);
					const threadId = await wire.startThread({
						cwd,
						approvalPolicy: this.config.approvalPolicy,
						sandbox: this.config.sandbox,
						...agentOptions.model === void 0 ? {} : { model: agentOptions.model },
						...developerInstructions.length === 0 ? {} : { developerInstructions }
					}, signal);
					session.append("codex/thread-linked", {
						threadId,
						appServerVersion
					});
					session.append("request/header", {
						header: canonicalHeader({
							config: {
								provider: agentOptions.provider ?? "codex",
								model: agentOptions.model ?? "codex-default"
							},
							...developerInstructions.length === 0 ? {} : { system: developerInstructions }
						}),
						reason: session.requestHeader() === void 0 ? "initial" : "change"
					});
				} else {
					if (link === void 0) throw new Error(`agent-codex: session "${id}" started without a codex/thread-linked event and cannot be adopted`);
					await wire.resumeThread(link.data.threadId, signal);
				}
				signal.throwIfAborted();
				detachSession = agent.ctx.sessions.enter(session);
				detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent);
				agent.ctx.sessions.announce(session);
				this.ctx.agents.announce(agent);
				emitAgentEvent(this.ctx, agent, "agent/session-start", { source });
				signal.throwIfAborted();
				return {
					agent,
					dispose: async () => {
						await unfollowOwner();
					}
				};
			} catch (error) {
				await dispose();
				await unfollowOwner();
				throw error;
			}
		} catch (_) {
			_usingCtx$1.e = _;
		} finally {
			_usingCtx$1.d();
		}
	}
};
/** Register the Codex bridge as the sole AgentFactory for this composition. */
function apply(ctx, config = {}) {
	const resolved = {
		command: config.command ?? DEFAULT_COMMAND,
		args: config.args ?? DEFAULT_ARGS,
		env: config.env ?? {},
		...config.cwd === void 0 ? {} : { cwd: config.cwd },
		approvalPolicy: config.approvalPolicy ?? "never",
		sandbox: config.sandbox ?? "workspace-write",
		disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
	};
	if (resolved.command.trim().length === 0) throw new Error("agent-codex: command must be non-empty");
	if (!Number.isFinite(resolved.disposeGraceMs) || resolved.disposeGraceMs <= 0) throw new Error("agent-codex: disposeGraceMs must be positive and finite");
	const factory = new CodexAgentFactory(ctx, resolved);
	ctx.effect(() => () => factory.dispose(), "agentCodex.agents()");
	ctx.effect(() => ctx.agents.setFactory(factory), "agentCodex.setFactory()");
}
//#endregion
export { CodexAgent, CodexAppServerWire, CodexThreadId, Config, apply, inject, name };
