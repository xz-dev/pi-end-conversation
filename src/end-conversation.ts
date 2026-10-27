import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CUSTOM_TYPE,
	isReconfirmed,
	isValidLockEntry,
	LOCK_VERSION,
	SUCCESS_MESSAGE,
	TOOL_NAME,
	type HistoryMessage,
} from "./state.js";

// A2: sustained-abuse-only welfare description. SHA-256 asserted by tests
// (fe96a2ce410fd723d64feb87374d0f206b9c8dc2c075c6c66589601d39da0161).
export const DESCRIPTION = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "description.txt"),
	"utf8",
);

// A3 prefix + A2 (sha256 6142e150309246f9f9d07a1f53ddf0de310d8d8fe658989697c42e0ae76990e5).
export const REFLECTION_PREFIX =
	"Re-read the EndConversation tool guidance below. Confirm this conversation meets those criteria " +
	"and that you are certain you want to end it. If so, call EndConversation again immediately to " +
	"actually end the conversation. Otherwise, continue the conversation instead.\n\n---\n";
export const REFLECTION_TEXT = REFLECTION_PREFIX + DESCRIPTION;

const ENDED_NOTICE = `This session has been ended by the model. Start a new session with /new or select another with /resume; the history remains readable.`;
const ENDED_NOTICE_EPHEMERAL = `${ENDED_NOTICE} This session has no persistence, so the lock is not durable and is lost when the session is discarded.`;
const BLOCKED_INPUT_NOTICE = `This session has ended. Start a new session with /new or select another with /resume.`;
const PERSIST_FAILURE = `EndConversation failed to persist the session lock; the conversation was not ended.`;

/**
 * Entry ids of lock-shaped custom entries this runtime appended without a
 * confirmed persistence (append threw or no file exists). The host pushes
 * entries into memory before persisting, so residue exists; it must never be
 * read back as a valid lock. Keyed by session file (or in-memory marker) so an
 * in-process extension reload over the same SessionManager keeps the
 * knowledge; a reloaded-from-disk SessionManager has no residue anyway.
 */
const UNCONFIRMED_KEY = "__piEndConversationUnconfirmed__";
type UnconfirmedStore = Map<string, Set<string>>;
const unconfirmedStore: UnconfirmedStore = (() => {
	const g = globalThis as unknown as Record<string, UnconfirmedStore | undefined>;
	if (!g[UNCONFIRMED_KEY]) g[UNCONFIRMED_KEY] = new Map();
	return g[UNCONFIRMED_KEY]!;
})();

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `in-memory:${ctx.sessionManager.getSessionId()}`;
}

interface LockState {
	durable: boolean;
	unconfirmed: Set<string>;
}

function toolHistory(entries: readonly SessionEntry[]): HistoryMessage[] {
	const out: HistoryMessage[] = [];
	for (const e of entries) {
		if (e.type !== "message") continue;
		out.push(e.message as unknown as HistoryMessage);
	}
	return out;
}

function isLockShapedFor(e: SessionEntry, sessionId: string): boolean {
	if (e.type !== "custom" || e.customType !== CUSTOM_TYPE) return false;
	const d = e.data as { sessionId?: unknown } | undefined;
	return !!d && typeof d === "object" && d.sessionId === sessionId;
}

export default function (pi: ExtensionAPI): void {
	const states = new Map<string, LockState>();

	const stateFor = (ctx: ExtensionContext): LockState => {
		const key = sessionKey(ctx);
		let st = states.get(key);
		if (!st) {
			st = {
				durable: ctx.sessionManager.getSessionFile() !== undefined,
				unconfirmed: unconfirmedStore.get(key) ?? new Set<string>(),
			};
			unconfirmedStore.set(key, st.unconfirmed);
			states.set(key, st);
		}
		return st;
	};

	/** A normally accepted lock record exists for the current session. */
	const locked = (ctx: ExtensionContext, st: LockState): boolean => {
		const sessionId = ctx.sessionManager.getSessionId();
		return ctx.sessionManager
			.getEntries()
			.some((e) => !st.unconfirmed.has(e.id) && isValidLockEntry(e, sessionId));
	};

	pi.on("session_start", (_event, ctx) => {
		stateFor(ctx);
		if (ctx.mode !== "tui") return;
		registerEndTool();
	});

	pi.on("session_shutdown", () => {
		states.clear();
	});

	function registerEndTool(): void {
		pi.registerTool({
			name: TOOL_NAME,
			label: "End conversation",
			description: DESCRIPTION,
			parameters: Type.Object(
				{},
				{
					$schema: "https://json-schema.org/draft/2020-12/schema",
					additionalProperties: false,
				},
			),
			executionMode: "sequential",
			async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
				const st = stateFor(ctx);
				if (locked(ctx, st)) {
					return {
						content: [{ type: "text", text: SUCCESS_MESSAGE }],
						details: { ended: true },
					};
				}
				const history = toolHistory(ctx.sessionManager.getBranch());
				if (!isReconfirmed(history, toolCallId)) {
					return {
						content: [{ type: "text", text: REFLECTION_TEXT }],
						details: { ended: false },
					};
				}
				// Confirmed invocation: attempt to append the explicit lock record.
				const sessionId = ctx.sessionManager.getSessionId();
				const beforeIds = new Set(ctx.sessionManager.getEntries().map((e) => e.id));
				let threw = false;
				try {
					pi.appendEntry(CUSTOM_TYPE, { version: LOCK_VERSION, sessionId, locked: true });
				} catch {
					threw = true;
				}
				if (!threw && locked(ctx, st)) {
					st.durable = ctx.sessionManager.getSessionFile() !== undefined;
					ctx.ui.notify(st.durable ? ENDED_NOTICE : ENDED_NOTICE_EPHEMERAL, "info");
					// Do NOT abort here: a synchronous abort inside execute() makes the
					// host replace this return value with an `Operation aborted` error
					// result. Return the real success result; the turn_start guard
					// cancels the next model request, which stops the run cleanly.
					return {
						content: [{ type: "text", text: SUCCESS_MESSAGE }],
						details: { ended: true },
					};
				}
				// Failure without an existing valid lock: record new lock-shaped
				// residue ids as unconfirmed so they cannot become locks in this
				// runtime or a reloaded one, report the error, stay unlocked.
				for (const e of ctx.sessionManager.getEntries()) {
					if (!beforeIds.has(e.id) && isLockShapedFor(e, sessionId)) st.unconfirmed.add(e.id);
				}
				ctx.ui.notify(PERSIST_FAILURE, "error");
				return {
					content: [{ type: "text", text: "Failed to persist the conversation lock; the conversation was not ended." }],
					details: { ended: false },
					isError: true,
				};
			},
		});
	}

	// Lock guards apply in every mode: a resumed locked session must not reach
	// the main model from any entry path. Only tool registration is TUI-only.
	pi.on("input", (_event, ctx) => {
		if (!locked(ctx, stateFor(ctx))) return { action: "continue" };
		ctx.ui.notify(BLOCKED_INPUT_NOTICE, "warning");
		return { action: "handled" };
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (!locked(ctx, stateFor(ctx))) return;
		ctx.abort();
	});

	// turn_start fires before EVERY provider request on every run path — first
	// prompt, multi-turn tool loops, retry/continue, follow-up and steering
	// drains, resumption. abort()ing here trips the abort-check between
	// turn_start and the provider stream, so a locked session cannot reach the
	// model through any main-session path (retry included).
	pi.on("turn_start", (_event, ctx) => {
		if (!locked(ctx, stateFor(ctx))) return;
		ctx.abort();
	});

	pi.on("tool_call", (event, ctx) => {
		if (!locked(ctx, stateFor(ctx))) return;
		if (event.toolName === TOOL_NAME) return;
		return { block: true, reason: "Session has been ended by the model.", terminate: true };
	});

	pi.on("session_before_compact", (_event, ctx) => {
		if (!locked(ctx, stateFor(ctx))) return;
		return { cancel: true };
	});

	pi.on("session_before_tree", (event, ctx) => {
		if (!locked(ctx, stateFor(ctx))) return;
		if (!event.preparation.userWantsSummary) return;
		return { cancel: true };
	});

	// cache_warming_decision exists on host >= 1.3.0-xz.357 (verified on the real
	// binary); SDK 0.85.1 typings lack it, so register through a typed-safe shim.
	const onCacheWarming = (pi.on as unknown as (
		event: string,
		handler: (event: unknown, ctx: ExtensionContext) => { action: "stop" } | undefined,
	) => void).bind(pi);
	onCacheWarming("cache_warming_decision", (_event: unknown, ctx: ExtensionContext) => {
		if (!locked(ctx, stateFor(ctx))) return;
		return { action: "stop" };
	});
}
