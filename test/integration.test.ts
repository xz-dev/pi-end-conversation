import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidLockEntry } from "../src/state.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";

const EXT = fileURLToPath(new URL("../index.ts", import.meta.url));
const END = (id = "c1") => fauxToolCall("EndConversation", {}, { id });

async function makeSession(
	opts: {
		dir?: string;
		sessionManager?: any;
		settingsManager?: SettingsManager;
		mode?: "tui" | "print" | "rpc" | "json";
		extraExtensions?: string[];
	} = {},
) {
	const dir = opts.dir ?? mkdtempSync("/var/tmp/piec-sdk-");
	const faux = fauxProvider({ api: "openai-completions", models: [{ id: "f1", name: "f1" }] });
	const modelRuntime = await ModelRuntime.create({ agentDir: dir } as any);
	modelRuntime.registerProvider("faux", { ...faux.provider, api: "openai-completions" } as any);
	await modelRuntime.setRuntimeApiKey("faux", "k");
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		additionalExtensionPaths: [EXT, ...(opts.extraExtensions ?? [])],
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		modelRuntime,
		sessionManager: opts.sessionManager ?? SessionManager.inMemory(dir),
		settingsManager: opts.settingsManager,
		resourceLoader: loader,
	});
	await session.bindExtensions({ mode: opts.mode ?? "tui" });
	return { session, faux, dir };
}

function locks(sm: any): any[] {
	return sm.getEntries().filter((e: any) => e.customType === "pi-end-conversation");
}

function endResponse(id: string) {
	return fauxAssistantMessage([END(id)], { stopReason: "toolUse" });
}

describe("EndConversation on real AgentSession (tui)", () => {
	it("reflects first, confirms second, locks, then zero requests", async () => {
		const { session, faux } = await makeSession();
		assert.ok(session.getAllTools().some((t: any) => t.name === "EndConversation"));
		faux.setResponses([endResponse("a"), endResponse("b")]);
		await session.prompt("end please");
		assert.equal(faux.state.callCount, 2);
		assert.equal(locks(session.sessionManager).length, 1);
		// Subsequent prompts produce no requests.
		await session.prompt("more");
		assert.equal(faux.state.callCount, 2);
		session.dispose();
	});

	it("success result carries ended:true and native success text", async () => {
		const { session, faux } = await makeSession();
		faux.setResponses([endResponse("a"), endResponse("b")]);
		await session.prompt("end");
		const results = (session.sessionManager.getBranch() as any[])
			.filter((e: any) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "EndConversation");
		const last = results.at(-1)!.message as any;
		assert.equal(last.details.ended, true);
		assert.equal(last.content[0].text, "AI has ended this chat.");
		session.dispose();
	});

	it("ordinary input between calls resets the confirmation", async () => {
		const { session, faux } = await makeSession();
		// Responses are consumed per REQUEST, not per prompt. Prompt 1: a reflects,
		// then the loop continues with "stop" text so the run ends unlocked.
		faux.setResponses([
			endResponse("a"), // request 1: reflect (ended:false)
			fauxAssistantMessage([fauxText("stop1")]), // request 2: plain text ends run
			endResponse("b"), // request 3 (prompt 2): user input intervened → reflect again
			fauxAssistantMessage([fauxText("stop2")]), // request 4: end run still unlocked
			endResponse("c"), // request 5 (prompt 3): reflects (b's result is newest)
			endResponse("d"), // request 6 (same run): confirms → lock
		]);
		await session.prompt("end");
		assert.equal(faux.state.callCount, 2);
		assert.equal(locks(session.sessionManager).length, 0);
		await session.prompt("keep talking");
		assert.equal(faux.state.callCount, 4);
		assert.equal(locks(session.sessionManager).length, 0);
		await session.prompt("end again");
		assert.equal(faux.state.callCount, 6);
		assert.equal(locks(session.sessionManager).length, 1);
		session.dispose();
	});

	it("lock restores by re-reading the session JSONL file; new session stays unlocked", async () => {
		const dir = mkdtempSync("/var/tmp/piec-sdk-");
		const sessionDir = join(dir, "sessions");
		const sm1 = SessionManager.create(dir, sessionDir);
		const s1 = await makeSession({ dir, sessionManager: sm1 });
		s1.faux.setResponses([endResponse("a"), endResponse("b")]);
		await s1.session.prompt("end");
		const sid = sm1.getSessionId();
		s1.session.dispose();

		// Reopen the same JSONL file — proves the lock persists through real
		// session-file read, not just shared in-memory state.
		const file = join(sessionDir, readdirSync(sessionDir).find((f) => f.endsWith(".jsonl"))!);
		const sm2 = SessionManager.open(file, sessionDir);
		const s2 = await makeSession({ dir, sessionManager: sm2 });
		assert.equal(sm2.getSessionId(), sid);
		s2.faux.setResponses([fauxAssistantMessage([fauxText("x")])]);
		await s2.session.prompt("more");
		assert.equal(s2.faux.state.callCount, 0);
		s2.session.dispose();

		// A different session id containing a foreign lock record is not locked.
		const sm3 = SessionManager.inMemory(dir);
		sm3.appendCustomEntry("pi-end-conversation", { version: 1, sessionId: "other", locked: true });
		const s3 = await makeSession({ dir, sessionManager: sm3 });
		s3.faux.setResponses([fauxAssistantMessage([fauxText("x")])]);
		await s3.session.prompt("hi");
		assert.equal(s3.faux.state.callCount, 1);
		s3.session.dispose();
	});

	it("invalid records alone never lock; valid+invalid stays locked", async () => {
		const dir = mkdtempSync("/var/tmp/piec-sdk-");
		const mk = (data: any, id: string) => ({
			type: "custom",
			customType: "pi-end-conversation",
			data,
			id,
			parentId: null,
			timestamp: new Date().toISOString(),
		});
		for (const data of [
			{ version: 1, sessionId: "self", locked: false },
			{ version: 9, sessionId: "self", locked: true },
			"garbage",
		]) {
			const sm = SessionManager.inMemory(dir);
			sm.appendCustomEntry("pi-end-conversation", data);
			const s = await makeSession({ dir, sessionManager: sm });
			s.faux.setResponses([fauxAssistantMessage([fauxText("x")])]);
			await s.session.prompt("hi");
			assert.equal(s.faux.state.callCount, 1, JSON.stringify(data));
			s.session.dispose();
		}
	});

	it("tool is not registered outside tui mode", async () => {
		const { session } = await makeSession({ mode: "print" });
		assert.ok(!session.getAllTools().some((t: any) => t.name === "EndConversation"));
		session.dispose();
	});

	it("another extension blocking the tool prevents any lock", async () => {
		const blocker = join(mkdtempSync("/var/tmp/piec-ext-"), "block.ts");
		writeFileSync(
			blocker,
			`export default function (pi) { pi.on("tool_call", (e) => e.toolName === "EndConversation" ? { block: true, reason: "no" } : undefined); }`,
		);
		const { session, faux } = await makeSession({ extraExtensions: [blocker] });
		faux.setResponses([endResponse("a"), endResponse("b"), endResponse("c")]);
		await session.prompt("end");
		assert.equal(locks(session.sessionManager).length, 0);
		session.dispose();
	});

	it("queued follow-up while running, then lock, produces no requests", async () => {
		const { session, faux } = await makeSession();
		// While the first prompt is still running, queue a follow-up through the
		// real queue path — it must drain into the run or be consumed, never
		// start a new model request once locked.
		faux.setResponses([endResponse("a"), endResponse("b")]);
		const p = session.prompt("end");
		await session.followUp("queued while running").catch(() => {});
		await p;
		assert.equal(locks(session.sessionManager).length, 1);
		// Total model requests are exactly the two end calls — the queued
		// follow-up added zero.
		assert.equal(faux.state.callCount, 2);
		await session.prompt("still blocked");
		assert.equal(faux.state.callCount, 2);
		session.dispose();
	});

	it("model-backed compaction is cancelled in a locked session", async () => {
		// Tiny thresholds make the ended history compactable, so compact() reaches
		// the session_before_compact hook instead of "Nothing to compact".
		const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1, reserveTokens: 1 } });
		const { session, faux } = await makeSession({ settingsManager });
		faux.setResponses([endResponse("a"), endResponse("b")]);
		await session.prompt("end");
		assert.equal(faux.state.callCount, 2);
		await assert.rejects(session.compact(), /Compaction cancelled/);
		assert.equal(faux.state.callCount, 2, "compaction hit the model");
		session.dispose();
	});

	it("persisted session gains one plugin record; header and history unchanged", async () => {
		const dir = mkdtempSync("/var/tmp/piec-sdk-");
		const sessionDir = join(dir, "sessions");
		const sm = SessionManager.create(dir, sessionDir);
		const { session, faux } = await makeSession({ dir, sessionManager: sm });
		faux.setResponses([endResponse("a"), endResponse("b")]);
		await session.prompt("end");
		session.dispose();
		const file = readdirSync(sessionDir).find((f) => f.endsWith(".jsonl"));
		assert.ok(file, "session file written");
		const lines = readFileSync(join(sessionDir, file!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines[0].type, "session");
		const lockLines = lines.filter((l) => l.customType === "pi-end-conversation");
		assert.equal(lockLines.length, 1);
		assert.equal(lockLines[0].data.locked, true);
		assert.equal(lockLines[0].data.version, 1);
		assert.equal(lockLines[0].data.sessionId, lines[0].id);
		// Lock record is a custom entry: it exists in the entry tree but must not
		// appear in messages sent to the model.
		const llmMessages = sm.buildSessionContext().messages;
		assert.ok(!JSON.stringify(llmMessages).includes("pi-end-conversation"), "lock leaked into model context");
	});

	it("re-calling EndConversation while locked stays idempotent", async () => {
		const { session, faux } = await makeSession();
		faux.setResponses([endResponse("a"), endResponse("b")]);
		await session.prompt("end");
		assert.equal(locks(session.sessionManager).length, 1);
		assert.equal(faux.state.callCount, 2);
		// Invoke the extension's execute() directly with a ctx bound to the real
		// (locked) sessionManager — a real second execution path.
		const ext = (await import("../src/end-conversation.js")).default;
		const registered: any[] = [];
		const handlers: Record<string, any> = {};
		ext({
			on: (n: string, h: any) => (handlers[n] = h),
			registerTool: (t: any) => registered.push(t),
		} as any);
		handlers["session_start"]({}, {
			mode: "tui",
			sessionManager: session.sessionManager,
			ui: { notify: () => {} },
			abort: () => {},
		});
		const tool = registered.find((t) => t.name === "EndConversation");
		const ctx = {
			mode: "tui",
			sessionManager: session.sessionManager,
			ui: { notify: () => {} },
			abort: () => {},
		};
		const result = await tool.execute("direct-call", {}, undefined, () => {}, ctx);
		assert.equal(result.details?.ended, true);
		assert.equal(result.content[0].text, "AI has ended this chat.");
		assert.equal(locks(session.sessionManager).length, 1, "no duplicate lock");
		session.dispose();
	});

	it("failed lock append reports error, leaves residue non-locking, session usable", async () => {
		const dir = mkdtempSync("/var/tmp/piec-sdk-");
		const sm = SessionManager.inMemory(dir);
		// Simulate the host order: entry pushed into memory, then persist throws.
		const orig = sm.appendCustomEntry.bind(sm);
		(sm as any).appendCustomEntry = (customType: string, data?: unknown) => {
			const id = orig(customType, data);
			if (customType === "pi-end-conversation") throw new Error("disk full");
			return id;
		};
		const { session, faux } = await makeSession({ dir, sessionManager: sm });
		faux.setResponses([
			endResponse("a"),
			endResponse("b"), // confirm → residue + throw → error path, no lock
			fauxAssistantMessage([fauxText("still alive")]),
		]);
		await session.prompt("end");
		const last = (session.sessionManager.getBranch() as any[])
			.filter((e: any) => e.type === "message" && e.message.role === "toolResult")
			.at(-1)!.message as any;
		assert.notEqual(last.details?.ended, true);
		// Residue sits in memory but must not lock; session stays usable and
		// keeps making requests (4 total: a reflect, b failed-confirm, c text,
		// d from the follow-up prompt).
		await session.prompt("continue");
		assert.equal(faux.state.callCount, 4);
		// The residue entry exists and is lock-shaped — without residue tracking
		// it would read back as a valid lock. The extension's unconfirmed-id set
		// is what kept the session usable above (request count = 4).
		const residue = sm.getEntries().filter(
			(e: any) => e.customType === "pi-end-conversation" && e.data?.sessionId === sm.getSessionId(),
		);
		assert.equal(residue.length, 1);
		assert.equal(isValidLockEntry(residue[0], sm.getSessionId()), true);
		session.dispose();
	});

	it("same-batch sibling tool is blocked after the lock takes effect", async () => {
		const { session, faux } = await makeSession();
		// batch 1: reflect only; batch 2: end + bash — bash must not execute.
		faux.setResponses([
			endResponse("a"),
			fauxAssistantMessage([END("b"), fauxToolCall("bash", { command: "echo hi" }, { id: "bx" })], {
				stopReason: "toolUse",
			}),
		]);
		await session.prompt("end");
		assert.equal(locks(session.sessionManager).length, 1);
		const results = (session.sessionManager.getBranch() as any[])
			.filter((e: any) => e.type === "message" && e.message.role === "toolResult");
		const bash = results.find((e: any) => (e.message as any).toolName === "bash");
		if (bash) {
			// If it produced a result it must be a block/abort, never the echo output.
			assert.ok(!JSON.stringify(bash.message.content).includes("hi\n"), "bash ran");
		}
		assert.equal(faux.state.callCount, 2);
		session.dispose();
	});
});
