// Pi Pocket's helpers isolate all credentials, sessions, and model calls.
import { cleanUp, openApp, owner, root, scriptedModel } from "./_pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "./_pocket/src/server/http.ts";

after(cleanUp);
const wiki = join(root, "homewiki");

process.env.PI_POCKET_HOMEWIKI_ROOT = wiki;

function put(path: string, text: string) {
    mkdirSync(join(wiki, path, ".."), { recursive: true });
    writeFileSync(join(wiki, path), text);
}

put("README.md", "---\norder: 99\n---\n# Home lab\n\nStart here.\n");
put(
    "docs/network.md",
    '---\ntitle: "Network"\norder: 20\nupdated: 2026-10-01\n---\n# Ignored heading\n\nVLANs.\n',
);
put("docs/storage.md", "---\r\norder: 10\r\n---\r\n# Storage\r\n\r\nPools.\r\n");
put("docs/guides/backups.md", "# Backups\n\nNo frontmatter, no order.\n");
put("docs/guides/apps.md", "---\norder: 10\n---\nNo heading at all.\n");
put("docs/.drafts/secret.md", "# Draft\n");
put("docs/notes.txt", "not markdown\n");
put("other.md", "# Outside docs/\n");
writeFileSync(join(root, "outside.md"), "# Beside the wiki\n");
execFileSync("git", ["init", "-q", wiki]);
execFileSync("git", ["-C", wiki, "add", "-A"]);
execFileSync("git", [
    "-C",
    wiki,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "fixture",
]);

test("homewiki lists pages in order, strips frontmatter, and serves only listed pages", async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "homewiki.ts"), join(dropIns, "homewiki.ts"));
    cpSync(join(import.meta.dirname, "homewiki-web"), join(dropIns, "homewiki-web"), {
        recursive: true,
    });
    const app = await openApp(scriptedModel());
    let server: ReturnType<typeof createServer> | undefined;

    try {
        await app.setExtensionEnabled(owner(app), "homewiki.ts", true);
        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/homewiki/`;

        async function call(path: string, token = app.config.ownerToken) {
            const res = await fetch(base + path, {
                headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
            });

            return { status: res.status, data: await res.json() };
        }

        const page = (path: string) => call(`page?path=${encodeURIComponent(path)}`);

        // The list: README first whatever its order, then `order`, then path; no order sorts last.
        const listed = await call("pages");

        assert.equal(listed.status, 200);
        assert.deepEqual(
            listed.data.pages.map((each: { path: string; order: number }) => [
                each.path,
                each.order,
            ]),
            [
                ["README.md", 0],
                ["docs/guides/apps.md", 10],
                ["docs/storage.md", 10],
                ["docs/network.md", 20],
                ["docs/guides/backups.md", 1000],
            ],
        );
        const byPath = Object.fromEntries(
            listed.data.pages.map((each: { path: string }) => [each.path, each]),
        );

        assert.equal(
            byPath["docs/network.md"].title,
            "Network",
            "frontmatter title wins over the heading",
        );
        assert.equal(byPath["docs/network.md"].updated, "2026-10-01");
        assert.equal(byPath["docs/storage.md"].title, "Storage", "the first heading is the title");
        assert.equal(
            byPath["docs/guides/apps.md"].title,
            "docs/guides/apps.md",
            "the path is the last resort",
        );
        assert.equal(byPath["docs/guides/backups.md"].section, "Guides");
        assert.equal(byPath["docs/storage.md"].section, "");
        assert.equal(listed.data.head.dirty, false);
        assert.match(listed.data.head.commit, /^[0-9a-f]{7,}$/);

        // Frontmatter is stripped from the body, LF and CRLF alike; a page without it is whole.
        const network = await page("docs/network.md");

        assert.equal(network.status, 200);
        assert.equal(network.data.body, "# Ignored heading\n\nVLANs.\n");
        assert.equal(typeof network.data.modified, "number");
        assert.equal((await page("docs/storage.md")).data.body, "# Storage\r\n\r\nPools.\r\n");
        assert.equal(
            (await page("docs/guides/backups.md")).data.body,
            "# Backups\n\nNo frontmatter, no order.\n",
        );
        assert.equal((await page("README.md")).data.body, "# Home lab\n\nStart here.\n");

        // Only a listed page is served: traversal, absolute paths, git internals, hidden, non-docs, missing.
        for (const path of [
            "../outside.md",
            "docs/../../outside.md",
            "docs/../README.md",
            "./README.md",
            join(wiki, "README.md"),
            join(root, "outside.md"),
            "/etc/passwd",
            ".git/config",
            ".git/HEAD",
            "docs/.drafts/secret.md",
            "docs/notes.txt",
            "other.md",
            "docs/missing.md",
            "",
        ]) {
            const refused = await page(path);

            assert.equal(refused.status, 404, `refuses ${JSON.stringify(path)}`);
            assert.equal(refused.data.error, "No such wiki page");
        }

        assert.equal((await call("page")).status, 404, "no path at all");

        // An uncommitted edit shows as dirty.
        put("docs/storage.md", "---\norder: 10\n---\n# Storage\n\nPools, edited.\n");
        assert.equal((await call("pages")).data.head.dirty, true);

        // Owner-only: a guest sees nothing.
        const guest = app.config.addUser("Guest", "guest");

        assert.equal((await call("pages", guest.token)).status, 404);
        assert.equal((await call("page?path=README.md", guest.token)).status, 404);
    } finally {
        server?.closeAllConnections();
        server?.close();
        await app.close();
    }
});
