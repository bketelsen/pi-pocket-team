// The desk file route, `GET file?path=…`: the pure path rule (the same as the Desk page's tap targets), then the
// owner-only route in Pocket's test harness, on a temporary export folder. Nothing reads Brian's data, and nothing goes
// to GitHub.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    appendFileSync,
    cpSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createHandler } from "./_pocket/src/server/http.ts";
import { DESK_FILE_MAX, DeskThreads, deskFileTarget, isDeskPath, readDeskFile } from "./desk.ts";
import { deskPath } from "./desk-web/ask-text.js";

/** Paths both rules must judge the same. */
const CASES: [string, boolean][] = [
    ["reports/2026-11-05-intake-go-live/502-check.md", true],
    ["desk/T1.md", true],
    ["plans/T560/plan.md", true],
    ["decisions/0001_x.md", true],
    ["reports/../x.md", false],
    ["reports/./x.md", false],
    ["/etc/passwd.md", false],
    ["reports/.hidden.md", false],
    ["reports/x.txt", false],
    ["reports/x.md/", false],
    ["reports//x.md", false],
    ["other/x.md", false],
    ["reports", false],
    ["reports/x y.md", false],
    ["reports\\x.md", false],
    [`reports/${"a".repeat(195)}.md`, false],
    ["", false],
];

describe("the desk path rule", () => {
    test("isDeskPath and the page's deskPath agree on each case", () => {
        for (const [path, good] of CASES) {
            assert.equal(isDeskPath(path), good, `isDeskPath(${JSON.stringify(path)})`);
            assert.equal(deskPath(path), good, `deskPath(${JSON.stringify(path)})`);
        }
    });

    test("deskFileTarget: the root is the export's parent; a bad path is a 400; no export is a 404", () => {
        assert.deepEqual(deskFileTarget("/x/odrade/desk", "reports/a.md"), {
            root: "/x/odrade",
            file: "/x/odrade/reports/a.md",
        });
        assert.deepEqual(deskFileTarget("/x/odrade/desk/", "desk/T1.md"), {
            root: "/x/odrade",
            file: "/x/odrade/desk/T1.md",
        });
        assert.equal(
            (deskFileTarget("/x/odrade/desk", "../a.md") as { status: number }).status,
            400,
        );
        assert.equal((deskFileTarget("/x/odrade/desk", 3) as { status: number }).status, 400);
        assert.equal((deskFileTarget(undefined, "reports/a.md") as { status: number }).status, 404);
        assert.equal(
            (deskFileTarget("rel/desk", "reports/a.md") as { status: number }).status,
            404,
        );
    });
});

describe("readDeskFile: a writer that swaps the file between the checks and the read", () => {
    const base = join(root, "race");
    const home = join(base, "odrade");
    const away = join(base, "away");
    let count = 0;

    /** A fresh root with `reports/sub/x.md`, and an outside folder with a file of the same name. */
    const fresh = () => {
        count += 1;
        const at = join(home, String(count));

        mkdirSync(join(at, "reports", "sub"), { recursive: true });
        mkdirSync(join(away, String(count)), { recursive: true });
        writeFileSync(join(at, "reports", "sub", "x.md"), "inside");
        writeFileSync(join(away, String(count), "x.md"), "secret");

        return { at, file: join(at, "reports", "sub", "x.md"), out: join(away, String(count)) };
    };

    test("a good file reads; the hooks change nothing", async () => {
        const { at, file } = fresh();

        assert.deepEqual(await readDeskFile(at, file), { text: "inside" });
    });

    test("the file swapped for a symlink out of the root before the open: refused, no outside text", async () => {
        const { at, file, out } = fresh();
        const read = await readDeskFile(at, file, {
            beforeOpen: () => {
                rmSync(file);
                symlinkSync(join(out, "x.md"), file);
            },
        });

        assert.equal((read as { status: number }).status, 400);
        assert.ok(!("text" in read));
    });

    test("a folder above the file swapped for a symlink out of the root before the open: refused", async () => {
        const { at, file, out } = fresh();
        const read = await readDeskFile(at, file, {
            beforeOpen: () => {
                renameSync(join(at, "reports", "sub"), join(at, "reports", "old"));
                symlinkSync(out, join(at, "reports", "sub"));
            },
        });

        assert.equal((read as { status: number }).status, 400);
        assert.ok(!("text" in read));
    });

    test("the check follows the descriptor, not the name: the name moved after the open still reads the opened file", async () => {
        const { at, file, out } = fresh();
        const read = await readDeskFile(at, file, {
            afterOpen: () => {
                renameSync(file, `${file}.old`);
                symlinkSync(join(out, "x.md"), file);
            },
        });

        assert.deepEqual(read, { text: "inside" });
    });

    test("an outside file opened, then an inside file put back at the name before the checks: refused", async () => {
        const { at, file, out } = fresh();
        const read = await readDeskFile(at, file, {
            beforeOpen: () => {
                renameSync(file, `${file}.old`);
                symlinkSync(join(out, "x.md"), file);
            },
            afterOpen: () => {
                rmSync(file);
                writeFileSync(file, "inside again");
            },
        });

        assert.equal((read as { status: number }).status, 400);
        assert.ok(!("text" in read));
    });

    test("an opened file that is deleted before the checks is refused", async () => {
        const { at, file } = fresh();
        const read = await readDeskFile(at, file, { afterOpen: () => rmSync(file) });

        assert.equal((read as { status: number }).status, 400);
    });

    test("the file swapped for a FIFO before the open: a 404 at once, the open does not block", async () => {
        const { at, file } = fresh();
        const read = await readDeskFile(at, file, {
            beforeOpen: () => {
                rmSync(file);
                execFileSync("mkfifo", [file]);
            },
        });

        assert.equal((read as { status: number }).status, 404);
    });

    test("a file that grows past the limit after the size check is a 413, and at most the limit + 1 byte is read", async () => {
        const { at, file } = fresh();
        let consumed = 0;
        // The real open, with a handle that counts every byte that `read` and `readFile` give back.
        const counting = (async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);

            return new Proxy(handle, {
                get(target, key) {
                    if (key === "read") {
                        return async (...rest: unknown[]) => {
                            const done = await (
                                target.read as (...a: unknown[]) => Promise<{ bytesRead: number }>
                            )(...rest);

                            consumed += done.bytesRead;

                            return done;
                        };
                    }

                    if (key === "readFile") {
                        return async (...rest: unknown[]) => {
                            const bytes = await (
                                target.readFile as (...a: unknown[]) => Promise<Buffer>
                            )(...rest);

                            consumed += bytes.length;

                            return bytes;
                        };
                    }

                    const value = Reflect.get(target, key, target) as unknown;

                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
        }) as typeof open;
        const read = await readDeskFile(at, file, {
            open: counting,
            beforeRead: () => {
                appendFileSync(file, "x".repeat(4 * DESK_FILE_MAX));
            },
        });

        assert.equal((read as { status: number }).status, 413);
        assert.ok(consumed <= DESK_FILE_MAX + 1, `read ${String(consumed)} bytes`);
    });
});

describe("GET file in Pocket", () => {
    const dataDir = join(root, "file-data");
    const fakeGh = join(root, "file-gh");
    const ghCalls = join(root, "file-gh-calls");
    const configPath = join(root, "file-desk.json");
    const odrade = join(root, "file-agents", "odrade");
    const outside = join(root, "file-outside");
    let app: App;
    let server: Server | undefined;
    let base = "";
    let viewer = "";

    const get = async (path: string, token?: string | null) => {
        const response = await fetch(base + path, {
            headers: {
                ...(token === null
                    ? {}
                    : { authorization: `Bearer ${token ?? app.config.ownerToken}` }),
                "x-pocket": "1",
            },
        });

        return {
            status: response.status,
            data: (await response.json().catch(() => ({}))) as {
                path?: string;
                text?: string;
                error?: string;
            },
        };
    };

    const file = (path: string) => get(`file?path=${encodeURIComponent(path)}`);
    const withExport = (on: boolean) =>
        writeFileSync(
            configPath,
            JSON.stringify({
                digest: { minutes: 0 },
                ...(on ? { export: join(odrade, "desk") } : {}),
            }),
        );

    before(async () => {
        const dropIns = join(dataDir, "extensions");

        mkdirSync(dropIns, { recursive: true });

        for (const each of [
            "desk.ts",
            "_desk-usage.ts",
            "_desk-dashboard.ts",
            "_desk-metrics.ts",
        ]) {
            cpSync(join(import.meta.dirname, each), join(dropIns, each));
        }

        cpSync(join(import.meta.dirname, "desk-web"), join(dropIns, "desk-web"), {
            recursive: true,
        });
        writeFileSync(fakeGh, `#!/bin/sh\necho call >> ${JSON.stringify(ghCalls)}\nexit 1\n`, {
            mode: 0o755,
        });
        writeFileSync(ghCalls, "");

        // The export folder and the desk files beside it, and a file outside the root that a symlink points to.
        mkdirSync(join(odrade, "desk"), { recursive: true });
        mkdirSync(join(odrade, "reports", "2026-11-05-go-live"), { recursive: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(
            join(odrade, "reports", "2026-11-05-go-live", "502-check.md"),
            "# 502\n\nAll good.\n",
        );
        writeFileSync(join(odrade, "reports", "big.md"), "x".repeat(DESK_FILE_MAX + 1));
        writeFileSync(join(odrade, "reports", "edge.md"), "y".repeat(DESK_FILE_MAX));
        writeFileSync(join(outside, "secret.md"), "secret");
        writeFileSync(join(odrade, "reports", "notes.txt"), "text");
        writeFileSync(join(odrade, "reports", ".hidden.md"), "hidden");
        symlinkSync(join(outside, "secret.md"), join(odrade, "reports", "out.md"));
        symlinkSync(outside, join(odrade, "decisions"));
        mkdirSync(join(odrade, "plans", "dir.md"), { recursive: true });

        process.env.PI_POCKET_DESK_GH = fakeGh;
        process.env.PI_POCKET_DESK_CONFIG = configPath;
        withExport(true);

        app = await openApp(scriptedModel(), dataDir);
        await app.setExtensionEnabled(owner(app), "desk.ts", true);
        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/desk/`;
        viewer = app.config.addUser("Vic", "viewer").token;
    });

    after(async () => {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        await app?.close();
        cleanUp();
    });

    test("a good file: its path and text; no gh call and no document change", async () => {
        const before = JSON.stringify(await app.harness.snapshot(DeskThreads, context));
        const calls = readFileSync(ghCalls, "utf8");
        const { status, data } = await file("reports/2026-11-05-go-live/502-check.md");

        assert.equal(status, 200, JSON.stringify(data));
        assert.deepEqual(data, {
            path: "reports/2026-11-05-go-live/502-check.md",
            text: "# 502\n\nAll good.\n",
        });
        assert.equal((await file("reports/edge.md")).status, 200, "256 KB exactly is read");
        assert.equal(readFileSync(ghCalls, "utf8"), calls, "no gh call");
        assert.equal(
            JSON.stringify(await app.harness.snapshot(DeskThreads, context)),
            before,
            "no document changed",
        );
    });

    test("a bad path is a 400: .., an absolute path, a hidden segment, not .md, no path", async () => {
        for (const path of [
            "reports/../desk/x.md",
            "../secret.md",
            join(outside, "secret.md"),
            "/etc/passwd.md",
            "reports/.hidden.md",
            "reports/notes.txt",
            "other/x.md",
        ]) {
            const { status, data } = await file(path);

            assert.equal(status, 400, `${path}: ${JSON.stringify(data)}`);
            assert.match(data.error ?? "", /relative \.md path/);
        }

        assert.equal((await get("file")).status, 400, "no path");
    });

    test("a symlink out of the root is refused, as a file and as a folder", async () => {
        const link = await file("reports/out.md");

        assert.equal(link.status, 400);
        assert.match(link.data.error ?? "", /outside the desk folder/);
        assert.equal(link.data.text, undefined);
        assert.equal((await file("decisions/secret.md")).status, 400);
    });

    test("a missing file and a folder are a 404; a file over 256 KB is a 413", async () => {
        assert.equal((await file("reports/none.md")).status, 404);
        assert.equal((await file("plans/dir.md")).status, 404);

        const big = await file("reports/big.md");

        assert.equal(big.status, 413);
        assert.match(big.data.error ?? "", /over 256 KB/);
    });

    test("no export folder configured is a 404", async () => {
        withExport(false);

        try {
            const { status, data } = await file("reports/2026-11-05-go-live/502-check.md");

            assert.equal(status, 404);
            assert.match(data.error ?? "", /no export folder/);
        } finally {
            withExport(true);
        }
    });

    test("no token, and a viewer, are refused", async () => {
        const path = "file?path=reports%2F2026-11-05-go-live%2F502-check.md";

        assert.equal((await get(path, null)).status, 401);
        // Pocket answers 404 to a person who may not use an owner route: it does not say the route exists.
        assert.equal((await get(path, viewer)).status, 404);
    });
});
