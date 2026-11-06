// The text of an ask (a question for Brian) as safe Markdown: a small parser and a renderer that makes only `html`
// tagged templates, with each text as a child value, so Preact escapes it. No raw HTML, no images, no
// `dangerouslySetInnerHTML`. Links open only for `https:`. 2 reference forms are buttons: `artifact:<id>` and a desk
// path (`reports/…`, `desk/…`, `plans/…`, `decisions/…` ending in `.md`). No import of the app: pure functions only.

/** The longest artifact id that is a reference. */
export const ARTIFACT_ID_MAX = 80;
/** The longest desk path that is a reference. */
export const DESK_PATH_MAX = 200;
/** The folders a desk path starts with: each is a folder beside the desk export. */
export const DESK_PATH_ROOTS = ["reports", "desk", "plans", "decisions"];

const ARTIFACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** The characters a backslash escapes: the backslash goes, the character stays as text. */
const ESCAPABLE = new Set(["*", "`", "_", "|", "[", "]", "\\"]);
/** Characters that end a bare token at its end: the punctuation of the sentence around it. */
const TRAILING = /[.,;:!?)\]"'>]+$/;

/** The artifact id of `artifact:<id>`, or undefined when the text is not exactly that form. */
export const artifactId = (text) => {
    if (typeof text !== "string" || !text.startsWith("artifact:")) {
        return undefined;
    }

    const id = text.slice("artifact:".length);

    return id.length <= ARTIFACT_ID_MAX && ARTIFACT_ID.test(id) ? id : undefined;
};

/**
 * Whether a text is a desk path: relative, under 1 of the desk folders, ending in `.md`, at most 200 characters, each
 * segment `[A-Za-z0-9_][A-Za-z0-9._-]*` (so no `.` or `..` segment and no hidden file). The server's `GET file` checks
 * the same rule.
 */
export const deskPath = (text) => {
    if (typeof text !== "string" || text.length === 0 || text.length > DESK_PATH_MAX) {
        return false;
    }

    const segments = text.split("/");

    return (
        segments.length >= 2 &&
        DESK_PATH_ROOTS.includes(segments[0]) &&
        segments.every((segment) => SEGMENT.test(segment)) &&
        text.endsWith(".md")
    );
};

/** The URL of an `https:` link, or undefined for any other protocol or a bad URL. */
export const httpsUrl = (text) => {
    if (typeof text !== "string" || text === "" || /[\s\u0000-\u001f\u007f]/.test(text)) {
        return undefined;
    }

    try {
        const url = new URL(text);

        return url.protocol === "https:" ? url.href : undefined;
    } catch {
        return undefined;
    }
};

// ─── Blocks ─────────────────────────────────────────────────────────────────

const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

/** The ranges of inline code spans in a line: a step marker inside one does not count. */
const codeRanges = (line) => {
    const ranges = [];
    const span = /(`+)[^`]*?\1/g;
    let found;

    while ((found = span.exec(line)) !== null) {
        ranges.push([found.index, found.index + found[0].length]);
    }

    return ranges;
};

/**
 * 1-line numbered steps: `Lead 1) one 2) two 3) three` gives the lead and the steps, or undefined. `1) ` is at the
 * start or after a space, and ` 2) `, ` 3) ` … follow in order; there must be 2 or more. ` - ` and `; ` never split.
 */
export const splitSteps = (line) => {
    const inCode = (index) => codeRanges(line).some(([from, to]) => index >= from && index < to);

    const markerAt = (from, number) => {
        const marker = `${number}) `;
        let index = line.indexOf(marker, from);

        while (index !== -1) {
            if ((index === 0 || line[index - 1] === " ") && !inCode(index)) {
                return index;
            }

            index = line.indexOf(marker, index + 1);
        }

        return -1;
    };

    let first = markerAt(0, 1);

    while (first !== -1) {
        const starts = [first];
        let number = 2;
        let next = markerAt(first + 3, number);

        while (next !== -1 && next > starts.at(-1)) {
            starts.push(next);
            number += 1;
            next = markerAt(next + String(number - 1).length + 2, number);
        }

        if (starts.length >= 2) {
            const items = starts.map((start, index) => {
                const from = start + String(index + 1).length + 2;
                const to = index + 1 < starts.length ? starts[index + 1] : line.length;

                return line.slice(from, to).trim();
            });

            return { lead: line.slice(0, first).trim(), items };
        }

        first = markerAt(first + 1, 1);
    }

    return undefined;
};

/**
 * The blocks of an ask text: `{ type: "p", text }`, `{ type: "ul", items }`, `{ type: "ol", start, items }`, and
 * `{ type: "code", text }`. A blank line starts a new paragraph; `- ` or `* ` lines are a bullet list; `1. ` or `1) `
 * lines an ordered list; ``` fences a code block, its text kept exactly. A 1-line paragraph with numbered steps splits
 * into its lead and an ordered list.
 */
export const parseAskText = (text) => {
    const lines = String(text ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n");
    const blocks = [];
    let paragraph = [];
    let list = null;

    const flushParagraph = () => {
        if (paragraph.length === 0) {
            return;
        }

        const joined = paragraph.join(" ").trim();
        const steps = paragraph.length === 1 ? splitSteps(joined) : undefined;

        if (steps === undefined) {
            blocks.push({ type: "p", text: joined });
        } else {
            if (steps.lead !== "") {
                blocks.push({ type: "p", text: steps.lead });
            }

            blocks.push({ type: "ol", start: 1, items: steps.items });
        }

        paragraph = [];
    };

    const flushList = () => {
        if (list !== null) {
            blocks.push(list);
            list = null;
        }
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        if (FENCE.test(line)) {
            flushParagraph();
            flushList();

            const body = [];

            index += 1;

            while (index < lines.length && !FENCE.test(lines[index])) {
                body.push(lines[index]);
                index += 1;
            }

            blocks.push({ type: "code", text: body.join("\n") });
            continue;
        }

        if (line.trim() === "") {
            flushParagraph();
            flushList();
            continue;
        }

        const bullet = BULLET.exec(line);
        const ordered = bullet === null ? ORDERED.exec(line) : null;

        if (bullet !== null) {
            flushParagraph();

            if (list?.type !== "ul") {
                flushList();
                list = { type: "ul", items: [] };
            }

            list.items.push(bullet[1].trim());
            continue;
        }

        if (ordered !== null) {
            flushParagraph();

            // `1) a 2) b` on 1 line: the steps of the line, not 1 item that holds them all.
            const steps = list?.type === "ol" ? undefined : splitSteps(line.trim());

            if (list?.type !== "ol") {
                flushList();
                list = { type: "ol", start: Number(ordered[1]), items: [] };
            }

            if (steps !== undefined && steps.lead === "") {
                list.items.push(...steps.items);
            } else {
                list.items.push(ordered[2].trim());
            }

            continue;
        }

        // An indented line after a list item goes on with that item.
        if (list !== null && /^\s/.test(line)) {
            list.items[list.items.length - 1] += ` ${line.trim()}`;
            continue;
        }

        flushList();
        paragraph.push(line.trim());
    }

    flushParagraph();
    flushList();

    return blocks;
};

// ─── Inline ─────────────────────────────────────────────────────────────────

/** A reference or code from the content of inline code: the whole content must be the reference. */
const codeNode = (content) => {
    const id = artifactId(content);

    if (id !== undefined) {
        return { type: "artifact", id, label: content };
    }

    return deskPath(content)
        ? { type: "path", path: content, label: content }
        : { type: "code", text: content };
};

/** The index of the `]` that closes the `[` at `open`, with escapes and nested brackets, or -1. */
const closeBracket = (text, open) => {
    let depth = 0;

    for (let index = open; index < text.length; index += 1) {
        const char = text[index];

        if (char === "\\") {
            index += 1;
        } else if (char === "[") {
            depth += 1;
        } else if (char === "]") {
            depth -= 1;

            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
};

/** The index of the `)` that closes the `(` at `open`, with nested parentheses, or -1. */
const closeParen = (text, open) => {
    let depth = 0;

    for (let index = open; index < text.length; index += 1) {
        if (text[index] === "(") {
            depth += 1;
        } else if (text[index] === ")") {
            depth -= 1;

            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
};

/** Whether a bare token may start at `index`: at the start, or after a space or an opening mark. */
const boundary = (text, index) => index === 0 || /[\s(["'<]/.test(text[index - 1]);

/** The bare word at `index` (up to a space), without the punctuation of the sentence at its end. */
const bareWord = (text, index) => {
    const word = /^[^\s]+/.exec(text.slice(index))?.[0] ?? "";

    return word.replace(TRAILING, "");
};

/**
 * The inline nodes of a text: `{ type: "text", text }`, `{ type: "code", text }`, `{ type: "bold", children }`,
 * `{ type: "link", href, children }`, `{ type: "artifact", id, label }`, and `{ type: "path", path, label }`. `inLink`:
 * the label of a link, which holds no link or reference of its own.
 */
export const parseInline = (text, inLink = false) => {
    const nodes = [];
    let buffer = "";

    const flush = () => {
        if (buffer !== "") {
            nodes.push({ type: "text", text: buffer });
            buffer = "";
        }
    };

    const push = (node) => {
        flush();
        nodes.push(node);
    };

    let index = 0;

    while (index < text.length) {
        const char = text[index];
        const rest = text.slice(index);

        if (char === "\\" && ESCAPABLE.has(text[index + 1])) {
            buffer += text[index + 1];
            index += 2;
            continue;
        }

        if (char === "`") {
            const run = /^`+/.exec(rest)[0];
            const close = text.indexOf(run, index + run.length);

            // The closing run must be exactly as long: a longer run is not it.
            if (close !== -1 && text[close + run.length] !== "`") {
                const content = text.slice(index + run.length, close);
                const trimmed =
                    content.length > 1 && content.startsWith(" ") && content.endsWith(" ")
                        ? content.slice(1, -1)
                        : content;

                push(inLink ? { type: "code", text: trimmed } : codeNode(trimmed));
                index = close + run.length;
                continue;
            }

            buffer += run;
            index += run.length;
            continue;
        }

        if (rest.startsWith("**")) {
            const close = text.indexOf("**", index + 2);

            if (close > index + 2) {
                push({ type: "bold", children: parseInline(text.slice(index + 2, close), inLink) });
                index = close + 2;
                continue;
            }

            buffer += "**";
            index += 2;
            continue;
        }

        // `[label](target)`, and `![alt](src)`: an image is never shown, its source stays text.
        const image = char === "!" && text[index + 1] === "[";

        if (char === "[" || image) {
            const open = image ? index + 1 : index;
            const close = closeBracket(text, open);
            const end = close !== -1 && text[close + 1] === "(" ? closeParen(text, close + 1) : -1;

            if (end !== -1) {
                const source = text.slice(index, end + 1);
                const label = text.slice(open + 1, close);
                const target = text.slice(close + 2, end).trim();
                const href = httpsUrl(target);
                const id = artifactId(target);

                if (image || inLink) {
                    buffer += source;
                } else if (href !== undefined) {
                    push({ type: "link", href, children: parseInline(label, true) });
                } else if (id !== undefined) {
                    push({ type: "artifact", id, label: parseInline(label, true) });
                } else if (deskPath(target)) {
                    push({ type: "path", path: target, label: parseInline(label, true) });
                } else {
                    // Any other protocol (`javascript:`, `data:`, `http:`): no link, the raw source as text.
                    buffer += source;
                }

                index = end + 1;
                continue;
            }
        }

        if (!inLink && boundary(text, index)) {
            if (rest.startsWith("https://")) {
                const word = bareWord(text, index);
                const href = httpsUrl(word);

                if (href !== undefined) {
                    push({ type: "link", href, children: [{ type: "text", text: word }] });
                    index += word.length;
                    continue;
                }
            }

            if (rest.startsWith("artifact:")) {
                const word = bareWord(text, index);
                const id = artifactId(word);

                if (id !== undefined) {
                    push({ type: "artifact", id, label: word });
                    index += word.length;
                    continue;
                }
            }

            if (DESK_PATH_ROOTS.some((root) => rest.startsWith(`${root}/`))) {
                const word = bareWord(text, index);

                if (deskPath(word)) {
                    push({ type: "path", path: word, label: word });
                    index += word.length;
                    continue;
                }
            }

            // A bare token that is not valid stays text, whole: none of its parts is a reference.
            const bare = /^(https:\/\/|artifact:|(?:reports|desk|plans|decisions)\/)/.exec(rest);

            if (bare !== null) {
                const word = /^[^\s]+/.exec(rest)[0];

                buffer += word;
                index += word.length;
                continue;
            }
        }

        buffer += char;
        index += 1;
    }

    flush();

    return nodes;
};

// ─── Render ─────────────────────────────────────────────────────────────────

/**
 * The nodes of an ask text, in a `<div class="desk-md">`. `html` is htm bound to Preact: every text goes in as a
 * child value, so Preact escapes it. An https link opens in a new tab; an artifact or path reference is a button that
 * calls `openArtifact(id)` or `openPath(path)`. Without its handler, a reference shows as code.
 */
export const renderAskText = (html, text, { openArtifact, openPath } = {}) => {
    const inline = (nodes) =>
        nodes.map((node) => {
            switch (node.type) {
                case "text":
                    return node.text;
                case "code":
                    return html`<code>${node.text}</code>`;
                case "bold":
                    return html`<strong>${inline(node.children)}</strong>`;
                case "link":
                    return html`<a
                        class="desk-md-link"
                        href=${node.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        >${inline(node.children)}</a
                    >`;

                case "artifact": {
                    const label = typeof node.label === "string" ? node.label : inline(node.label);

                    return typeof openArtifact === "function"
                        ? html`<button
                              type="button"
                              class="desk-ref desk-ref-artifact"
                              title=${`Open artifact ${node.id}`}
                              onClick=${() => openArtifact(node.id)}
                          >
                              ${label}
                          </button>`
                        : html`<code>${label}</code>`;
                }

                case "path": {
                    const label = typeof node.label === "string" ? node.label : inline(node.label);

                    return typeof openPath === "function"
                        ? html`<button
                              type="button"
                              class="desk-ref desk-ref-path"
                              title=${`Open ${node.path}`}
                              onClick=${() => openPath(node.path)}
                          >
                              ${label}
                          </button>`
                        : html`<code>${label}</code>`;
                }

                default:
                    return null;
            }
        });

    const block = (each) => {
        switch (each.type) {
            case "code":
                return html`<pre class="desk-md-code"><code>${each.text}</code></pre>`;
            case "ul":
                return html`<ul>
                    ${each.items.map((item) => html`<li>${inline(parseInline(item))}</li>`)}
                </ul>`;
            case "ol":
                return html`<ol start=${each.start === 1 ? undefined : each.start}>
                    ${each.items.map((item) => html`<li>${inline(parseInline(item))}</li>`)}
                </ol>`;
            default:
                return html`<p>${inline(parseInline(each.text))}</p>`;
        }
    };

    return html`<div class="desk-md">${parseAskText(text).map(block)}</div>`;
};
