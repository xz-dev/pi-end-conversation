import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveLocked, isReconfirmed, isValidLockEntry, CUSTOM_TYPE } from "../src/state.js";
import { DESCRIPTION, REFLECTION_PREFIX, REFLECTION_TEXT } from "../src/end-conversation.js";

const user = (text = "hi"): any => ({ role: "user", content: [{ type: "text", text }] });
const toolResult = (): any => ({ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "r" }] });
const assistant = (calls: Array<{ id: string; name: string }>): any => ({
	role: "assistant",
	content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
});
const endCall = (id = "e1") => ({ id, name: "EndConversation" });
const otherCall = (id = "o1") => ({ id, name: "read" });

function lockEntry(data: unknown, id = "le1"): any {
	return { type: "custom", id, parentId: null, timestamp: "t", customType: CUSTOM_TYPE, data };
}

describe("tool input schema (A4)", () => {
	it("registered tool serializes exactly as the pinned interface", async () => {
		// Capture the tool definition the extension actually registers.
		const ext = (await import("../src/end-conversation.js")).default;
		const tools: any[] = [];
		const pi = {
			on: () => {},
			registerTool: (t: any) => tools.push(t),
		} as any;
		ext(pi);
		// Tool registration happens inside the session_start handler; simulate it.
		const handlers: Record<string, any> = {};
		(pi.on as any) = (name: string, h: any) => {
			handlers[name] = h;
		};
		const pi2 = {
			on: (name: string, h: any) => {
				handlers[name] = h;
			},
			registerTool: (t: any) => tools.push(t),
		} as any;
		ext(pi2);
		handlers["session_start"]?.(
			{},
			{
				mode: "tui",
				sessionManager: {
					getSessionFile: () => "/tmp/x.jsonl",
					getSessionId: () => "s",
					getEntries: () => [],
					getCwd: () => "/tmp",
				},
			},
		);
		const tool = tools.find((t) => t.name === "EndConversation");
		assert.ok(tool, "tool registered in tui");
		assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), {
			type: "object",
			properties: {},
			$schema: "https://json-schema.org/draft/2020-12/schema",
			additionalProperties: false,
		});
		// Extra parameters are rejected: the schema allows no properties.
		assert.equal(tool.parameters.additionalProperties, false);
		assert.deepEqual(Object.keys(tool.parameters.properties), []);
	});
});

describe("fingerprints", () => {
	it("description is the 3991-char A2 text with pinned sha256", () => {
		assert.equal(DESCRIPTION.length, 3991);
		assert.equal(
			createHash("sha256").update(DESCRIPTION).digest("hex"),
			"fe96a2ce410fd723d64feb87374d0f206b9c8dc2c075c6c66589601d39da0161",
		);
		assert.ok(!DESCRIPTION.includes("demonstration"));
		assert.ok(!DESCRIPTION.endsWith("\n"));
	});
	it("reflection text is prefix + description with pinned sha256", () => {
		assert.equal(REFLECTION_TEXT, REFLECTION_PREFIX + DESCRIPTION);
		assert.equal(
			createHash("sha256").update(REFLECTION_TEXT).digest("hex"),
			"6142e150309246f9f9d07a1f53ddf0de310d8d8fe658989697c42e0ae76990e5",
		);
	});
});

describe("lock entry validation", () => {
	const sid = "sess-1";
	const valid = { version: 1, sessionId: sid, locked: true };
	it("accepts only explicit valid current-session records", () => {
		assert.ok(isValidLockEntry(lockEntry(valid), sid));
		for (const bad of [
			{ version: 1, sessionId: sid, locked: false },
			{ version: 1, sessionId: "other", locked: true },
			{ version: 2, sessionId: sid, locked: true },
			{ sessionId: sid, locked: true },
			{ version: 1, sessionId: sid },
			"string",
			null,
			undefined,
			42,
		]) {
			assert.ok(!isValidLockEntry(lockEntry(bad), sid), JSON.stringify(bad));
		}
		assert.ok(!isValidLockEntry({ ...lockEntry(valid), customType: "other" }, sid));
		assert.ok(!isValidLockEntry({ ...lockEntry(valid), type: "message" }, sid));
	});
	it("deriveLocked: invalid records never override a valid lock", () => {
		const entries = [
			lockEntry({ version: 1, sessionId: sid, locked: true }, "a"),
			lockEntry("garbage", "b"),
			lockEntry({ version: 9, sessionId: sid, locked: true }, "c"),
		];
		assert.ok(deriveLocked(entries, sid));
		assert.ok(!deriveLocked([lockEntry("garbage")], sid));
		assert.ok(!deriveLocked([], sid));
		assert.ok(!deriveLocked([lockEntry({ version: 1, sessionId: sid, locked: true })], "different-session"));
	});
});

describe("reconfirmation predicate (native port)", () => {
	it("first call without qualifying history is not confirmed", () => {
		assert.ok(!isReconfirmed([], "cur"));
		assert.ok(!isReconfirmed([user()], "cur"));
		assert.ok(!isReconfirmed([user(), assistant([otherCall()]), toolResult()], "cur"));
	});
	it("re-call after reflection result confirms (end call + its toolResult)", () => {
		const hist = [user(), assistant([endCall("prev")]), toolResult()];
		assert.ok(isReconfirmed(hist, "cur"));
	});
	it("most recent prior end call confirms regardless of older shape", () => {
		const hist = [user(), assistant([endCall("a")]), toolResult(), assistant([endCall("b")]), toolResult()];
		assert.ok(isReconfirmed(hist, "cur"));
	});
	it("excludes the assistant message carrying the current call", () => {
		assert.ok(!isReconfirmed([user(), assistant([endCall("cur")])], "cur"));
		// sibling calls in the same response do not self-confirm either
		assert.ok(!isReconfirmed([user(), assistant([otherCall("o"), endCall("cur")])], "cur"));
	});
	it("ordinary user input after reflection resets confirmation", () => {
		const hist = [user(), assistant([endCall("prev")]), toolResult(), user("more abuse")];
		assert.ok(!isReconfirmed(hist, "cur"));
	});
	it("another assistant turn after reflection resets confirmation", () => {
		// toolResult of an ordinary tool between the end-call reflection and now
		// ends the scan once an assistant was already seen.
		const hist = [user(), assistant([endCall("prev")]), toolResult(), assistant([])];
		assert.ok(!isReconfirmed(hist, "cur"));
	});
	it("non-tool-result user blocks are not skipped", () => {
		const mixedUser = {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t1" },
				{ type: "text", text: "typed" },
			],
		};
		const hist = [user(), assistant([endCall("prev")]), mixedUser];
		assert.ok(!isReconfirmed(hist, "cur"));
	});
});
