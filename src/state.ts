/**
 * Pure state helpers for the pi-end-conversation extension.
 *
 * Lock semantics: default UNLOCKED. A session is locked only by a
 * `pi-end-conversation` custom entry in the session data whose format is
 * supported (version 1), whose sessionId matches the current session, and
 * whose `locked` value is exactly `true`. Missing records, `locked: false`,
 * unknown versions, malformed data, and foreign-session records never create a
 * lock, and never remove an independently valid one. Entries the host did not
 * durably accept must not be passed here as confirmed lock evidence.
 *
 * Reconfirmation: faithful port of the native predicate over the messages
 * preceding the current assistant message. Iterate newest → oldest:
 * - assistant containing an EndConversation tool call → CONFIRMED
 * - user message consisting entirely of tool results (Pi role "toolResult"):
 *   if an assistant message was already seen → NOT confirmed, else skip
 * - any other user message → NOT confirmed
 * - other message types are skipped
 * End of history → NOT confirmed.
 */

export const CUSTOM_TYPE = "pi-end-conversation";
export const LOCK_VERSION = 1;
export const SUCCESS_MESSAGE = "AI has ended this chat.";
export const TOOL_NAME = "EndConversation";

export interface LockRecord {
	version: number;
	sessionId: string;
	locked: boolean;
}

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** True when `entry` is a normally accepted lock record for `sessionId`. */
export function isValidLockEntry(entry: EntryLike, sessionId: string): boolean {
	if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) return false;
	const data = entry.data as LockRecord | undefined;
	if (!data || typeof data !== "object") return false;
	return data.version === LOCK_VERSION && data.sessionId === sessionId && data.locked === true;
}

/** Derive the lock flag for `sessionId` from all session entries. */
export function deriveLocked(entries: readonly EntryLike[], sessionId: string): boolean {
	return entries.some((e) => isValidLockEntry(e, sessionId));
}

export interface HistoryMessage {
	role: string;
	content?: unknown;
	toolCallId?: string;
}

interface ContentBlockLike {
	type?: string;
	name?: string;
	id?: string;
}

function messageHasEndCall(msg: HistoryMessage): boolean {
	if (!Array.isArray(msg.content)) return false;
	return (msg.content as ContentBlockLike[]).some((b) => b?.type === "toolCall" && b.name === TOOL_NAME);
}

function messageContainsCall(msg: HistoryMessage, toolCallId: string): boolean {
	if (!Array.isArray(msg.content)) return false;
	return (msg.content as ContentBlockLike[]).some((b) => b?.type === "toolCall" && b.id === toolCallId);
}

function isToolResultOnly(msg: HistoryMessage): boolean {
	if (msg.role === "toolResult") return true;
	if (msg.role !== "user") return false;
	// Claude transcript shape: user message whose content blocks are all tool_result.
	if (!Array.isArray(msg.content) || msg.content.length === 0) return false;
	return (msg.content as ContentBlockLike[]).every((b) => b?.type === "tool_result");
}

/**
 * Whether a new EndConversation call may end immediately. `messages` excludes
 * the assistant message carrying the current call; `excludeToolCallId` guards
 * against the current call appearing in history snapshots.
 */
export function isReconfirmed(messages: readonly HistoryMessage[], excludeToolCallId?: string): boolean {
	let seenAssistant = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			// The current assistant message is excluded entirely (native `e` holds
			// only messages before it), so sibling EndConversation calls in the same
			// response cannot self-confirm either.
			if (excludeToolCallId && messageContainsCall(msg, excludeToolCallId)) continue;
			seenAssistant = true;
			if (messageHasEndCall(msg)) return true;
			continue;
		}
		if (isToolResultOnly(msg)) {
			if (seenAssistant) return false;
			continue;
		}
		if (msg.role === "user") return false;
	}
	return false;
}
