// Pi Pocket's helpers isolate all credentials, sessions, and model calls.
import {
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "./_pocket/src/server/http.ts";
import {
    delegationWorktree,
    FRONT_DOOR_DESK_OFF,
    Identity,
    MESSAGE_LIMITS,
    pickSupervisor,
    roster,
    teamMessageProblems,
} from "./team.ts";

after(cleanUp);
const definitions = join(root, "agents");
const repoA = join(root, "nsl");
const repoB = join(root, "igloo");

process.env.PI_POCKET_TEAM_AGENTS = definitions;
mkdirSync(definitions);
mkdirSync(repoA);
mkdirSync(repoB);
writeFileSync(
    join(definitions, "odrade.md"),
    "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate Brian's team.",
);
writeFileSync(
    join(definitions, "duncan.md"),
    `---\nmodel: faux/faux-2\nrepositories:\n  frostyard/nsl: ${repoA}\n  frostyard/igloo: ${repoB}\n---\n# Duncan Idaho\nYou are Duncan Idaho. Own the test repositories.`,
);
writeFileSync(
    join(definitions, "teg.md"),
    `---\nrepositories:\n  bketelsen/fleet: ${repoA}\n---\n# Miles Teg\nOwn fleet.`,
);
writeFileSync(
    join(definitions, "moneo.md"),
    `---\nworkspace: ${repoB}\n---\n# Moneo\nOwn the NAS.`,
);

test("drop-in identities, named delegation, HTTP permissions, replay and restart", async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    let requestContext = "";
    let rosterContext = "";
    const model = scriptedModel((ctx) => {
        requestContext = JSON.stringify(ctx);

        if (requestContext.includes("Named teammates:")) {
            rosterContext = requestContext;
        }

        const { text, role } = lastText(ctx as never);

        if (role === "user" && text.endsWith("delegate test")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("team_delegate", {
                        agent: "duncan",
                        repository: "frostyard/igloo",
                        task: "Say hello. No tools needed.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text.endsWith("report test")) {
            const address = /Message from linked session (session-[a-f0-9-]+)/.exec(
                requestContext,
            )?.[1];

            assert(address, "The worker receives a return address in its initial context.");

            return fauxAssistantMessage(
                [
                    fauxToolCall("team_message", {
                        to: address,
                        message: "Duncan finished the prototype task.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text.endsWith("null status test")) {
            const address = /Message from linked session (session-[a-f0-9-]+)/.exec(
                requestContext,
            )?.[1];

            return fauxAssistantMessage(
                [
                    fauxToolCall("team_message", {
                        to: address,
                        message: "Duncan sent a null status.",
                        status: null,
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text.endsWith("long ask test")) {
            const address = /Message from linked session (session-[a-f0-9-]+)/.exec(
                requestContext,
            )?.[1];

            return fauxAssistantMessage(
                [
                    fauxToolCall("team_message", {
                        to: address,
                        message: "Duncan needs a decision.",
                        status: "blocked",
                        asks: [{ question: `Pick one. ${"x".repeat(530)}`, options: ["a", "b"] }],
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    });
    let app = await openApp(model);
    let server: ReturnType<typeof createServer> | undefined;

    try {
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        const id = await newSession(app);
        const plain = await newSession(app);

        server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/team/`;

        async function call(path: string, body?: object, token = app.config.ownerToken) {
            const res = await fetch(base + path, {
                method: body ? "POST" : "GET",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });

            return { status: res.status, data: await res.json() };
        }

        assert.equal((await call("agents")).data.agents.length, 4);
        const guest = app.config.addUser("Guest", "guest");

        assert.equal((await call("agents", undefined, guest.token)).status, 404);
        // The supervisor button's route: owner-only; with the desk off it opens nothing and says why.
        assert.equal((await call("supervisor", undefined, guest.token)).status, 404);
        assert.deepEqual((await call("supervisor")).data, {
            found: false,
            reason: "desk-off",
            text: FRONT_DOOR_DESK_OFF,
        });
        assert.equal((await call(`session/${id}/identity`, { agent: "../missing" })).status, 400);
        assert.equal((await call(`session/${id}/identity`, { agent: "odrade" })).status, 200);
        assert.equal((await app.harness.snapshot(Identity, id, context))?.persona?.id, "odrade");
        assert.equal((await call(`session/${id}`)).data.identity.name, "Odrade");
        assert.equal((await call(`session/${id}/identity`, { agent: null })).status, 200);
        assert.equal((await call(`session/${id}`)).data.identity, null);
        assert.equal((await call(`session/${id}/identity`, { agent: "odrade" })).status, 200);
        await say(app, id, "Hello");
        const transcript = requestContext;

        assert.match(transcript, /You are Odrade/);
        assert.match(transcript, /frostyard\/nsl/);
        await say(app, plain, "Hello");
        assert.doesNotMatch(requestContext, /You are Odrade/);

        for (const [agent, cwd] of [
            ["teg", repoA],
            ["moneo", repoB],
        ]) {
            const response = await call(`session/${id}/start`, {
                agent,
                message: "Use your working folder",
                key: `default-folder-${agent}`,
            });

            assert.equal(response.status, 200);
            assert.equal(app.cwdOf(response.data.session), cwd);
            await until(() => !app.isBusy(response.data.session), "default-folder task settled");
        }

        // Default starts use the source model; opting into an unallowed model fails in core.
        const denied = await call(`session/${id}/start`, {
            agent: "duncan",
            repository: "frostyard/nsl",
            message: "Hello",
            key: "denied-model-001",
            usePreferredModel: true,
        });

        assert.notEqual(denied.status, 200);
        const count = app.sessions().length;

        for (const repository of [undefined, "someone/else"]) {
            assert.equal(
                (
                    await call(`session/${id}/start`, {
                        agent: "duncan",
                        repository,
                        message: "Choose the right repository",
                        key: "bad-repository-001",
                    })
                ).status,
                400,
            );
            assert.equal(app.sessions().length, count);
        }

        const request = {
            agent: "duncan",
            repository: "frostyard/nsl",
            message: "Say hello",
            key: "named-task-0001",
        };
        const started = await call(`session/${id}/start`, request);

        assert.equal(started.status, 200, JSON.stringify(started.data));
        assert.equal(
            (await call(`session/${id}/start`, request)).data.session,
            started.data.session,
        );
        const child = started.data.session;

        await until(() => !app.isBusy(child), "linked task settled");
        assert.equal((await app.harness.snapshot(Identity, child, context))?.persona?.id, "duncan");
        assert.match((await modelTexts(app, child)).join("\n"), /You are Duncan Idaho/);
        assert.equal(app.cwdOf(child), repoA);
        assert.equal(app.cwdOf(id), work);
        await say(app, child, "report test");
        await until(
            async () =>
                (await modelTexts(app, id))
                    .join("\n")
                    .includes("Duncan finished the prototype task."),
            "specialist report delivered to supervisor",
        );
        await until(() => !app.isBusy(id), "supervisor received the report");
        // A null optional status is dropped by the validator, as before: the message goes.
        await say(app, child, "null status test");
        await until(
            async () =>
                (await modelTexts(app, id)).join("\n").includes("Duncan sent a null status."),
            "a null status is no refusal",
        );
        await until(() => !app.isBusy(child) && !app.isBusy(id), "null status settled");
        // An ask over its limit: the error says which argument, the limit, by how much, and what to do; nothing is sent.
        await say(app, child, "long ask test");
        await until(() => !app.isBusy(child), "long ask settled");
        const longAsk = (await modelTexts(app, child)).join("\n");

        assert.match(
            longAsk,
            /team_message was not sent\. Fix the arguments below, and call it again:\\n- asks\[0\]\.question has 540 characters; the limit is 500\. Cut at least 40 characters: keep 1 decision on 1 line/,
        );
        assert.doesNotMatch((await modelTexts(app, id)).join("\n"), /Duncan needs a decision/);
        type Linked = { conversationId: string; title?: string; cwd?: string };

        // Delegate once, and return the new session with the model it runs on.
        async function delegateOnce() {
            const seen = new Set(
                (await call(`session/${id}`)).data.linked.map((s: Linked) => s.conversationId),
            );

            await say(app, id, "delegate test");
            await until(
                async () =>
                    (await call(`session/${id}`)).data.linked.some(
                        (s: Linked) => !seen.has(s.conversationId),
                    ),
                "named delegation",
            );
            const delegated = (await call(`session/${id}`)).data.linked.find(
                (s: Linked) => !seen.has(s.conversationId),
            ) as Linked;

            assert(delegated.title?.startsWith("Duncan Idaho:"));
            assert.equal(delegated.cwd, repoB, "Odrade's tool uses Duncan's selected repository.");
            await until(() => !app.isBusy(delegated.conversationId), "delegated task settled");
            await until(() => !app.isBusy(id), "supervisor settled");
            const runs = (await app.agentState(delegated.conversationId))?.model;

            return `${runs?.provider}/${runs?.modelId}`;
        }

        // Duncan's profile model is not in the owner's allowed list: he runs on Odrade's model, and the result says so.
        assert.match(
            rosterContext,
            /Model: your model \(faux\/faux-2 is not allowed for subagents\)/,
        );
        assert.equal(await delegateOnce(), "faux/faux-1");
        assert.match(
            (await modelTexts(app, id)).join("\n"),
            /on your model \(faux\/faux-2 is not allowed for subagents\)/,
        );

        // The owner allows it: delegation runs Duncan on his profile model, and the roster says so.
        await app.setSubagentModels(owner(app), ["faux/faux-2"]);
        assert.equal(await delegateOnce(), "faux/faux-2");
        assert.match((await modelTexts(app, id)).join("\n"), /, on faux\/faux-2\./);
        assert.match(rosterContext, /Model: faux\/faux-2\\n/);
        assert.equal(app.cwdOf(id), work);
        // A specialist can't create a second layer of agents.
        await say(app, child, "delegate test");
        assert.match(
            (await modelTexts(app, child)).join("\n"),
            /Only a session assigned a supervisor/,
        );

        // The third role: `role: clerk`. It sorts with the others by name, and the supervisor stays first.
        writeFileSync(
            join(definitions, "clerk.md"),
            `---\nrole: clerk\nmodel: faux/faux-2\nworkspace: ${repoA}\n---\n# Clerk\nYou are the desk clerk.`,
        );

        try {
            const listed = (await call("agents")).data.agents as { id: string; role: string }[];

            assert.equal(listed.find((each) => each.id === "clerk")?.role, "clerk");
            assert.equal(listed[0]?.role, "supervisor", "the supervisor goes first");

            const clerkSession = await newSession(app);

            assert.equal(
                (await call(`session/${clerkSession}/identity`, { agent: "clerk" })).status,
                200,
            );
            await say(app, clerkSession, "Hello");
            assert.match(
                requestContext,
                /You are the desk clerk of your supervisor\. Desk digests arrive as messages whose lines start with \[desk\]\. Escalate to your supervisor with team_message to the return address in your first message\. A thread that desk read shows as Handled needs no escalation for its reports, because the supervisor acted after them\./,
            );
            assert.doesNotMatch(requestContext, /Named teammates:/, "a Clerk gets no roster");
        } finally {
            rmSync(join(definitions, "clerk.md"), { force: true });
        }

        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        await app.close();
        app = await openApp(model);
        assert.equal((await app.harness.snapshot(Identity, id, context))?.persona?.id, "odrade");
        assert.equal((await app.harness.snapshot(Identity, child, context))?.persona?.id, "duncan");
        assert.equal(app.cwdOf(child), repoA);
        await say(app, id, "Still here?");
        assert.match(requestContext, /You are Odrade/);
    } finally {
        server?.closeAllConnections();
        server?.close();
        await app.close();
    }
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

/** One git command in a test folder. */
const git = (folder: string, ...args: string[]): string =>
    execFileSync("git", args, {
        cwd: folder,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

/** A folder with 1 commit: nothing when it is a repository with a commit already. */
function repository(folder: string): void {
    mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q");

    try {
        git(folder, "rev-parse", "--verify", "HEAD");
    } catch {
        writeFileSync(join(folder, "file.txt"), "one\n");
        git(folder, "add", ".");
        git(
            folder,
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "-qm",
            "one",
        );
    }
}

test("a delegation gets a sibling worktree on a new branch, and its key reuses it", async () => {
    const checkout = join(root, "worktree-checkout");

    repository(checkout);

    const key = "x.team.delegate:task-1:call-1";
    const slug = createHash("sha256").update(key).digest("hex").slice(0, 8);
    const first = await delegationWorktree(checkout, { agent: "duncan", key });

    assert(first, "a repository gets a worktree");
    assert.equal(first.checkout, checkout);
    assert.equal(first.path, join(root, `worktree-checkout--duncan-${slug}`));
    assert.equal(first.branch, `duncan/${slug}`);
    assert.equal(existsSync(first.path!), true);
    assert.equal(git(first.path!, "rev-parse", "--abbrev-ref", "HEAD").trim(), `duncan/${slug}`);

    // A replay of the same key finds the worktree it made, and makes no second one.
    const again = await delegationWorktree(checkout, { agent: "duncan", key });

    assert.equal(again?.path, first.path);

    // Another call is another worktree, so 2 jobs in 1 repository share no folder.
    const second = await delegationWorktree(checkout, {
        agent: "duncan",
        key: "x.team.delegate:task-1:call-2",
    });

    assert.notEqual(second?.path, first.path);
    assert.equal(existsSync(second!.path!), true);

    // A folder that is not a git repository, and a folder inside one, keep the folder itself.
    const plain = join(root, "worktree-plain");

    mkdirSync(plain, { recursive: true });
    assert.equal(await delegationWorktree(plain, { agent: "duncan", key }), undefined);

    const inside = join(checkout, "sub");

    mkdirSync(inside, { recursive: true });
    assert.equal(await delegationWorktree(inside, { agent: "duncan", key }), undefined);

    // A folder that is not this repository's worktree is no worktree: the delegation says why and uses the checkout.
    const occupiedKey = "x.team.delegate:task-1:call-3";
    const occupied = join(
        root,
        `worktree-checkout--duncan-${createHash("sha256").update(occupiedKey).digest("hex").slice(0, 8)}`,
    );

    mkdirSync(occupied);
    const blocked = await delegationWorktree(checkout, { agent: "duncan", key: occupiedKey });

    assert.equal(blocked?.path, undefined);
    assert.match(blocked?.error ?? "", /another folder/);
});

test("2 delegations to 1 repository work in 2 worktrees, and the task says where", async () => {
    // frostyard/nsl is Duncan's first repository: a real repository, so each delegation gets its own worktree.
    repository(repoA);

    const requests: string[] = [];
    const model = scriptedModel((ctx) => {
        const { text, role } = lastText(ctx as never);

        requests.push(JSON.stringify(ctx));

        if (role === "user" && text.endsWith("worktree test")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("team_delegate", {
                        agent: "duncan",
                        repository: "frostyard/nsl",
                        task: "Say hello. No tools needed.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    });
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    const app = await openApp(model);

    try {
        await app.setExtensionEnabled(owner(app), "team.ts", true);
        const id = await newSession(app);
        const odrade = (await roster(definitions)).find((each) => each.id === "odrade");

        assert(odrade, "the roster has Odrade");
        await app.harness.commit(async (tx) => {
            (await tx.doc(Identity, id)).persona = odrade;
        }, context);

        // Delegate once, and give back the folder the new linked session starts in.
        async function delegateOnce(): Promise<string> {
            const before = new Set(
                app
                    .sessions()
                    .filter((session) => session.linkedFrom?.id === Number(id))
                    .map((session) => session.id),
            );

            await say(app, id, "worktree test");
            await until(
                () =>
                    app
                        .sessions()
                        .some(
                            (session) =>
                                session.linkedFrom?.id === Number(id) && !before.has(session.id),
                        ),
                "the delegation",
                20_000,
            );
            const linked = app
                .sessions()
                .find(
                    (session) => session.linkedFrom?.id === Number(id) && !before.has(session.id),
                );

            assert(linked);
            await until(() => !app.isBusy(linked.id), "the delegated task settled", 20_000);

            return app.cwdOf(linked.id) ?? "";
        }

        const first = await delegateOnce();
        const second = await delegateOnce();
        const prefix = `${repoA}--duncan-`;

        for (const cwd of [first, second]) {
            assert.equal(cwd.startsWith(prefix), true, `${cwd} is a sibling of the checkout`);
            assert.match(cwd.slice(prefix.length), /^[0-9a-f]{8}$/);
            assert.equal(existsSync(cwd), true);
            assert.match(
                git(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim(),
                /^duncan\/[0-9a-f]{8}$/,
            );
        }

        assert.notEqual(first, second, "2 delegations to 1 repository get 2 folders");

        // The task tells the agent where it works, and where it must not work.
        const told = requests.join("\n");

        assert.match(told, /You work in your own git worktree at \S+ on branch duncan\//);
        assert.match(told, /you can rename the branch/);
        assert.match(told, /belongs to no task: do not work there/);
    } finally {
        await app.close();
    }
});

test("pickSupervisor: the newest bound session that the person sees, not archived first", () => {
    const bound = [
        { supervisor: 9, lastEventAt: 300, asks: 1 },
        { supervisor: 7, lastEventAt: 200, asks: 2 },
        { supervisor: 5, lastEventAt: 100, asks: 0 },
    ];
    const session = (id: number, archived = false) => ({ id, title: `S${id}`, archived });

    // The newest one that the person sees.
    assert.deepEqual(pickSupervisor(bound, [session(5), session(7)]), {
        id: 7,
        title: "S7",
        asks: 2,
        archived: false,
    });
    // An archived one gives way to an older one that is not archived.
    assert.equal(pickSupervisor(bound, [session(9, true), session(5)])?.id, 5);
    // Only archived ones: the newest of them, marked.
    assert.deepEqual(pickSupervisor(bound, [session(7, true), session(9, true)]), {
        id: 9,
        title: "S9",
        asks: 1,
        archived: true,
    });
    // None seen, or none bound: no session.
    assert.equal(pickSupervisor(bound, [session(1)]), undefined);
    assert.equal(pickSupervisor([], [session(1)]), undefined);
    // An app with no session list: the newest bound one.
    assert.equal(pickSupervisor(bound, undefined)?.id, 9);
});

test("teamMessageProblems: each limit, with the count, the limit and the fix; the limits stay", () => {
    assert.deepEqual(MESSAGE_LIMITS, {
        message: 6000,
        asks: 4,
        question: 500,
        options: { min: 2, max: 6 },
        option: 40,
    });
    const ok = {
        to: "s",
        message: "Done.",
        status: "done",
        asks: [{ question: "Merge?", options: ["yes", "no"] }],
    };

    assert.deepEqual(teamMessageProblems(ok), []);
    // At the limits exactly: no problem. Characters are code points, as the schema counts them.
    assert.deepEqual(
        teamMessageProblems({
            to: "s",
            message: "😀".repeat(6000),
            asks: Array.from({ length: 4 }, () => ({
                question: "q".repeat(500),
                options: Array.from({ length: 6 }, () => "o".repeat(40)),
            })),
        }),
        [],
    );
    // The 2 cases the audit found (2026-10-27): 1 question over 500 characters.
    assert.deepEqual(
        teamMessageProblems({ to: "s", message: "m", asks: [{ question: "q".repeat(538) }] }),
        [
            "asks[0].question has 538 characters; the limit is 500. Cut at least 38 characters: keep 1 decision on 1 line, with only the facts Brian needs to answer it; put the details in message.",
        ],
    );
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m".repeat(6523) }), [
        "message has 6523 characters; the limit is 6000. Cut at least 523 characters: keep the result and the facts the reader needs, and leave out logs and repeated details.",
    ]);
    assert.deepEqual(teamMessageProblems({ to: "s", message: "" }), [
        "message is empty: it needs 1 to 6000 characters.",
    ]);
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: "finished" }), [
        'status is "finished": use done, working or blocked.',
    ]);
    assert.deepEqual(
        teamMessageProblems({
            to: "s",
            message: "m",
            asks: Array.from({ length: 5 }, () => ({ question: "q" })),
        }),
        [
            "asks has 5 asks; the limit is 4. Merge related decisions, or send the others in a second team_message.",
        ],
    );
    assert.deepEqual(
        teamMessageProblems({
            to: "s",
            message: "m",
            asks: [
                { question: "q", options: ["only"] },
                { question: "q", options: ["1", "2", "3", "4", "5", "6", "7"] },
                { question: "q", options: ["yes", "o".repeat(41)] },
            ],
        }),
        [
            "asks[0].options has 1 choice; it needs 2 to 6. Leave options out when the ask is no pick-one.",
            "asks[1].options has 7 choices; it needs 2 to 6. Keep the main choices, or split the ask.",
            "asks[2].options[1] has 41 characters; the limit is 40. Cut at least 1 character: name the choice in a few words, and explain it in the question.",
        ],
    );
    // A done or blocked report says its asks, or asks: [] for none; a working one or a follow-up need not.
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: "done" }), [
        "asks is missing: a done report lists each decision for Brian in asks, or sends asks: [] when there is none.",
    ]);
    assert.deepEqual(
        teamMessageProblems({ to: "s", message: "m", status: "blocked", asks: null }),
        [
            "asks is missing: a blocked report lists each decision for Brian in asks, or sends asks: [] when there is none.",
        ],
    );
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: "done", asks: [] }), []);
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: "working" }), []);
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m" }), []);
    // A null optional is the validator's to drop, as before: no refusal.
    assert.deepEqual(teamMessageProblems({ to: "s", message: "m", status: null }), []);
    // A wrong type is the schema's to report.
    assert.deepEqual(teamMessageProblems({ message: 5, asks: "x", status: undefined }), []);
    assert.deepEqual(teamMessageProblems(null), []);
});
