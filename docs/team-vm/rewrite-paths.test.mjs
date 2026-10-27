// The step 6 path rewrite of docs/team-vm-cutover.md, on a fixture home: what it changes, what it keeps, and that a
// second run changes nothing. The profiles it writes must read back through team.ts's roster().
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { roster } from "../../team.ts";

const SCRIPT = fileURLToPath(new URL("./rewrite-paths.mjs", import.meta.url));
const OLD = "/var/home/bjk";

const profile = (front, body) => `---\n${front}\n---\n\n${body}\n`;

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "rewrite-paths-"));
    const agents = join(root, ".config/pi-pocket-team/agents");

    await mkdir(agents, { recursive: true });
    await mkdir(join(root, ".pi/agent/prompts"), { recursive: true });
    await mkdir(join(root, ".pi/agent/sessions"), { recursive: true });
    await mkdir(join(root, "agents/odrade/plans"), { recursive: true });
    await mkdir(join(root, "agents/odrade/reports"), { recursive: true });
    await mkdir(join(root, ".pi-pocket"), { recursive: true });
    await writeFile(
        join(agents, "odrade.md"),
        profile(
            `model: m\nrole: supervisor\nworkspace: ${OLD}/projects/odrade`,
            `# Odrade\n\nDesk at ${OLD}/projects/odrade/desk.`,
        ),
    );
    await writeFile(
        join(agents, "clerk.md"),
        profile(`role: clerk\nmodel: m\nworkspace: ${OLD}/projects/odrade`, "# Clerk"),
    );
    await writeFile(
        join(agents, "moneo.md"),
        profile(`model: m\nrole: agent\nworkspace: ${OLD}/projects/truenas-mcp`, "# Moneo"),
    );
    await writeFile(
        join(agents, "teg.md"),
        profile(
            `model: m\nrole: agent\nrepositories:\n  bketelsen/fleet: ${OLD}/projects/fleet`,
            "# Miles Teg\n\nUse ssh bjk@10.0.1.175.",
        ),
    );
    await writeFile(
        join(root, ".config/pi-pocket-team/desk.json"),
        JSON.stringify({ authors: ["a"], export: `${OLD}/projects/odrade/desk` }),
    );
    await writeFile(
        join(root, ".pi/agent/prompts/cross-review.md"),
        `Read \`${OLD}/.pi/agent/skills/cross-review/SKILL.md\`.\n`,
    );
    await writeFile(
        join(root, ".pi/agent/trust.json"),
        JSON.stringify({ [`${OLD}/projects/frostyard`]: true }),
    );
    await writeFile(join(root, ".pi/agent/sessions/old.jsonl"), `${OLD}/history\n`);
    await writeFile(join(root, "agents/odrade/AGENTS.md"), `Desk: ${OLD}/projects/odrade\n`);
    await writeFile(join(root, "agents/odrade/plans/day.md"), `cd ${OLD}/projects/fleet\n`);
    await writeFile(join(root, "agents/odrade/reports/old.md"), `${OLD}/projects/x\n`);
    await writeFile(join(root, ".pi-pocket/pocket.sqlite"), `not a database ${OLD}\n`);

    return root;
}

const run = (root, ...args) =>
    execFileSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });

test("the rewrite moves every active path, keeps history and the database, and runs twice safely", async () => {
    const root = await fixture();

    try {
        const read = (path) => readFile(join(root, path), "utf8");
        const preview = run(root, "--check");

        assert.match(preview, /would change: 9 file\(s\)/);
        assert.match(await read(".config/pi-pocket-team/agents/odrade.md"), /\/var\/home\/bjk/);

        assert.match(run(root), /changed: 9 file\(s\)\n[\s\S]*REWRITE OK/);

        const odrade = await read(".config/pi-pocket-team/agents/odrade.md");

        assert.match(odrade, /^home: ~\/agents\/odrade$/m);
        assert.doesNotMatch(odrade, /^workspace:/m);
        assert.match(odrade, /Desk at ~\/agents\/odrade\/desk\./);
        assert.match(
            await read(".config/pi-pocket-team/agents/clerk.md"),
            /^workspace: ~\/agents\/odrade$/m,
        );
        assert.doesNotMatch(await read(".config/pi-pocket-team/agents/clerk.md"), /^home:/m);
        assert.match(
            await read(".config/pi-pocket-team/agents/moneo.md"),
            /^repositories:\n {2}bketelsen\/truenas-mcp: ~\/projects\/truenas-mcp\nhome: ~\/agents\/moneo$/m,
        );
        assert.match(await read(".config/pi-pocket-team/agents/teg.md"), /ssh bjk@10\.0\.1\.175/);
        assert.equal(
            JSON.parse(await read(".config/pi-pocket-team/desk.json")).export,
            "/var/home/team/agents/odrade/desk",
        );
        assert.deepEqual(JSON.parse(await read(".pi/agent/trust.json")), {
            "/var/home/team/projects/frostyard": true,
        });
        assert.match(
            await read(".pi/agent/prompts/cross-review.md"),
            /\/var\/home\/team\/\.pi\/agent\/skills/,
        );
        assert.equal(await read("agents/odrade/AGENTS.md"), "Desk: /var/home/team/agents/odrade\n");
        assert.equal(
            await read("agents/odrade/plans/day.md"),
            "cd /var/home/team/projects/fleet\n",
        );

        // History, the database and Pi CLI sessions stay as they were; .bak keeps the first original.
        assert.equal(await read("agents/odrade/reports/old.md"), `${OLD}/projects/x\n`);
        assert.equal(await read(".pi-pocket/pocket.sqlite"), `not a database ${OLD}\n`);
        assert.equal(await read(".pi/agent/sessions/old.jsonl"), `${OLD}/history\n`);
        assert.match(await read(".config/pi-pocket-team/agents/odrade.md.bak"), /workspace: \/var/);
        await assert.rejects(readFile(join(root, "agents/odrade/plans/day.md.bak")));

        assert.match(run(root), /changed: 0 file\(s\)\nREWRITE OK/);
        assert.match(await read(".config/pi-pocket-team/agents/odrade.md.bak"), /workspace: \/var/);

        const agents = Object.fromEntries(
            (await roster(join(root, ".config/pi-pocket-team/agents"))).map((a) => [a.id, a]),
        );
        const home = (path) => join(process.env.HOME ?? "", path);

        assert.equal(agents.odrade.home, home("agents/odrade"));
        assert.equal(agents.clerk.workspace, home("agents/odrade"));
        assert.deepEqual(agents.moneo.repositories, {
            "bketelsen/truenas-mcp": home("projects/truenas-mcp"),
        });
        assert.equal(agents.teg.repositories["bketelsen/fleet"], home("projects/fleet"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a file it cannot rewrite is named, and the run fails", async () => {
    const root = await fixture();

    try {
        await writeFile(join(root, ".pi/agent/models.json"), JSON.stringify({ path: OLD }));

        assert.throws(
            () => run(root),
            (error) =>
                error.status === 1 &&
                /LEFT naming \/var\/home\/bjk: 1 file\(s\)\n {2}\.pi\/agent\/models\.json/.test(
                    error.stdout,
                ),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
