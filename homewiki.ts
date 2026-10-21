/**
 * Homelab wiki: a rail page that renders Bellonda's bketelsen/homewiki checkout, live from disk, read-only.
 *
 * Pages are README.md and every .md file under docs/, ordered by their `order` frontmatter, as stomp's /wiki did. The server lists
 * them by scanning the checkout, and serves only a page from that list, so a request can never name another file.
 * A watcher on the checkout tells open tabs when a page changes, so Bellonda's edits show without a reload.
 */
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Web } from "./_pocket.d.ts";

// Tests point this at a fixture with PI_POCKET_HOMEWIKI_ROOT; the server leaves it unset.
const ROOT = process.env.PI_POCKET_HOMEWIKI_ROOT || "/var/home/bjk/projects/homewiki";
const run = promisify(execFile);

interface Page {
    path: string;
    title: string;
    order: number;
    section: string;
    updated?: string;
}

/** The frontmatter's `key: value` lines, and the body after it. */
function split(text: string): { meta: Record<string, string>; body: string } {
    const meta: Record<string, string> = {};
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

    if (!match) {
        return { meta, body: text };
    }

    for (const line of match[1].split(/\r?\n/)) {
        const kv = /^([\w-]+):\s*(.*?)\s*$/.exec(line);

        if (kv) {
            meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
        }
    }

    return { meta, body: text.slice(match[0].length) };
}

/** README.md and every Markdown file under docs/, skipping hidden files and folders. */
async function files(): Promise<string[]> {
    const found = ["README.md"];
    const entries = await readdir(join(ROOT, "docs"), { recursive: true, withFileTypes: true });

    for (const entry of entries) {
        const full = join(entry.parentPath, entry.name);
        const rel = relative(ROOT, full).split(sep).join("/");

        if (entry.isFile() && rel.endsWith(".md") && !rel.split("/").some((part) => part.startsWith("."))) {
            found.push(rel);
        }
    }

    return found;
}

async function pages(): Promise<Page[]> {
    const list: Page[] = [];

    for (const path of await files()) {
        let text: string;

        try {
            text = await readFile(join(ROOT, path), "utf8");
        } catch {
            continue;
        }

        const { meta, body } = split(text);
        const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
        const folder = path.startsWith("docs/") ? path.slice(5).split("/").slice(0, -1).join("/") : "";
        const order = Number(meta.order);

        list.push({
            path,
            title: meta.title || heading || path,
            order: path === "README.md" ? 0 : Number.isFinite(order) ? order : 1000,
            section: folder === "" ? "" : folder.charAt(0).toUpperCase() + folder.slice(1),
            updated: meta.updated,
        });
    }

    return list.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
}

/** The checkout's HEAD and whether it has uncommitted edits: what the page is rendered from. */
async function head(): Promise<{ commit?: string; date?: string; dirty?: boolean }> {
    try {
        const [log, status] = await Promise.all([
            run("git", ["-C", ROOT, "log", "-1", "--format=%h%x09%cs"]),
            run("git", ["-C", ROOT, "status", "--porcelain"]),
        ]);
        const [commit, date] = log.stdout.trim().split("\t");

        return { commit, date, dirty: status.stdout.trim() !== "" };
    } catch {
        return {};
    }
}

export default function createHomewiki(_host: unknown, web: Web) {
    web.route("GET", "pages", async () => ({ pages: await pages(), head: await head() }));

    web.route("GET", "page", async ({ query }) => {
        const path = query.get("path") ?? "";
        const list = await pages();
        const page = list.find((each) => each.path === path);

        if (!page) {
            throw web.error(404, "No such wiki page");
        }

        const text = await readFile(join(ROOT, page.path), "utf8");
        const info = await stat(join(ROOT, page.path));

        return { ...page, body: split(text).body, modified: info.mtimeMs };
    });

    web.client("homewiki-web");

    // Tell open tabs when a Markdown file changes, at most once a second.
    let watcher: FSWatcher | undefined;
    let pending: NodeJS.Timeout | undefined;

    try {
        watcher = watch(ROOT, { recursive: true }, (_kind, name) => {
            const file = String(name ?? "");

            if (!file.endsWith(".md") || file.startsWith(".git")) {
                return;
            }

            clearTimeout(pending);
            pending = setTimeout(() => web.send("changed", { path: file.split(sep).join("/") }), 1000);
            pending.unref();
        });
        watcher.on("error", () => watcher?.close());
    } catch {
        // No live updates; Refresh still works.
    }

    web.onDispose(() => {
        clearTimeout(pending);
        watcher?.close();
    });
}
