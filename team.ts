/**
 * Brian's named agents: select a session identity and delegate to named teammates.
 * Reads souls and model preferences from ~/.config/pi-pocket-team/agents; no stomp history, notebooks, or credentials.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
    defineDoc,
    defineExtension,
    defineTool,
    section,
    type ConversationId,
} from "@earendil-works/pi-durable";
import type { Host, Web } from "./_pocket.d.ts";

type Persona = {
    id: string;
    name: string;
    role: "supervisor" | "agent";
    model: string;
    instructions: string;
    repositories: Record<string, string>;
    workspace?: string;
};

const localFolder = (path: unknown): string => {
    if (typeof path !== "string" || (!isAbsolute(path) && !path.startsWith("~/"))) {
        throw new Error("Team repository folders must be absolute paths or start with ~/.");
    }

    return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
};

function taskFolder(persona: Persona, repository?: unknown): string | undefined {
    const repositories = persona.repositories;
    const names = Object.keys(repositories);

    if (repository !== undefined) {
        if (typeof repository !== "string" || !Object.hasOwn(repositories, repository)) {
            throw new Error(`${persona.name} owns: ${names.join(", ") || "no repositories"}.`);
        }

        return repositories[repository];
    }

    if (names.length > 1) {
        throw new Error(`Choose one of ${persona.name}'s repositories: ${names.join(", ")}.`);
    }

    return names.length === 1 ? repositories[names[0]!] : persona.workspace;
}

// Snapshot the selected soul: edits to files affect new selections, not running work.
export const Identity = defineDoc<{ persona?: Persona }>({
    kind: "x.team.identity",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});

export async function roster(directory: string): Promise<Persona[]> {
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return [];
        }

        throw error;
    });
    const agents: Persona[] = [];

    for (const file of names.sort()) {
        if (!/^[a-z0-9][a-z0-9_-]*\.md$/.test(file)) {
            continue;
        }

        const { frontmatter, body } = parseFrontmatter(
            await readFile(join(directory, file), "utf8"),
        );
        const model = Array.isArray(frontmatter.model) ? frontmatter.model[0] : frontmatter.model;
        const repositories = Object.fromEntries(
            Object.entries(frontmatter.repositories ?? {}).map(([name, folder]) => [
                name,
                localFolder(folder),
            ]),
        );

        agents.push({
            id: file.slice(0, -3),
            name: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? file.slice(0, -3),
            role: frontmatter.role === "supervisor" ? "supervisor" : "agent",
            model: typeof model === "string" ? model : "",
            instructions: body.trim(),
            repositories,
            ...(frontmatter.workspace === undefined
                ? {}
                : { workspace: localFolder(frontmatter.workspace) }),
        });
    }

    return agents.sort(
        (a, b) =>
            Number(b.role === "supervisor") - Number(a.role === "supervisor") ||
            a.name.localeCompare(b.name),
    );
}

const identityText = (persona: Persona) => `Named identity for this Pi Pocket session:
${persona.instructions}

Work on the person's current request in this session's folder. Keep task history in its session.
Your name and responsibilities do not change the tools, permissions, or model selected in Pi Pocket.
${
    persona.role === "supervisor"
        ? "You own the team, not this conversation's repository. Do work directly when helpful. Use team_delegate for a specialist; select their repository by its roster name and give a self-contained task. Their task starts in that repository regardless of your folder. A greeting needs no audit of old work."
        : "Do your assigned work directly. For a linked task, report the result once with team_message to the return address in its initial message."
}`;

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

export default function createTeam(host: Host, web: Web) {
    if (typeof web.conversationRoute !== "function") {
        throw new Error("Named agents needs Pi Pocket 0.16.0 or newer.");
    }

    const directory =
        process.env.PI_POCKET_TEAM_AGENTS ?? join(homedir(), ".config", "pi-pocket-team", "agents");

    const find = async (id: unknown) => {
        const agent = (await roster(directory)).find((a) => a.id === id);

        if (!agent) {
            throw web.error(400, "Choose an agent from the team.");
        }

        return agent;
    };

    const taskText = (persona: Persona, message: string) =>
        `${identityText(persona)}\n\nTask from the source session:\n${message}`;

    web.client("team-web");
    web.route("GET", "agents", async () => ({
        agents: await roster(directory),
    }));
    web.conversationRoute(
        "GET",
        "session/:source",
        async (req) => ({
            identity:
                (await req.snapshot(Identity, req.conversation.id, req.context))?.persona ?? null,
            conversation: req.conversation,
            linked: await req.linkedSessions.list(),
        }),
        { conversation: "source" },
    );
    web.conversationRoute(
        "POST",
        "session/:source/identity",
        async (req) => {
            const persona = req.body.agent === null ? undefined : await find(req.body.agent);

            await req.commit(async (tx) => {
                const doc = await tx.doc(Identity, req.conversation.id);

                if (persona) {
                    doc.persona = persona;
                } else {
                    delete doc.persona;
                }
            });

            return { identity: persona ?? null };
        },
        { conversation: "source" },
    );

    web.conversationRoute(
        "POST",
        "session/:source/start",
        async (req) => {
            const persona = await find(req.body.agent);
            let cwd: string | undefined;

            try {
                cwd = taskFolder(persona, req.body.repository);
            } catch (error) {
                throw web.error(400, (error as Error).message);
            }

            const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
            const key = typeof req.body.key === "string" ? req.body.key : "";

            if (!message || message.length > 6000 || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) {
                throw web.error(400, "Enter a task of up to 6000 characters.");
            }

            const started = await req.linkedSessions.start(
                {
                    title: `${persona.name}: ${message.split("\n")[0]}`.slice(0, 120),
                    message: taskText(persona, message),
                    ...(cwd === undefined ? {} : { cwd }),
                    ...(req.body.usePreferredModel === true && persona.model
                        ? { model: persona.model }
                        : {}),
                },
                `x.team.human:${key}`,
            );

            // start admits the first message before returning: it contains the identity as well.
            // The document keeps that identity for subsequent turns and context resets.
            await req.commit(async (tx) => {
                const doc = await tx.doc(Identity, started.session as ConversationId);

                doc.persona ??= persona;
            });

            return started;
        },
        { conversation: "source" },
    );

    web.command("team-agent", {
        description: "Use a named identity in this session, or clear it",
        args: "[agent id | clear]",
        scope: "global",
        handler: async (args, ctx) => {
            if (!args.trim()) {
                return {
                    type: "card",
                    output: (await roster(directory)).map((a) => `${a.id}: ${a.name}`).join("\n"),
                };
            }

            const persona = args.trim() === "clear" ? undefined : await find(args.trim());

            await ctx.commit(async (tx) => {
                const doc = await tx.doc(Identity, ctx.conversationId);

                if (persona) {
                    doc.persona = persona;
                } else {
                    delete doc.persona;
                }
            });

            return {
                type: "toast",
                level: "info",
                message: persona
                    ? `This session is now ${persona.name}. Its model and folder are unchanged.`
                    : "Named identity cleared.",
            };
        },
    });

    const delegate = defineTool({
        name: "team_delegate",
        description:
            "Supervisor only: give a self-contained task to a named agent in their repository folder. Choose a repository from the roster if the agent owns more than one. Inherits your model and thinking. Returns an address without waiting for completion.",
        parameters: Type.Object({
            agent: Type.String(),
            task: Type.String({ minLength: 1, maxLength: 6000 }),
            repository: Type.Optional(
                Type.String({
                    description:
                        "Owned repository name from the roster, e.g. frostyard/nsl. Omit when the agent has only one repository or a non-repository workspace.",
                }),
            ),
        }),
        replay: "safe",
        execute: async ({ agent, task, repository }, api, context) => {
            const identity = await api.snapshot(Identity, api.conversationId, context);

            if (identity?.persona?.role !== "supervisor") {
                throw new Error("Only a session assigned a supervisor identity can delegate.");
            }

            const persona = await find(agent);
            const cwd = taskFolder(persona, repository);

            if (persona.role === "supervisor") {
                throw new Error("Choose a specialist from the roster.");
            }

            const started = await host.linkedSessions.start(
                api.conversationId,
                {
                    title: `${persona.name}: ${task.split("\n")[0]}`.slice(0, 120),
                    message: taskText(persona, task),
                    ...(cwd === undefined ? {} : { cwd }),
                },
                `x.team.delegate:${api.taskId}:${api.callId}`,
            );

            await api.commit(async (tx) => {
                (await tx.doc(Identity, started.session as ConversationId)).persona ??= persona;
            }, context);

            return reply(
                `Assigned to ${persona.name} at ${started.address}. Reports arrive when they send them; do not poll or acknowledge reports.`,
            );
        },
    });
    const message = defineTool({
        name: "team_message",
        description:
            "Send a task follow-up or final report to a linked-session address. It returns when admitted, without waiting for an answer.",
        parameters: Type.Object({
            to: Type.String(),
            message: Type.String({ minLength: 1, maxLength: 6000 }),
        }),
        replay: "safe",
        execute: async (args, api) => {
            await host.linkedSessions.send(
                api.conversationId,
                args,
                `x.team.message:${api.taskId}:${api.callId}`,
            );

            return reply("Message sent. Do not send an acknowledgement or wait for a reply.");
        },
    });
    const list = Object.assign(
        defineTool({
            name: "team_sessions",
            description:
                "List linked teammates and their addresses when needed for the current task.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, api) => {
                const sessions = await host.linkedSessions.list(api.conversationId);

                return reply(
                    sessions
                        .map(
                            (s) =>
                                `${s.address}: ${host.text.quoted(s.title ?? "Linked session")} (${s.busy ? "working" : "idle"})`,
                        )
                        .join("\n") || "No linked sessions.",
                );
            },
        }),
        { annotations: { readOnlyHint: true } },
    );

    return defineExtension({
        name: "named-team",
        tools: [delegate, message, list],
        sections: [
            section("named_team", async (input, context) => {
                const identity = await input.read.snapshot(Identity, input.conversationId, context);

                if (!identity?.persona) {
                    return undefined;
                }

                const agents =
                    identity.persona.role === "supervisor" ? await roster(directory) : [];
                const members = agents
                    .filter((a) => a.role !== "supervisor")
                    .map((a) => {
                        const responsibilities = a.instructions
                            .split(/^## Responsibilities\s*$/m)[1]
                            ?.trim();

                        const folders = Object.entries(a.repositories)
                            .map(([name, folder]) => `  ${name}: ${folder}`)
                            .join("\n");

                        return `${a.id}: ${a.name}\n${folders || `  Workspace: ${a.workspace ?? "source session folder"}`}${responsibilities ? `\n${responsibilities}` : ""}`;
                    });

                return (
                    identityText(identity.persona) +
                    (members.length
                        ? `\n\nNamed teammates:\n${members.join("\n")}\nDelegation inherits your model; agent preferences are shown in the Team panel.`
                        : "")
                );
            }),
        ],
    });
}
