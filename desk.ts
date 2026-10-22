/**
 * The desk: one thread for each piece of work the team runs in the background. This first part opens a thread when
 * `team_delegate` starts a linked session, binds the session to it, and gives a supervisor session the `desk` tool
 * (`list`, `read`, `seed`). Reports, the sweep, the page, the cap, asks, and the export come in later parts.
 *
 * The truth is one app-wide document, `x.desk.threads`. It is stored data: never rename the kind or change what a
 * field means; add fields beside them.
 *
 * Other modules find this one through `globalThis[Symbol.for("pi-pocket-team.desk")]`, never through an import: an
 * import would keep a stale copy after a reload. With this module off, Team and Night shift work as before.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
    defineDoc,
    defineExtension,
    defineTool,
    type ConversationId,
    type DocumentReader,
    type Tx,
} from "@earendil-works/pi-durable";
import type { Host, Web } from "./_pocket.d.ts";

/** Where another module finds this one's live API. */
const API = Symbol.for("pi-pocket-team.desk");
/** Where this module finds Team's live API. */
const TEAM_API = Symbol.for("pi-pocket-team.team");

/** A thread's title: one line, this long at most. */
const MAX_TITLE = 120;
/** Events kept on a thread, newest last. */
const KEPT_EVENTS = 50;
/** Events shown by `desk read`. */
const SHOWN_EVENTS = 10;

// ─── Stored state ────────────────────────────────────────────────────────────

/** One piece of work the team runs. Stored data: never rename a field or change what it means. */
export type Thread = {
    /** "T13" for a delegated, seeded, or asked thread; "F2" for a found one. */
    id: string;
    /** The replay key: `x.team.delegate:<task>:<call>`, `seed:<sha256>:T3`. */
    key: string;
    origin: "delegate" | "seed" | "found" | "ask";
    /** One line, at most 120 characters. */
    title: string;
    /** Roster ids. */
    agents: string[];
    /** A roster repository name, such as "frostyard/frostmail". */
    repo?: string;
    cwd?: string;
    /** The supervisor session's conversation id. */
    supervisor?: number;
    /** The linked session's conversation id. */
    session?: number;
    /** The supervisor's address for the linked session. */
    address?: string;
    state: "starting" | "open" | "parked" | "closed";
    startedAt: number;
    lastEventAt: number;
    keptAt?: number;
    closed?: { at: number; why: "done" | "dropped" | "failed"; by: "sweep" | "brian" | "desk" };
    /** Key "owner/name#n". */
    prs: Record<
        string,
        { via: "seen" | "branch" | "window" | "attached"; state?: string; next?: string }
    >;
    branches: string[];
    /** Ask ids "T13a", "T13b", ... */
    asks: {
        id: string;
        text: string;
        at: number;
        answer?: { at: number; by: string; words: string };
    }[];
    /** Filled by later parts of the desk; empty for now. */
    run: Record<string, JsonValue>;
    /** The last 50; `key` makes an event unique. */
    events: { at: number; key: string; text: string }[];
};

/** The desk's one document. Stored data: never rename the kind or change what a field means. */
export type DeskState = {
    /** The next id of each kind: T13, F2. */
    next: { T: number; F: number };
    threads: Record<string, Thread>;
    /** Delegation grants, used from the cap part. */
    grants: {
        at: number;
        by: string;
        via: "tap" | "chat";
        key: string;
        usedBy?: string;
        expires: number;
    }[];
    /** "brian", or "supervisor:<id>": the time of the last look. */
    seen: Record<string, number>;
};

/** The desk's threads, app-wide as `x.team.memory` is. */
export const DeskThreads = defineDoc<DeskState>({
    kind: "x.desk.threads",
    version: 1,
    scope: "session",
    initial: () => ({ next: { T: 1, F: 1 }, threads: {}, grants: [], seen: {} }),
});

// ─── Small helpers ───────────────────────────────────────────────────────────

/** One line, no double spaces, at most `MAX_TITLE` characters. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trimEnd();

const iso = (at: number) => new Date(at).toISOString();

/** The id's number: T13 → 13, F2 → 2. */
const idNumber = (id: string) => Number(id.slice(1));

/** The nth ask's letter: a, b, ..., z, aa, ab, ... */
function letters(index: number): string {
    let word = "";
    let left = index;

    do {
        word = String.fromCharCode(97 + (left % 26)) + word;
        left = Math.floor(left / 26) - 1;
    } while (left >= 0);

    return word;
}

const findThread = (state: DeskState, key: string): Thread | undefined =>
    Object.values(state.threads).find((thread) => thread.key === key);

/** Add an event once per key, and keep the newest 50. */
function addEvent(thread: Thread, key: string, text: string, at: number): void {
    if (thread.events.some((event) => event.key === key)) {
        return;
    }

    thread.events.push({ at, key, text });

    if (thread.events.length > KEPT_EVENTS) {
        thread.events.splice(0, thread.events.length - KEPT_EVENTS);
    }

    thread.lastEventAt = at;
}

// ─── Opening, binding, failing ───────────────────────────────────────────────

export type OpenRequest = {
    key: string;
    supervisor: number;
    agents: string[];
    repo?: string;
    cwd?: string;
    title: string;
    at: number;
};

export type BindRequest = { session: number; address: string; at: number };

/**
 * Open a thread for `key`, or return the thread that key made already (a replay): a restarted delegation must not make
 * a second thread.
 */
export function openThread(
    state: DeskState,
    request: OpenRequest,
): { thread: Thread; reused: boolean } {
    const existing = findThread(state, request.key);

    if (existing !== undefined) {
        return { thread: existing, reused: true };
    }

    let number = state.next.T;

    while (Object.hasOwn(state.threads, `T${String(number)}`)) {
        number += 1;
    }

    state.next.T = number + 1;

    const id = `T${String(number)}`;
    const thread: Thread = {
        id,
        key: request.key,
        origin: "delegate",
        title: oneLine(request.title),
        agents: [...request.agents],
        ...(request.repo === undefined ? {} : { repo: request.repo }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        supervisor: request.supervisor,
        state: "starting",
        startedAt: request.at,
        lastEventAt: request.at,
        prs: {},
        branches: [],
        asks: [],
        run: {},
        events: [],
    };

    addEvent(thread, "opened", "opened by delegation", request.at);
    state.threads[id] = thread;

    return { thread, reused: false };
}

/** Bind a started session to its thread. A thread that is not starting does not change: a replay binds nothing. */
export function bindThread(
    state: DeskState,
    key: string,
    binding: BindRequest,
): Thread | undefined {
    const thread = findThread(state, key);

    if (thread === undefined) {
        return undefined;
    }

    if (thread.state === "starting") {
        thread.session = binding.session;
        thread.address = binding.address;
        thread.state = "open";
        addEvent(thread, "bound", `session ${String(binding.session)} bound`, binding.at);
    }

    return thread;
}

/** Close a thread whose linked session did not start. */
export function failThread(
    state: DeskState,
    key: string,
    why: string,
    at: number,
): Thread | undefined {
    const thread = findThread(state, key);

    if (thread === undefined || thread.state !== "starting") {
        return undefined;
    }

    thread.state = "closed";
    thread.closed = { at, why: "failed", by: "desk" };
    addEvent(thread, "failed", `failed: ${oneLine(why)}`, at);

    return thread;
}

// ─── The seed file ───────────────────────────────────────────────────────────

export type SeedRow = {
    id: string;
    title: string;
    agents: string[];
    repo?: string;
    prs?: string[];
    session?: string;
    asks?: string[];
    mark: "keep" | "park";
};

const THREAD_ID = /^T[1-9][0-9]*$/;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const PR_REF = /^[\w.-]+\/[\w.-]+#[1-9][0-9]*$/;
const SEED_FIELDS = new Set(["id", "title", "agents", "repo", "prs", "session", "asks", "mark"]);

const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "");

/**
 * Check a seed.json file. Each error names the row (its id, or its position when the id is bad) and the field.
 * The title is cut to one line of 120 characters here, so the rest of the module sees the stored form.
 */
export function parseSeed(text: string): { threads: SeedRow[] } | { error: string } {
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch {
        return { error: "seed.json is not valid JSON." };
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { error: "seed.json must be a JSON object." };
    }

    const object = value as Record<string, unknown>;

    for (const key of Object.keys(object)) {
        if (key !== "threads") {
            return { error: `seed.json has an unknown field: "${key}".` };
        }
    }

    if (!Array.isArray(object.threads)) {
        return { error: 'seed.json needs a "threads" array.' };
    }

    const threads: SeedRow[] = [];
    const ids = new Set<string>();

    for (const [index, item] of object.threads.entries()) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            return { error: `Row ${String(index + 1)} must be a JSON object.` };
        }

        const row = item as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : "";
        const name = THREAD_ID.test(id) ? `Row ${id}` : `Row ${String(index + 1)}`;

        if (!THREAD_ID.test(id)) {
            return { error: `${name}: "id" must be a thread id such as T1.` };
        }

        if (ids.has(id)) {
            return { error: `${name}: "id" is in the file twice.` };
        }

        for (const key of Object.keys(row)) {
            if (!SEED_FIELDS.has(key)) {
                return { error: `${name}: unknown field "${key}".` };
            }
        }

        if (typeof row.title !== "string" || oneLine(row.title) === "") {
            return { error: `${name}: "title" must be a non-empty string.` };
        }

        if (!strings(row.agents) || row.agents.length === 0) {
            return { error: `${name}: "agents" must be a non-empty array of agent ids.` };
        }

        if (row.repo !== undefined && (typeof row.repo !== "string" || !REPO_NAME.test(row.repo))) {
            return { error: `${name}: "repo" must be "owner/name".` };
        }

        if (
            row.prs !== undefined &&
            (!Array.isArray(row.prs) ||
                !row.prs.every((ref) => typeof ref === "string" && PR_REF.test(ref)))
        ) {
            return { error: `${name}: "prs" must be an array of "owner/name#n" refs.` };
        }

        if (
            row.session !== undefined &&
            (typeof row.session !== "string" || row.session.trim() === "")
        ) {
            return { error: `${name}: "session" must be an address string.` };
        }

        if (row.asks !== undefined && !strings(row.asks)) {
            return { error: `${name}: "asks" must be an array of questions.` };
        }

        if (row.mark !== "keep" && row.mark !== "park") {
            return { error: `${name}: "mark" must be "keep" or "park".` };
        }

        ids.add(id);
        threads.push({
            id,
            title: oneLine(row.title),
            agents: row.agents,
            ...(row.repo === undefined ? {} : { repo: row.repo }),
            ...(row.prs === undefined ? {} : { prs: row.prs as string[] }),
            ...(row.session === undefined ? {} : { session: row.session }),
            ...(row.asks === undefined ? {} : { asks: row.asks as string[] }),
            mark: row.mark,
        });
    }

    return { threads };
}

export type SeedOptions = { hash: string; supervisor: number; at: number };

/**
 * Import the rows once, keyed by the seed file's hash. A second import of the same file changes nothing; another seed
 * file is refused; a row whose id is taken is refused with the ids.
 */
export function seedThreads(
    state: DeskState,
    rows: SeedRow[],
    options: SeedOptions,
): { added: string[]; reused: boolean } | { error: string } {
    const prefix = `seed:${options.hash}:`;

    if (Object.values(state.threads).some((thread) => thread.key.startsWith(prefix))) {
        return { added: [], reused: true };
    }

    if (Object.values(state.threads).some((thread) => thread.origin === "seed")) {
        return { error: "The desk is already seeded." };
    }

    const taken = rows.filter((row) => Object.hasOwn(state.threads, row.id)).map((row) => row.id);

    if (taken.length > 0) {
        return { error: `These thread ids are taken: ${taken.join(", ")}.` };
    }

    let highest = 0;

    for (const row of rows) {
        const thread: Thread = {
            id: row.id,
            key: `${prefix}${row.id}`,
            origin: "seed",
            title: row.title,
            agents: [...row.agents],
            ...(row.repo === undefined ? {} : { repo: row.repo }),
            supervisor: options.supervisor,
            ...(row.session === undefined ? {} : { address: row.session }),
            state: row.mark === "park" ? "parked" : "open",
            startedAt: options.at,
            lastEventAt: options.at,
            ...(row.mark === "keep" ? { keptAt: options.at } : {}),
            prs: Object.fromEntries(
                (row.prs ?? []).map((ref) => [ref, { via: "attached" as const }]),
            ),
            branches: [],
            asks: (row.asks ?? []).map((text, index) => ({
                id: `${row.id}${letters(index)}`,
                text,
                at: options.at,
            })),
            run: {},
            events: [],
        };

        addEvent(thread, "seeded", `seeded (${row.mark})`, options.at);
        state.threads[row.id] = thread;
        highest = Math.max(highest, idNumber(row.id));
    }

    state.next.T = Math.max(state.next.T, highest + 1);

    return { added: rows.map((row) => row.id), reused: false };
}

// ─── Words for the tool ──────────────────────────────────────────────────────

const counted = (count: number, noun: string) =>
    `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** One line for each thread that is not closed, newest last. */
export function listText(state: Readonly<DeskState> | undefined): string {
    const threads = Object.values(state?.threads ?? {})
        .filter((thread) => thread.state !== "closed")
        .sort((a, b) => a.startedAt - b.startedAt || idNumber(a.id) - idNumber(b.id));

    if (threads.length === 0) {
        return "No threads on the desk.";
    }

    return threads
        .map((thread) => {
            const prs = Object.keys(thread.prs).length;
            const asks = thread.asks.filter((ask) => ask.answer === undefined).length;

            return [
                thread.id,
                thread.state,
                thread.repo ?? "no repo",
                thread.agents.join(", ") || "nobody",
                ...(prs === 0 ? [] : [counted(prs, "PR")]),
                ...(asks === 0 ? [] : [counted(asks, "ask")]),
                thread.title,
            ].join(" · ");
        })
        .join("\n");
}

/** One thread in full: what a person needs to judge it. */
export function readText(state: Readonly<DeskState> | undefined, id: string): string | undefined {
    const key = id.trim().replace(/^#/, "").toUpperCase();
    const threads = state?.threads ?? {};
    const thread = Object.hasOwn(threads, key) ? threads[key] : undefined;

    if (thread === undefined) {
        return undefined;
    }

    const prs = Object.entries(thread.prs);
    const events = thread.events.slice(-SHOWN_EVENTS);

    return [
        `${thread.id} · ${thread.state} · ${thread.title}`,
        `Origin: ${thread.origin}`,
        `Agents: ${thread.agents.join(", ") || "nobody"}`,
        `Repo: ${thread.repo ?? "none"}`,
        `Folder: ${thread.cwd ?? "none"}`,
        `Supervisor session: ${thread.supervisor === undefined ? "none" : String(thread.supervisor)}`,
        `Session: ${thread.session === undefined ? "not bound" : String(thread.session)}`,
        `Address: ${thread.address ?? "none"}`,
        `Started: ${iso(thread.startedAt)} · last event: ${iso(thread.lastEventAt)}`,
        ...(thread.keptAt === undefined ? [] : [`Kept: ${iso(thread.keptAt)}`]),
        ...(thread.closed === undefined
            ? []
            : [`Closed: ${iso(thread.closed.at)} · ${thread.closed.why} · by ${thread.closed.by}`]),
        prs.length === 0
            ? "PRs: none"
            : `PRs:\n${prs.map(([ref, pr]) => `  ${ref} · ${pr.via}${pr.state === undefined ? "" : ` · ${pr.state}`}${pr.next === undefined ? "" : ` · next: ${pr.next}`}`).join("\n")}`,
        `Branches: ${thread.branches.length === 0 ? "none" : thread.branches.join(", ")}`,
        thread.asks.length === 0
            ? "Asks: none"
            : `Asks:\n${thread.asks
                  .map(
                      (ask) =>
                          `  ${ask.id} · ${ask.answer === undefined ? "open" : `answered by ${ask.answer.by}`} · ${ask.text}`,
                  )
                  .join("\n")}`,
        events.length === 0
            ? "Events: none"
            : `Events:\n${events.map((event) => `  ${iso(event.at)} · ${event.text}`).join("\n")}`,
    ].join("\n");
}

// ─── The API other modules use ───────────────────────────────────────────────

/** What `team.ts` uses: on `globalThis[Symbol.for("pi-pocket-team.desk")]`, so it finds the live version. */
export type DeskApi = {
    version: 1;
    open: (tx: Tx, request: OpenRequest) => Promise<{ thread: Thread; reused: boolean }>;
    bind: (tx: Tx, key: string, binding: BindRequest) => Promise<Thread | undefined>;
    fail: (tx: Tx, key: string, why: string, at: number) => Promise<void>;
};

// ─── The module ──────────────────────────────────────────────────────────────

/** Team's API, as this module reads it: never an import, so a reload cannot leave a stale copy. */
type TeamMember = {
    id: string;
    name: string;
    role: "supervisor" | "agent";
    repositories?: Record<string, string>;
};

type TeamApi = {
    version: number;
    persona: (
        read: DocumentReader,
        conversationId: ConversationId,
        context: Context,
    ) => Promise<TeamMember | undefined>;
    roster: () => Promise<TeamMember[]>;
};

const teamApi = (): TeamApi | undefined =>
    (globalThis as unknown as Record<symbol, TeamApi | undefined>)[TEAM_API];

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

/** Its tool returns `output`, so it needs version 2 of the extension API. */
export const pocketApi = 2;

export default function createDesk(_host: Host, web: Web) {
    const published: DeskApi = {
        version: 1,
        open: async (tx, request) => openThread(await tx.doc(DeskThreads), request),
        bind: async (tx, key, binding) => bindThread(await tx.doc(DeskThreads), key, binding),
        fail: async (tx, key, why, at) => {
            failThread(await tx.doc(DeskThreads), key, why, at);
        },
    };
    const shared = globalThis as unknown as Record<symbol, DeskApi | undefined>;

    // Another module finds this version here. A new version sets its own before the old one's cleanup runs.
    shared[API] = published;
    web.onDispose(() => {
        if (shared[API] === published) {
            delete shared[API];
        }
    });

    const tool = defineTool({
        name: "desk",
        description:
            "Supervisor only: the desk of threads for work the team runs in the background. Actions: list (one line per open thread), read (one thread in full), seed (import a seed.json file one time).",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("seed")]),
            thread: Type.Optional(Type.String({ description: "read: a thread id, such as T13" })),
            path: Type.Optional(
                Type.String({ description: "seed: the absolute path of a seed.json file" }),
            ),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
            const team = teamApi();

            if (team === undefined) {
                throw new Error("The Team module is off. Brian turns it on in Menu → Extensions.");
            }

            const persona = await team.persona(api, api.conversationId, context);

            if (persona?.role !== "supervisor") {
                throw new Error("Only a session assigned a supervisor identity can use the desk.");
            }

            if (args.action === "list") {
                return reply(listText(await api.snapshot(DeskThreads, context)));
            }

            if (args.action === "read") {
                const id = args.thread?.trim();

                if (id === undefined || id === "") {
                    throw new Error("read needs thread: a thread id such as T13.");
                }

                const text = readText(await api.snapshot(DeskThreads, context), id);

                if (text === undefined) {
                    throw new Error(`There is no thread ${id.toUpperCase()} on the desk.`);
                }

                return reply(text);
            }

            if (args.path === undefined || !isAbsolute(args.path)) {
                throw new Error("seed needs path: the absolute path of a seed.json file.");
            }

            const path = args.path;
            const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
                throw new Error(
                    error.code === "ENOENT"
                        ? `There is no file at ${path}.`
                        : `Cannot read ${path}: ${error.message}.`,
                );
            });
            const parsed = parseSeed(bytes.toString("utf8"));

            if ("error" in parsed) {
                throw new Error(parsed.error);
            }

            const members = await team.roster();
            const known = new Set(members.map((member) => member.id));
            const unknown = parsed.threads.flatMap((row) =>
                row.agents
                    .filter((agent) => !known.has(agent))
                    .map((agent) => `${row.id}: ${agent}`),
            );

            if (unknown.length > 0) {
                throw new Error(
                    `Unknown agent ids: ${unknown.join(", ")}. The team has: ${[...known].join(", ") || "nobody"}.`,
                );
            }

            const hash = createHash("sha256").update(bytes).digest("hex");
            const result = await api.commit(async (tx) => {
                const seeded = seedThreads(await tx.doc(DeskThreads), parsed.threads, {
                    hash,
                    supervisor: Number(api.conversationId),
                    at: Date.now(),
                });

                if ("error" in seeded) {
                    throw new Error(seeded.error);
                }

                return seeded;
            }, context);

            return reply(
                result.reused
                    ? "This seed is in the desk already: nothing changed."
                    : `Seeded ${result.added.join(", ")}.`,
            );
        },
    });

    return defineExtension({ name: "desk", tools: [tool] });
}
