export const pocketApi = 1;

// getRandomValues also works on plain-HTTP LAN pages, where randomUUID is absent.
export function newTaskKey(random = globalThis.crypto) {
    const bytes = random.getRandomValues(new Uint8Array(16));

    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The status item for a session: the identity's name, which opens the Team page; null when it has none. */
export const identityStatus = (session) => {
    const name = session?.identity?.name;

    return name
        ? {
              id: "identity",
              text: name,
              title: `Team identity: ${name}. Tap to change it.`,
              page: "team",
          }
        : null;
};

/** Lessons waiting for the owner: new ones, and proposed changes of ones in force. */
export const waitingCount = (lessons = []) =>
    lessons.filter((lesson) => lesson.pending || lesson.proposal).length;

/** What the owner saw, for an approval to hold only for it. */
export function expectedOf(lesson) {
    if (!lesson.pending && lesson.proposal?.forget) {
        return { forget: true };
    }

    return {
        text:
            !lesson.pending && lesson.proposal?.text !== undefined
                ? lesson.proposal.text
                : lesson.text,
    };
}

/** What the rail calls the supervisor before the first answer: Brian's supervisor. The route's answer replaces it. */
export const SUPERVISOR_NAME = "Odrade";

/**
 * The supervisor's rail icon: a chess queen, the piece that moves the whole board, with 3 short rays of light above her
 * crown. One stroked path in a 24 × 24 box, as the app's own icons; it takes the theme's color.
 */
export const SUPERVISOR_ICON =
    "M7 18.5C8.5 16 9 13.5 9 11L6 7l3.5 2.5L12 6.5l2.5 3L18 7 15 11c0 2.5.5 5 2 7.5zM5 21h14M12 1.5v2M9 2.5l.8 1.3M15 2.5l-.8 1.3";

/** The rail button's title and badge for the route's answer; the badge is the open asks for Brian, none at 0. */
export const supervisorRail = (door) => {
    const name = door?.found ? door.name || SUPERVISOR_NAME : SUPERVISOR_NAME;

    return { title: name, badge: door?.found && door.asks > 0 ? door.asks : null };
};

/** What a tap does with the route's answer: open the session, or only say why not. */
export const supervisorAction = (door) => {
    if (door?.found) {
        return {
            open: door.conversationId,
            ...(door.archived
                ? { notice: ["warning", `${door.name}'s session "${door.title}" is archived.`] }
                : {}),
        };
    }

    return {
        notice: [
            "info",
            door?.text ?? "No supervisor session is bound to the desk. Nothing was opened.",
        ],
    };
};

const MEMORY_LABELS = {
    add: "save agent lesson",
    update: "change agent lesson",
    remove: "forget agent lesson",
    list: "list agent lessons",
};

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    pocket.style("team.css");

    function Lessons({ agent, lessons, limits, onChanged }) {
        const [draft, setDraft] = useState("");
        const [editing, setEditing] = useState(null);
        const [edit, setEdit] = useState("");
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const inForce = lessons.filter((lesson) => !lesson.pending).length;

        const act = async (path, body) => {
            setBusy(true);
            setError("");

            try {
                await pocket.api(path, body);
                await onChanged();

                return true;
            } catch (e) {
                setError(e.message);
                await onChanged();

                return false;
            } finally {
                setBusy(false);
            }
        };

        const change = (lesson, body) => act(`memory/${agent.id}/${lesson.id}`, body);
        const origin = (lesson) =>
            lesson.from
                ? html` from <button class="named-team-link" onClick=${() => pocket.openConversation(lesson.from)}>its session</button>`
                : null;

        return html`<section class="named-team-memory">
            <h3>Lessons for ${agent.name}</h3>
            <p class="small muted">
                ${inForce} of ${limits?.approved ?? 40} in force. They apply in every session with this identity, in any folder. Pi's lessons and changes wait for you here.
            </p>
            ${error && html`<div class="error-box" role="alert">${error}</div>`}
            ${lessons.length === 0 && html`<p class="small muted">No lessons yet.</p>`}
            <ul class="named-team-lessons">
                ${lessons.map((lesson) => {
                    const proposal = !lesson.pending && lesson.proposal;
                    const who = lesson.byPi ? "Pi" : lesson.byYou ? "you" : "someone";

                    if (editing === lesson.id) {
                        return html`<li class="named-team-lesson">
                            <textarea
                                rows="3"
                                maxlength=${limits?.text ?? 300}
                                value=${edit}
                                disabled=${busy}
                                aria-label="Lesson text"
                                onInput=${(e) => setEdit(e.currentTarget.value)}
                            />
                            <div class="named-team-actions">
                                <button
                                    class="button primary"
                                    disabled=${busy || !edit.trim()}
                                    onClick=${async () => {
                                        if (await change(lesson, { action: "edit", text: edit })) {
                                            setEditing(null);
                                        }
                                    }}
                                >
                                    Save
                                </button>
                                <button class="button" disabled=${busy} onClick=${() => setEditing(null)}>Cancel</button>
                            </div>
                        </li>`;
                    }

                    return html`<li class=${`named-team-lesson ${lesson.pending || proposal ? "waiting" : ""}`}>
                        ${lesson.pending && html`<span class="named-team-tag">Waiting</span>`}
                        <span class=${proposal ? "named-team-old" : ""}>${lesson.text}</span>
                        ${
                            proposal &&
                            html`<span class="named-team-proposal"
                                ><span class="named-team-tag">Proposed</span>
                                ${proposal.forget ? "Forget this lesson" : proposal.text}</span
                            >`
                        }
                        <span class="small muted"
                            >${lesson.pending ? "Proposed" : "Saved"} by ${who}${origin(lesson)}${proposal ? ` · change proposed by ${proposal.byPi ? "Pi" : "someone"}` : ""} · ${lesson.id}</span
                        >
                        <div class="named-team-actions">
                            ${
                                lesson.pending || proposal
                                    ? html`<button
                                              class="button primary"
                                              disabled=${busy}
                                              onClick=${() => change(lesson, { action: "approve", expected: expectedOf(lesson) })}
                                          >
                                              ${proposal?.forget ? "Approve forgetting" : proposal ? "Approve change" : "Approve"}
                                          </button>
                                          <button class="button" disabled=${busy} onClick=${() => change(lesson, { action: "discard" })}>
                                              ${proposal ? "Keep as is" : "Discard"}
                                          </button>`
                                    : null
                            }
                            <button
                                class="button"
                                disabled=${busy}
                                onClick=${() => {
                                    setEditing(lesson.id);
                                    setEdit(lesson.text);
                                }}
                            >
                                Edit
                            </button>
                            ${
                                !lesson.pending &&
                                html`<button class="button" disabled=${busy} onClick=${() => change(lesson, { action: "forget" })}>
                                    Forget
                                </button>`
                            }
                        </div>
                    </li>`;
                })}
            </ul>
            <label class="named-team-task"
                >Add a lesson for ${agent.name} (counts at once)
                <textarea
                    rows="2"
                    maxlength=${limits?.text ?? 300}
                    value=${draft}
                    disabled=${busy}
                    placeholder="One or two specific sentences…"
                    onInput=${(e) => setDraft(e.currentTarget.value)}
                />
            </label>
            <button
                class="button"
                disabled=${busy || !draft.trim()}
                onClick=${async () => {
                    if (await act(`memory/${agent.id}`, { text: draft })) {
                        setDraft("");
                    }
                }}
            >
                Add lesson
            </button>
        </section>`;
    }

    function Team() {
        const source = pocket.conversationId();
        const [agents, setAgents] = useState([]);
        const [session, setSession] = useState(null);
        const [selected, setSelected] = useState("");
        const [repository, setRepository] = useState("");
        const [task, setTask] = useState("");
        const [preferred, setPreferred] = useState(false);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const [notice, setNotice] = useState("");
        const [requestKey, setRequestKey] = useState(null);
        const [memory, setMemory] = useState(null);

        const loadMemory = () => pocket.api("memory").then(setMemory, (e) => setError(e.message));

        useEffect(() => {
            void loadMemory();

            return pocket.on("memory", () => void loadMemory());
        }, []);

        const refresh = async () => {
            const result = await pocket.api("agents");

            setAgents(result.agents);

            if (source) {
                setSession(await pocket.api(`session/${source}`));
            }
        };

        useEffect(() => {
            const abort = new AbortController();

            Promise.all([
                pocket.api("agents", undefined, { signal: abort.signal }),
                source
                    ? pocket.api(`session/${source}`, undefined, { signal: abort.signal })
                    : null,
            ])
                .then(([catalog, current]) => {
                    setAgents(catalog.agents);
                    setSession(current);
                    setSelected(current?.identity?.id ?? catalog.agents[0]?.id ?? "");
                })
                .catch((e) => {
                    if (!abort.signal.aborted) {
                        setError(e.message);
                    }
                });

            return () => abort.abort();
        }, [source]);
        const agent = agents.find((a) => a.id === selected);
        const repositories = Object.entries(agent?.repositories ?? {});
        // The home is 1 more place a task can start in: studies, triage and plans across the agent's repositories.
        const choices = [...repositories.map(([name]) => name), ...(agent?.home ? ["home"] : [])];
        const chosenRepository = choices.includes(repository) ? repository : (choices[0] ?? "");
        const taskCwd =
            chosenRepository === "home"
                ? agent?.home
                : (agent?.repositories?.[chosenRepository] ??
                  agent?.workspace ??
                  session?.conversation.cwd);

        const perform = async (action) => {
            setBusy(true);
            setError("");
            setNotice("");

            try {
                await action();
            } catch (e) {
                setError(e.message);
            } finally {
                setBusy(false);
            }
        };

        const choose = () =>
            perform(async () => {
                await pocket.api(`session/${source}/identity`, { agent: selected });
                await refresh();
                setNotice(
                    `This session is now ${agent.name}. Choose its model with Pi Pocket's model picker.`,
                );
            });
        const start = () =>
            perform(async () => {
                const key = requestKey ?? newTaskKey();

                setRequestKey(key);
                const result = await pocket.api(`session/${source}/start`, {
                    agent: selected,
                    message: task,
                    key,
                    usePreferredModel: preferred,
                    ...(chosenRepository ? { repository: chosenRepository } : {}),
                });

                setRequestKey(null);
                pocket.openConversation(result.session);
            });

        return html`<div class="named-team">
            <p class="muted">Your people, in ordinary Pi Pocket sessions.</p>
            ${error && html`<div class="error-box" role="alert">${error}</div>`}
            ${notice && html`<p role="status">${notice}</p>`}
            ${!source && html`<p>Create or open a session in the folder you want to work in, then choose an agent here.</p>`}
            ${
                session &&
                html`<div class="named-team-context">
                    <strong>${session.identity?.name ?? "No named agent selected"}</strong>
                    <span class="mono small">${session.conversation.cwd}</span>
                    <span class="small muted"
                        >${
                            session.conversation.model
                                ? `${session.conversation.model.provider}/${session.conversation.model.modelId}`
                                : "Choose a model in the session header"
                        }</span
                    >
                </div>`
            }
            <div class="named-team-roster">
                ${agents.map(
                    (a) =>
                        html`<button
                            type="button"
                            class=${`named-team-agent ${selected === a.id ? "selected" : ""}`}
                            disabled=${busy}
                            aria-pressed=${selected === a.id}
                            onClick=${() => {
                                setSelected(a.id);
                                setRepository("");
                                setRequestKey(null);
                            }}
                        >
                            <strong>${a.name}</strong><span class="small muted">${a.role}</span>
                            ${
                                a.home &&
                                html`<span class="small muted"
                                    >Home: <span class="mono">${a.home}</span></span
                                >`
                            }
                            ${
                                waitingCount(memory?.agents?.[a.id]) > 0 &&
                                html`<span class="named-team-count" title="Lessons waiting for you"
                                    >${waitingCount(memory.agents[a.id])} waiting</span
                                >`
                            }
                        </button>`,
                )}
            </div>
            ${agents.length === 0 && html`<p>No agent files found. Import your team using this extension's installer.</p>`}
            ${
                agents.some((a) => a.home) &&
                html`<p class="small muted">
                    Star a home folder in New session to get a launcher entry.
                </p>`
            }
            ${
                agent &&
                html`<section class="named-team-details">
                    <p class="small muted">
                        Preferred model: <span class="mono">${agent.model || "session choice"}</span>
                    </p>
                    <div class="named-team-actions">
                        <button
                            class="button primary"
                            disabled=${busy || !source}
                            onClick=${choose}
                        >
                            Use ${agent.name} in this session
                        </button>
                        ${
                            session?.identity &&
                            html`<button
                                class="button"
                                disabled=${busy}
                                onClick=${() =>
                                    perform(async () => {
                                        await pocket.api(`session/${source}/identity`, {
                                            agent: null,
                                        });
                                        await refresh();
                                        setNotice(
                                            "Named identity cleared. Conversation history is unchanged.",
                                        );
                                    })}
                            >
                                Clear identity
                            </button>`
                        }
                    </div>
                    <p class="small muted">
                        Identity selection keeps the session's model, folder, and history. Use a new session for a fresh task.
                    </p>
                    <details>
                        <summary>Soul and responsibilities</summary>
                        <${pocket.Markdown} text=${agent.instructions} />
                    </details>

                    ${
                        choices.length > 0 &&
                        html`
                        <label class="named-team-task">Repository for the new task
                            <select value=${chosenRepository} disabled=${busy}
                                onChange=${(e) => {
                                    setRepository(e.currentTarget.value);
                                    setRequestKey(null);
                                }}>
                                ${choices.map((name) => html`<option value=${name}>${name === "home" ? `home: ${agent.home}` : name}</option>`)}
                            </select>
                        </label>
                    `
                    }
                    <p class="small muted">Task folder: <span class="mono">${taskCwd ?? "Choose a source session"}</span></p>
                    <label class="named-team-task"
                        >Start a separate task for ${agent.name}
                        <textarea
                            rows="4"
                            maxlength="6000"
                            value=${task}
                            disabled=${busy}
                            placeholder="Describe the work for this agent…"
                            onInput=${(e) => {
                                setTask(e.currentTarget.value);
                                setRequestKey(null);
                            }}
                        />
                    </label>
                    <label class="named-team-option"
                        ><input
                            type="checkbox"
                            checked=${preferred}
                            disabled=${busy || !agent.model}
                            onChange=${(e) => {
                                setPreferred(e.currentTarget.checked);
                                setRequestKey(null);
                            }}
                        />
                        Use the preferred model (must be allowed in Providers → Models for subagents)
                    </label>
                    <button
                        class="button"
                        disabled=${busy || !source || !task.trim()}
                        onClick=${start}
                    >
                        ${busy ? "Working…" : "Start linked task"}
                    </button>
                    <p class="small muted">
                        The task opens in the folder shown above with ${preferred ? "the preferred model" : "this session's model"}, plus the agent's identity and your brief. Start linked tasks from the original conversation; a linked task cannot start another.
                    </p>
                    ${
                        memory &&
                        html`<${Lessons}
                            agent=${agent}
                            lessons=${memory.agents?.[agent.id] ?? []}
                            limits=${memory.limits}
                            onChanged=${loadMemory}
                        />`
                    }
                </section>`
            }
            ${
                session?.linked?.length > 0 &&
                html`<section>
                    <h3>Linked conversations</h3>
                    ${session.linked.map(
                        (s) =>
                            html`<button
                                class="button"
                                onClick=${() => pocket.openConversation(s.conversationId)}
                            >
                                ${s.title ?? "Linked session"} · ${s.busy ? "working" : "idle"}
                            </button>`,
                    )}
                </section>`
            }
        </div>`;
    }

    pocket.page({ id: "team", title: "Your team", component: Team });
    const rail = pocket.rail({ id: "team", title: "Your team", icon: "chat", page: "team" });
    // The rail shows how many lessons wait for the owner, across every agent.
    const badge = () =>
        pocket.api("memory").then(
            (memory) => rail.update({ badge: memory.pending || null }),
            () => {},
        );

    void badge();
    pocket.onDispose(pocket.on("memory", () => void badge()));

    // The supervisor's front door: 1 tap opens the session the desk binds threads to, from the rail, the phone's home
    // screen, or the launcher. The route reads only; a tap with no bound session only says so.
    const supervisorButton = pocket.rail({
        id: "supervisor",
        title: SUPERVISOR_NAME,
        iconPath: SUPERVISOR_ICON,
        run: () => void openSupervisor(),
    });
    const supervisorLauncher = pocket.launcher({
        id: "supervisor",
        label: `Open ${SUPERVISOR_NAME}'s session`,
        detail: "The supervisor session the desk reports to",
        iconPath: SUPERVISOR_ICON,
        keywords: ["supervisor", "desk", "odrade"],
        run: () => void openSupervisor(),
    });
    let lastName = SUPERVISOR_NAME;

    const showSupervisor = (door) => {
        const spec = supervisorRail(door);

        supervisorButton.update(spec);

        if (spec.title !== lastName) {
            lastName = spec.title;
            supervisorLauncher.update({ label: `Open ${spec.title}'s session` });
        }
    };

    const loadSupervisor = () =>
        pocket.api("supervisor").then(
            (door) => {
                showSupervisor(door);

                return door;
            },
            () => null,
        );

    // A tap asks again, so it opens the session bound now, not the one of the last poll.
    const openSupervisor = async () => {
        const door = await loadSupervisor();

        if (door === null) {
            pocket.notify("error", "Could not find the supervisor session. Nothing was opened.");

            return;
        }

        const action = supervisorAction(door);

        if (action.notice) {
            pocket.notify(action.notice[0], action.notice[1]);
        }

        if (action.open !== undefined) {
            pocket.openConversation(action.open);
        }
    };

    void loadSupervisor();
    // The desk sends its events to its own module, so the badge polls: once a minute, and when the tab shows again.
    const supervisorTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
            void loadSupervisor();
        }
    }, 60_000);

    const onVisible = () => {
        if (document.visibilityState === "visible") {
            void loadSupervisor();
        }
    };

    document.addEventListener("visibilitychange", onVisible);
    pocket.onDispose(() => {
        clearInterval(supervisorTimer);
        document.removeEventListener("visibilitychange", onVisible);
    });

    // The shown session's identity in the status line (new in 0.19.0: an older app has none). Pocket sends no event when
    // the tab changes session, so a timer watches the id; the server's "identity" event says when the choice changes.
    if (typeof pocket.status === "function") {
        let shown = null;
        let item = null;
        // An identity the folder gave is pinned once per session: a later move of the session keeps it.
        const pinned = new Set();

        const show = (spec) => {
            if (!spec) {
                item?.remove();
                item = null;
            } else if (item) {
                item.update(spec);
            } else {
                item = pocket.status(spec);
            }
        };

        const load = async () => {
            const id = shown;
            let spec = null;

            if (id !== null) {
                try {
                    const seen = await pocket.api(`session/${id}`);

                    if (seen?.implicit && seen.identity && !pinned.has(Number(id))) {
                        try {
                            // The server pins it only when its folder still says so: a choice or a clear wins, and
                            // a folder that moved pins nothing.
                            await pocket.api(`session/${id}/pin`, { agent: seen.identity.id });
                            pinned.add(Number(id));
                        } catch {
                            // An owner-only route refused it: the folder keeps giving the identity.
                        }
                    }

                    spec = identityStatus(seen);
                } catch {
                    spec = null;
                }
            }

            // A reply for a session that is no longer shown must not win.
            if (shown === id) {
                show(spec);
            }
        };

        const watch = () => {
            const id = pocket.conversationId() ?? null;

            if (id !== shown) {
                shown = id;
                void load();
            }
        };

        watch();
        const timer = setInterval(watch, 1500);
        const stop = pocket.on("identity", ({ conversationId }) => {
            if (shown !== null && Number(conversationId) === Number(shown)) {
                void load();
            }
        });

        pocket.onDispose(() => {
            clearInterval(timer);
            stop();
            item?.remove();
            item = null;
        });
    }

    pocket.toolCall({
        tool: "team_memory",
        icon: "key",
        label: (args) => MEMORY_LABELS[args.action] ?? "agent lessons",
        subject: (args) =>
            [args.agent, args.id && `[${args.id}]`, args.text].filter(Boolean).join(" "),
        summary: (args) =>
            args.action === "list"
                ? { verb: "checked agent lessons" }
                : { verb: "proposed", noun: "agent lesson" },
    });
    pocket.launcher({
        id: "team",
        label: "Your named agents",
        detail: "Odrade and the team",
        icon: "chat",
        page: "team",
    });
}
