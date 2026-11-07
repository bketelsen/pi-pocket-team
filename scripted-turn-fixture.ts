// The user messages of a scripted model's turn. Since Pi Pocket 0.28.0, each linked session's run ends with a message
// to the session that started it (a run-end answer), and queued messages go into 1 turn together. So a test's own
// message can share a turn with a run-end answer, and a script that reads only the newest message misses it.

/** A run-end answer from Pi Pocket: a linked session finished, failed or was stopped. */
export const RUN_END =
    /^(\[from: [^\]]+\] )?(\[via linked session [^\]]+\] )?Linked session \S+ (finished its run\.|failed: its run gave up|was stopped before it answered)/;

type Request = { messages: readonly { role: string; content: unknown }[] };

/** A message's text: its string content, or its text parts joined, as Pi Pocket's `lastText` reads it. */
function textOf(content: unknown): string {
    const parts =
        typeof content === "string"
            ? [{ type: "text", text: content }]
            : (content as { type: string; text?: string }[]);

    return parts.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

/**
 * The texts of the turn's user messages, newest first: the trailing run of user messages (system messages are skipped,
 * any other role ends it), without run-end answers.
 */
export function turnTexts(request: Request): string[] {
    const texts: string[] = [];

    for (const message of [...request.messages].reverse()) {
        if (message.role === "system") {
            continue;
        }

        if (message.role !== "user") {
            break;
        }

        texts.push(textOf(message.content));
    }

    return texts.filter((text) => !RUN_END.test(text));
}
