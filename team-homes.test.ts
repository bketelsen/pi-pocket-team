// Agent homes: a folder for each named agent. The home in a profile, identity by folder, the home's prompt section,
// the guard on edit and write, team_work, and the home target of a delegation. Pi Pocket's helpers isolate all
// credentials, sessions, and model calls.
import {
    type App,
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
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "./_pocket/src/server/http.ts";
import { DeskThreads, threadOfSession } from "./desk.ts";
import { Identity, roster, taskTarget, type TeamApi } from "./team.ts";

const definitions = join(root, "agents");
const repoA = join(root, "nsl");
const repoB = join(root, "igloo");
const homeDuncan = join(root, "homes", "duncan");
const homeTwin = join(root, "homes", "twin");
const homeMoneo = join(root, "homes", "moneo");
const homeLeto = join(root, "homes", "leto");
// The sibling worktree a delegation of frostyard/nsl would get: never a target from a home.
const sibling = join(root, "nsl--duncan-deadbeef");

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

/** One git command in a test folder. */
const git = (folder: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd: folder, env: gitEnv, encoding: "utf8" }).trim();

/** A folder with 1 commit. */
function repository(folder: string): void {
    mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q");
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

const tool = (name: string, args: object) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** The newest model request, system prompt and all: the prompt section is there, not in the conversation. */
let requestContext = "";

/** What the model says for a message: the test's 1 tool call, or an echo. */
const model = scriptedModel((ctx) => {
    const { text, role } = lastText(ctx as never);

    requestContext = JSON.stringify(ctx);

    if (role !== "user") {
        return fauxAssistantMessage([fauxText(`echo: ${text.slice(0, 40)}`)]);
    }

    if (text.endsWith("guard-repo")) {
        return tool("write", { path: join(repoA, "blocked.txt"), content: "no\n" });
    }

    if (text.endsWith("guard-worktree")) {
        return tool("write", { path: join(sibling, "blocked.txt"), content: "no\n" });
    }

    if (text.endsWith("guard-home")) {
        return tool("write", { path: "notes/allowed.txt", content: "mine\n" });
    }

    if (text.endsWith("work-test")) {
        return tool("team_work", {
            repository: "frostyard/nsl",
            task: "Say hello. No tools needed.",
            title: "First job",
        });
    }

    if (text.endsWith("work-named")) {
        return tool("team_work", { repository: "frostyard/igloo", task: "Say hello again." });
    }

    if (text.endsWith("work-unknown")) {
        return tool("team_work", { repository: "someone/else", task: "Try another repository." });
    }

    if (text.endsWith("delegate-code")) {
        return tool("team_delegate", {
            agent: "duncan",
            repository: "frostyard/nsl",
            task: "Say hello. No tools needed.",
        });
    }

    if (text.endsWith("delegate-home")) {
        return tool("team_delegate", {
            agent: "duncan",
            repository: "home",
            task: "Plan the suite at your home.",
        });
    }

    if (text.endsWith("delegate-moneo")) {
        return tool("team_delegate", { agent: "moneo", task: "Plan the NAS notes." });
    }

    if (text.endsWith("work-linked")) {
        return tool("team_work", {
            repository: "frostyard/nsl",
            task: "Try this from a linked session.",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text.slice(0, 40)}`)]);
});

let app: App;
let server: ReturnType<typeof createServer> | undefined;
let base = "";

before(async () => {
    process.env.PI_POCKET_TEAM_AGENTS = definitions;
    mkdirSync(definitions, { recursive: true });
    repository(repoA);
    mkdirSync(repoB, { recursive: true });
    writeFileSync(join(repoA, "AGENTS.md"), "# nsl\nRules for nsl.\n");
    writeFileSync(join(repoB, "AGENTS.md"), "# igloo\nRules for igloo.\n");

    for (const home of [homeDuncan, homeTwin, homeMoneo, homeLeto]) {
        mkdirSync(home, { recursive: true });
    }

    writeFileSync(
        join(definitions, "odrade.md"),
        "---\nmodel: faux/faux-2\nrole: supervisor\n---\n# Odrade\nYou are Odrade. Coordinate the team.",
    );
    writeFileSync(
        join(definitions, "leto.md"),
        `---\nrole: supervisor\nhome: ${homeLeto}\n---\n# Leto\nYou are Leto. Own the team from your home.`,
    );
    writeFileSync(
        join(definitions, "duncan.md"),
        `---\nmodel: faux/faux-2\nhome: ${homeDuncan}\nrepositories:\n  frostyard/nsl: ${repoA}\n  frostyard/igloo: ${repoB}\n---\n# Duncan Idaho\nYou are Duncan Idaho. Own the test repositories.`,
    );
    writeFileSync(
        join(definitions, "moneo.md"),
        `---\nhome: ${homeMoneo}\n---\n# Moneo\nYou are Moneo. Plan at your home.`,
    );
    // 2 agents with 1 home: the folder gives neither of them.
    writeFileSync(
        join(definitions, "gurney.md"),
        `---\nhome: ${homeTwin}\n---\n# Gurney Halleck\nYou are Gurney Halleck.`,
    );
    writeFileSync(
        join(definitions, "thufir.md"),
        `---\nhome: ${homeTwin}\n---\n# Thufir Hawat\nYou are Thufir Hawat.`,
    );
    // A home written with ~/ is expanded, and read no further.
    writeFileSync(
        join(definitions, "irulan.md"),
        "---\nhome: ~/agents/irulan\n---\n# Irulan\nYou are Irulan.",
    );

    // The desk opens a thread for each delegation. It reads only the fixtures: no real config, no GitHub.
    const configPath = join(root, "desk.json");
    const fakeGh = join(root, "gh");
    const fixture = join(root, "gh.json");

    writeFileSync(fixture, JSON.stringify({ data: { viewer: { login: "test-viewer" } } }));
    writeFileSync(fakeGh, `#!/bin/sh\ncat ${JSON.stringify(fixture)}\n`);
    chmodSync(fakeGh, 0o755);
    writeFileSync(configPath, JSON.stringify({ digest: { minutes: 0 }, cap: 100 }));
    process.env.PI_POCKET_DESK_GH = fakeGh;
    process.env.PI_POCKET_DESK_CONFIG = configPath;

    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "team.ts"), join(dropIns, "team.ts"));
    cpSync(join(import.meta.dirname, "team-web"), join(dropIns, "team-web"), { recursive: true });
    cpSync(join(import.meta.dirname, "desk.ts"), join(dropIns, "desk.ts"));
    cpSync(join(import.meta.dirname, "desk-web"), join(dropIns, "desk-web"), { recursive: true });
    app = await openApp(model);
    await app.setExtensionEnabled(owner(app), "team.ts", true);
    await app.setExtensionEnabled(owner(app), "desk.ts", true);

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/team/`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await app?.close();
    cleanUp();
});

/** 1 call of the Team module's routes, as the owner. */
async function call(path: string, body?: object) {
    const res = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

    return { status: res.status, data: await res.json() };
}

type Agent = {
    id: string;
    name: string;
    role: string;
    home?: string;
    repositories: Record<string, string>;
};

const persona = async (id: string) => {
    const agent = (await roster(definitions)).find((each) => each.id === id);

    assert(agent, `the roster has ${id}`);

    return agent;
};

/** A new session in `folder` that carries `agent`'s identity, as the Team page sets it. */
async function sessionAs(agent: string, folder: string): Promise<ConversationId> {
    const id = await newSession(app, folder);

    await app.harness.commit(async (tx) => {
        (await tx.doc(Identity, id)).persona = await persona(agent);
    }, context);

    return id;
}

const said = async (id: ConversationId) => (await modelTexts(app, id)).join("\n");

const deskState = () => app.harness.snapshot(DeskThreads, context);

const linkedTo = (id: ConversationId) =>
    app.sessions().filter((each) => each.linkedFrom?.id === Number(id));

/** Send `text` to `source` and give back the linked session it started, settled. */
async function nextLinked(source: ConversationId, text: string) {
    const before = new Set(linkedTo(source).map((each) => each.id));

    await say(app, source, text);
    await until(
        () => linkedTo(source).some((each) => !before.has(each.id)),
        `the linked session for ${text}`,
        20_000,
    );
    const linked = linkedTo(source).find((each) => !before.has(each.id))!;

    await until(() => !app.isBusy(linked.id), `${text} settled`, 20_000);

    return linked;
}

test("the roster reads home, absolute or from ~/, and the Team API gives it", async () => {
    const agents = await roster(definitions);
    const of = (id: string) => agents.find((each) => each.id === id)!;

    assert.equal(of("duncan").home, homeDuncan);
    assert.equal(of("moneo").home, homeMoneo);
    assert.equal(of("odrade").home, undefined);
    assert.equal(of("irulan").home, join(homedir(), "agents", "irulan"), "~/ is expanded");

    const team = (globalThis as unknown as Record<symbol, TeamApi | undefined>)[
        Symbol.for("pi-pocket-team.team")
    ];

    assert(team, "the module publishes its API");
    const listed = (await team.roster()) as Agent[];

    assert.equal(listed.find((each) => each.id === "duncan")?.home, homeDuncan);
    assert.deepEqual(listed.find((each) => each.id === "duncan")?.repositories, {
        "frostyard/nsl": repoA,
        "frostyard/igloo": repoB,
    });
});

test("a session in a home is its agent: explicit wins, a clear wins, and 2 agents with 1 home give none", async () => {
    const inside = await newSession(app, homeDuncan);
    const seen = (await call(`session/${inside}`)).data;

    assert.equal(seen.identity.id, "duncan", "the folder gives the identity");
    assert.equal(seen.implicit, true);

    // A chosen identity wins over the folder, and it is no longer implicit.
    await call(`session/${inside}/identity`, { agent: "odrade" });
    const chosen = (await call(`session/${inside}`)).data;

    assert.equal(chosen.identity.id, "odrade");
    assert.equal(chosen.implicit, undefined);

    // Clear stores an explicit none: the folder must not bring Duncan back.
    await call(`session/${inside}/identity`, { agent: null });
    const cleared = (await call(`session/${inside}`)).data;

    assert.equal(cleared.identity, null);
    assert.equal((await app.harness.snapshot(Identity, inside, context))?.cleared, true);
    await say(app, inside, "Hello");
    assert.doesNotMatch(await said(inside), /You are Duncan Idaho/);

    // The command clears the same way, and choosing again deletes the none.
    const commandId = app.webs.commands().find((each) => each.name === "team-agent")?.id;

    await app.extensionCommands.run(inside, owner(app), {
        commandId,
        args: "duncan",
        requestId: crypto.randomUUID(),
    });
    assert.equal((await app.harness.snapshot(Identity, inside, context))?.cleared, undefined);
    assert.equal((await call(`session/${inside}`)).data.identity.id, "duncan");
    await app.extensionCommands.run(inside, owner(app), {
        commandId,
        args: "clear",
        requestId: crypto.randomUUID(),
    });
    assert.equal((await call(`session/${inside}`)).data.identity, null);

    // 2 agents with 1 home: the folder gives none of them.
    const twin = await newSession(app, homeTwin);

    assert.equal((await call(`session/${twin}`)).data.identity, null);
    // A folder that is nobody's home gives none either.
    const outside = await newSession(app, work);

    assert.equal((await call(`session/${outside}`)).data.identity, null);
    assert.equal((await call(`session/${outside}`)).data.implicit, undefined);
});

test("the section names the home and the repositories, and the home rules only in the home", async () => {
    const inside = await sessionAs("duncan", homeDuncan);

    await say(app, inside, "Hello");
    const home = requestContext;

    assert.match(home, /Your home: /);
    assert.match(home, new RegExp(`Your home: ${homeDuncan.replaceAll("/", "\\/")}`));
    assert.match(home, /Your repositories:/);
    assert.match(home, new RegExp(`frostyard/nsl: ${repoA.replaceAll("/", "\\/")}`));
    assert.match(home, new RegExp(`rules: ${join(repoA, "AGENTS.md").replaceAll("/", "\\/")}`));
    assert.match(home, /Never change a repository from your home: start the work with team_work/);
    assert.match(home, /Read a repository's AGENTS\.md before you answer about it/);
    assert.doesNotMatch(home, /Rules for nsl/, "a path, never a file's contents");

    // The same agent outside its home: the places are there, the home rules are not.
    const outside = await sessionAs("duncan", work);

    await say(app, outside, "Hello");
    const away = requestContext;

    assert.match(away, /Your home: /);
    assert.match(away, /Your repositories:/);
    assert.doesNotMatch(away, /Never change a repository from your home/);

    // The supervisor's roster shows each member's home.
    const supervisor = await sessionAs("odrade", work);

    await say(app, supervisor, "Hello");
    const rosterText = requestContext;

    assert.match(
        rosterText,
        new RegExp(`duncan: Duncan Idaho[\\s\\S]*Home: ${homeDuncan.replaceAll("/", "\\/")}`),
    );
    assert.match(
        rosterText,
        new RegExp(`moneo: Moneo[\\s\\S]*Home: ${homeMoneo.replaceAll("/", "\\/")}`),
    );
});

test("the guard blocks edit and write into a repository and a sibling worktree, and allows the home", async () => {
    const inside = await sessionAs("duncan", homeDuncan);

    await say(app, inside, "guard-repo");
    await say(app, inside, "guard-worktree");
    await say(app, inside, "guard-home");
    const told = await said(inside);

    assert.equal(existsSync(join(repoA, "blocked.txt")), false, "the repository is untouched");
    assert.equal(existsSync(join(sibling, "blocked.txt")), false, "the worktree is untouched");
    assert.equal(
        existsSync(join(homeDuncan, "notes", "allowed.txt")),
        true,
        "the home is the agent's",
    );
    assert.match(told, /Do not change frostyard\/nsl from a home session/);
    assert.match(told, /start a repository session with team_work/);
    assert.equal((told.match(/Do not change/g) ?? []).length, 2, "the home write was no block");

    // A session in a repository is no home: its writes are its own.
    const checkout = await newSession(app, repoA);

    await say(app, checkout, "guard-repo");
    assert.equal(existsSync(join(repoA, "blocked.txt")), true);
});

test("team_work starts a worktree session for the agent, on its profile model when allowed", async () => {
    const inside = await sessionAs("duncan", homeDuncan);
    const before = app.sessions().length;
    const linked = await nextLinked(inside, "work-test");
    const cwd = app.cwdOf(linked.id) ?? "";
    const prefix = `${repoA}--duncan-`;

    assert.equal(app.sessions().length, before + 1, "1 session, not 2");
    assert.equal(cwd.startsWith(prefix), true, `${cwd} is a sibling of the main checkout`);
    assert.match(cwd.slice(prefix.length), /^[0-9a-f]{8}$/);
    assert.match(git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), /^duncan\/[0-9a-f]{8}$/);
    assert.equal((await app.harness.snapshot(Identity, linked.id, context))?.persona?.id, "duncan");
    assert.match(await said(inside), /Report back here with team_message/);
    assert.match(await said(inside), /remove the worktree/);

    // Duncan's model is not in the owner's allowed list: the session runs on the source's model.
    const first = (await app.agentState(linked.id))?.model;

    assert.equal(`${first?.provider}/${first?.modelId}`, "faux/faux-1");

    // The owner allows it: the next work session runs on Duncan's own model.
    await app.setSubagentModels(owner(app), ["faux/faux-2"]);

    const secondLinked = await nextLinked(inside, "work-named");
    const second = (await app.agentState(secondLinked.id))?.model;

    assert.equal(`${second?.provider}/${second?.modelId}`, "faux/faux-2", "the profile model");
    // frostyard/igloo is no git work tree's top: the session works in the folder itself.
    assert.equal(app.cwdOf(secondLinked.id), repoB);
    await app.setSubagentModels(owner(app), []);

    // The refusals: another role, a folder outside the home, an unknown repository.
    const supervisor = await sessionAs("odrade", work);

    await say(app, supervisor, "work-test");
    assert.match(
        await said(supervisor),
        /team_work works for an agent in its own home\. Odrade is the supervisor/,
    );

    const away = await sessionAs("duncan", work);

    await say(app, away, "work-test");
    assert.match(await said(away), /is not inside Duncan Idaho's home/);

    const unknown = await sessionAs("duncan", homeDuncan);

    await say(app, unknown, "work-unknown");
    assert.match(await said(unknown), /Duncan Idaho owns: frostyard\/nsl, frostyard\/igloo\./);
});

test("a delegation to home makes no worktree and opens a thread with no repository", async () => {
    const supervisor = await sessionAs("leto", homeLeto);

    // Code work from a supervisor's home session still gets the repository's worktree.
    const code = await nextLinked(supervisor, "delegate-code");

    assert.equal((app.cwdOf(code.id) ?? "").startsWith(`${repoA}--duncan-`), true);
    const codeThread = threadOfSession(await deskState(), Number(code.id));

    assert(codeThread, "the code delegation has a thread");
    assert.equal(codeThread.repo, "frostyard/nsl");

    // repository: "home": the agent's home itself, no worktree, and a thread with no repository.
    const home = await nextLinked(supervisor, "delegate-home");

    assert.equal(app.cwdOf(home.id), homeDuncan);
    assert.equal(existsSync(`${homeDuncan}--duncan-`), false, "a home never gets a worktree");
    const homeThread = threadOfSession(await deskState(), Number(home.id));

    assert(homeThread, "the home delegation has a thread");
    assert.equal(homeThread.repo, undefined, "a home thread has no repository");
    assert.equal(homeThread.cwd, homeDuncan);

    // An agent with no repository, no workspace and a home starts at the home.
    const moneo = await nextLinked(supervisor, "delegate-moneo");

    assert.equal(app.cwdOf(moneo.id), homeMoneo);

    // The Team page's own start route takes the same home target.
    const started = await call(`session/${supervisor}/start`, {
        agent: "duncan",
        repository: "home",
        message: "Use your home",
        key: "home-route-0001",
    });

    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(app.cwdOf(started.data.session), homeDuncan);
    await until(
        () => !app.isBusy(started.data.session as ConversationId),
        "the route task settled",
    );
});

test("team_work in a linked session is refused, and leaves no worktree and no branch", async () => {
    const supervisor = await sessionAs("leto", homeLeto);
    // A linked session at Duncan's home: its folder passes the home check, so Pi Pocket is the one that refuses.
    const home = await nextLinked(supervisor, "delegate-home");
    const folders = () =>
        readdirSync(root)
            .filter((each) => each.startsWith("nsl--duncan-"))
            .sort();
    const branches = () =>
        git(repoA, "branch", "--list", "duncan/*")
            .split("\n")
            .map((line) => line.replace(/^\*\s*/, "").trim())
            .filter((line) => line !== "")
            .sort();
    const before = { folders: folders(), branches: branches() };

    assert.equal(app.cwdOf(home.id as ConversationId), homeDuncan);
    await say(app, home.id as ConversationId, "work-linked");
    assert.match(
        await said(home.id as ConversationId),
        /team_work works only in a top-level session\. Report the plan to the session that started you\./,
    );
    assert.deepEqual(
        { folders: folders(), branches: branches() },
        before,
        "the refused start left no worktree and no branch",
    );
    assert.equal(branches().length, before.branches.length);
});

test("taskTarget offers home as a choice, and the errors say what is there", () => {
    const duncan = {
        id: "duncan",
        name: "Duncan Idaho",
        role: "agent" as const,
        model: "",
        instructions: "",
        repositories: { "frostyard/nsl": repoA, "frostyard/igloo": repoB },
        home: homeDuncan,
    };
    const noHome = { ...duncan, home: undefined };

    assert.deepEqual(taskTarget(duncan, "home"), { folder: homeDuncan, home: true });
    assert.deepEqual(taskTarget(duncan, "frostyard/igloo"), {
        folder: repoB,
        repo: "frostyard/igloo",
    });
    assert.throws(
        () => taskTarget(duncan),
        /Choose one of Duncan Idaho's repositories: .*, home\./,
    );
    assert.throws(() => taskTarget(noHome, "home"), /has no home in its profile/);
    assert.deepEqual(taskTarget({ ...noHome, repositories: {} }), {});
    assert.deepEqual(taskTarget({ ...noHome, repositories: {}, home: homeMoneo }), {
        folder: homeMoneo,
        home: true,
    });
    assert.deepEqual(taskTarget({ ...duncan, repositories: {}, workspace: join(root, "space") }), {
        folder: join(root, "space"),
    });
    assert.throws(
        () => taskTarget(duncan, "someone/else"),
        /works in: frostyard\/nsl, frostyard\/igloo, home\./,
    );
});
