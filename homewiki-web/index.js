// Homelab wiki's browser module: a rail button and a page that shows bketelsen/homewiki, rendered by the app's own
// Markdown. Links between wiki pages open in the page; links to other sites open in a new tab.

export const pocketApi = 1;

/** An open book, as a 24×24 stroked path. */
const BOOK = "M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2zM12 6v14";
const LAST = "x.homewiki.page";
const HOME = "docs/index.md";

/** GitHub's heading anchors: `## History: the pre-consolidation map` is `#history-the-pre-consolidation-map`. */
const slug = (text) =>
    text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");

/** `file`, written in the page at `from`, as a path from the checkout's top. */
function resolve(from, file) {
    const parts = from.split("/").slice(0, -1);

    for (const part of file.split("/")) {
        if (part === "..") {
            parts.pop();
        } else if (part !== "." && part !== "") {
            parts.push(part);
        }
    }

    return parts.join("/");
}

export default function setup(pocket) {
    const { html, useEffect, useRef, useState, useCallback, Loader, Markdown } = pocket;

    pocket.style("wiki.css");

    function Wiki() {
        const [list, setList] = useState(null);
        const [head, setHead] = useState({});
        const [path, setPath] = useState(() => localStorage.getItem(LAST) || HOME);
        const [page, setPage] = useState(null);
        const [error, setError] = useState(null);
        const [missing, setMissing] = useState(null);
        const [back, setBack] = useState([]);
        const [anchor, setAnchor] = useState(null);
        const top = useRef(null);
        const body = useRef(null);
        const current = useRef(path);

        current.current = path;

        const loadList = useCallback(async () => {
            const answer = await pocket.api("pages");

            setList(answer.pages);
            setHead(answer.head ?? {});

            return answer.pages;
        }, []);

        const loadPage = useCallback(async (target) => {
            try {
                setPage(await pocket.api(`page?path=${encodeURIComponent(target)}`));
                setError(null);
            } catch (failure) {
                setError(failure.message);
            }
        }, []);

        // First the list, then the page that was open last (or Home, if that page is gone).
        useEffect(() => {
            loadList().then(
                (pages) => {
                    const start = pages.some((each) => each.path === current.current)
                        ? current.current
                        : (pages.find((each) => each.path === HOME) ?? pages[0])?.path;

                    if (start) {
                        setPath(start);
                        void loadPage(start);
                    }
                },
                (failure) => setError(failure.message),
            );

            // Bellonda saved a page: refresh the list, and the page if it is the one showing.
            return pocket.on("changed", ({ path: changed }) => {
                loadList().catch(() => {});

                if (changed === current.current) {
                    void loadPage(changed);
                }
            });
        }, []);

        // A new page starts at its top, or at the heading a link named.
        useEffect(() => {
            if (!page || page.path !== path) {
                return;
            }

            const heading =
                anchor &&
                [...(body.current?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? [])].find(
                    (each) => slug(each.textContent ?? "") === anchor,
                );

            (heading || top.current)?.scrollIntoView({ block: "start" });
        }, [page, anchor]);

        const go = (target, fragment = null, remember = true) => {
            setMissing(null);
            setAnchor(fragment);

            if (target === path) {
                setPage((same) => (same ? { ...same } : same));

                return;
            }

            if (remember) {
                setBack((stack) => [...stack.slice(-49), path]);
            }

            localStorage.setItem(LAST, target);
            setPath(target);
            void loadPage(target);
        };

        const goBack = () => {
            const previous = back[back.length - 1];

            if (previous) {
                setBack(back.slice(0, -1));
                go(previous, null, false);
            }
        };

        const refresh = () => {
            loadList().catch((failure) => setError(failure.message));
            void loadPage(path);
        };

        // Links in the page: wiki pages and anchors open here, other sites in a new tab. This runs before the app's
        // own handler, which would open a linked path in the session's file viewer.
        const onClick = (event) => {
            const link = event.target.closest?.("a[href]");

            if (!link) {
                if (event.target.closest?.("code[data-path]")) {
                    event.preventDefault();
                    event.stopPropagation();
                }

                return;
            }

            const raw = link.getAttribute("href") ?? "";

            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw) && !raw.startsWith("./")) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const [file, fragment = null] = decodeURIComponent(raw).split("#");

            if (file === "") {
                setAnchor(fragment);
                setPage((same) => (same ? { ...same } : same));

                return;
            }

            const target = resolve(path, file);

            if (list?.some((each) => each.path === target)) {
                go(target, fragment);
            } else {
                setMissing(target);
            }
        };

        if (!list && error) {
            return html`<div class="error-box">${error}</div>
                <button class="button" onClick=${refresh}>Try again</button>`;
        }

        if (!list) {
            return html`<${Loader} label="Reading the wiki" />`;
        }

        let section = null;
        const nav = list.map((each) => {
            const header = each.section !== section ? (section = each.section) : null;

            return html`${header ? html`<div class="homewiki-section small muted">${header}</div>` : null}
                <button
                    class=${`homewiki-link ${each.path === path ? "on" : ""}`}
                    onClick=${() => go(each.path)}
                >
                    ${each.title}
                </button>`;
        });

        return html`<div class="homewiki">
            <nav class="homewiki-nav">${nav}</nav>
            <div class="homewiki-main">
                <div class="homewiki-bar" ref=${top}>
                    ${
                        back.length > 0
                            ? html`<button class="button" onClick=${goBack}>← Back</button>`
                            : null
                    }
                    <select
                        class="homewiki-select"
                        value=${path}
                        onChange=${(event) => go(event.currentTarget.value)}
                    >
                        ${list.map(
                            (each) =>
                                html`<option value=${each.path}>
                                    ${each.section ? `${each.section} / ` : ""}${each.title}
                                </option>`,
                        )}
                    </select>
                    <span class="grow"></span>
                    <button class="button" onClick=${refresh}>Refresh</button>
                </div>
                ${
                    missing
                        ? html`<div class="error-box">No wiki page at <span class="mono">${missing}</span>.</div>`
                        : null
                }
                ${error ? html`<div class="error-box">${error}</div>` : null}
                ${
                    page
                        ? html`<article class="homewiki-page" ref=${body} onClick=${onClick}>
                          <${Markdown} text=${page.body} breaks=${false} />
                      </article>`
                        : html`<${Loader} label="Opening the page" />`
                }
                <p class="homewiki-foot small muted">
                    <span class="mono">${page?.path ?? ""}</span>
                    ${page?.updated ? ` · updated ${page.updated}` : ""}
                    ${
                        head.commit
                            ? ` · checkout at ${head.commit} (${head.date})${head.dirty ? ", with uncommitted edits" : ""}`
                            : ""
                    }
                </p>
            </div>
        </div>`;
    }

    pocket.page({ id: "wiki", title: "Homelab wiki", component: Wiki });
    pocket.rail({ id: "wiki", title: "Wiki", iconPath: BOOK, page: "wiki" });
    pocket.launcher({
        id: "wiki",
        label: "Homelab wiki",
        detail: "bketelsen/homewiki",
        iconPath: BOOK,
        keywords: ["wiki", "homelab", "homewiki"],
        page: "wiki",
    });
}
