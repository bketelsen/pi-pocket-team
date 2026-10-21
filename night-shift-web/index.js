// Night shift's browser module: an item in the status line under the message box, while the session has a night
// shift (or had one in the last hours), and a sheet with its rounds. `night-shift.ts` serves the goal and says when it
// changes.

export const pocketApi = 1;

/** What the status line says: long, short, and its tone. */
export function statusItem(goal) {
    const rounds = `${goal.round}/${goal.maxRounds}`;

    switch (goal.status) {
        case "running":
            return {
                text: `Night shift ${rounds}${goal.deadlineLabel ? ` · until ${goal.deadlineLabel}` : ""}`,
                short: `Night ${rounds}`,
            };
        case "summary":
            return { text: "Night shift: summary", short: "Night: summary" };
        case "paused":
            return { text: `Night shift paused ${rounds}`, short: "Night: paused", tone: "warn" };
        default:
            return {
                text: `Night shift ${goal.reasonWord ?? "ended"} ${rounds}`,
                short: `Night: ${goal.reasonWord ?? "ended"}`,
                tone: goal.reason === "failed" ? "error" : "muted",
            };
    }
}

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    // The status line came in Pi Pocket 0.19.0.
    if (typeof pocket.status !== "function") {
        return;
    }

    let item = null;
    let shown = null;
    let asked = 0;

    function show(goal) {
        if (!goal) {
            item?.remove();
            item = null;

            return;
        }

        // Added again, not updated: the same id replaces it, and a tone that goes away goes with it.
        item = pocket.status({
            id: "goal",
            ...statusItem(goal),
            title: goal.standing,
            sheet: "goal",
        });
    }

    async function refresh() {
        const id = pocket.conversationId();
        const ask = ++asked;

        if (id === null) {
            show(null);

            return;
        }

        try {
            const { goal } = await pocket.api(`goal/${id}`);

            // A newer question, or another session by now: this answer is stale.
            if (ask === asked && pocket.conversationId() === id) {
                show(goal);
            }
        } catch {
            if (ask === asked) {
                show(null);
            }
        }
    }

    function Goal() {
        const [goal, setGoal] = useState(null);
        const [error, setError] = useState("");

        useEffect(() => {
            const id = pocket.conversationId();
            const load = () =>
                id === null
                    ? setError("Open a session first.")
                    : pocket.api(`goal/${id}`).then(
                          ({ goal: found }) => setGoal(found),
                          (failure) => setError(failure.message),
                      );

            void load();

            return pocket.on("changed", ({ conversation }) => conversation === id && void load());
        }, []);

        if (error) {
            return html`<div class="error-box">${error}</div>`;
        }

        if (!goal) {
            return html`<p class="muted">No night shift in this session.</p>`;
        }

        return html`<pre class="mono small" style="white-space: pre-wrap">${goal.card}</pre>`;
    }

    pocket.sheet({ id: "goal", title: "Night shift", component: Goal });

    const stop = pocket.on("changed", ({ conversation }) => {
        if (conversation === pocket.conversationId()) {
            void refresh();
        }
    });
    // No event says that the tab opened another session: look each second, and ask only when it changed. Ask again
    // each minute too, for the time left.
    const look = setInterval(() => {
        const id = pocket.conversationId();

        if (id !== shown) {
            shown = id;
            void refresh();
        }
    }, 1000);
    const minute = setInterval(() => void refresh(), 60_000);

    return () => {
        stop();
        clearInterval(look);
        clearInterval(minute);
        item?.remove();
    };
}
