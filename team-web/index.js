export const pocketApi = 1;

// getRandomValues also works on plain-HTTP LAN pages, where randomUUID is absent.
export function newTaskKey(random = globalThis.crypto) {
    const bytes = random.getRandomValues(new Uint8Array(16));

    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    pocket.style("team.css");

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
        const chosenRepository = Object.hasOwn(agent?.repositories ?? {}, repository)
            ? repository
            : (repositories[0]?.[0] ?? "");
        const taskCwd =
            agent?.repositories?.[chosenRepository] ??
            agent?.workspace ??
            session?.conversation.cwd;

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
                        </button>`,
                )}
            </div>
            ${agents.length === 0 && html`<p>No agent files found. Import your team using this extension's installer.</p>`}
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
                        repositories.length > 0 &&
                        html`
                        <label class="named-team-task">Repository for the new task
                            <select value=${chosenRepository} disabled=${busy}
                                onChange=${(e) => {
                                    setRepository(e.currentTarget.value);
                                    setRequestKey(null);
                                }}>
                                ${repositories.map(([name]) => html`<option value=${name}>${name}</option>`)}
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
    pocket.rail({ id: "team", title: "Your team", icon: "chat", page: "team" });
    pocket.launcher({
        id: "team",
        label: "Your named agents",
        detail: "Odrade and the team",
        icon: "chat",
        page: "team",
    });
}
