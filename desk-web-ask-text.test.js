// The ask text renderer of the Desk page (`desk-web/ask-text.js`): each Markdown form, the escape of HTML through the
// real htm and Preact, the links that are not links, and the 2 reference forms with their taps. No browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import htm from "htm";
import { h } from "preact";
import {
    artifactId,
    deskPath,
    httpsUrl,
    parseAskText,
    parseInline,
    renderAskText,
    splitSteps,
} from "./desk-web/ask-text.js";
import setup, { openArtifactIn, openPathIn, planAskLine, planAskTail } from "./desk-web/index.js";

const html = htm.bind(h);

const escape = (text) =>
    String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");

/** Every vnode of a tree, the root first. */
const vnodes = (node) => {
    if (Array.isArray(node)) {
        return node.flatMap(vnodes);
    }

    if (node === null || typeof node !== "object") {
        return [];
    }

    return [node, ...vnodes(node.props?.children)];
};

/**
 * A vnode tree as HTML: text escaped, attributes escaped, handlers left out. A `dangerouslySetInnerHTML` goes in raw,
 * as a browser would show it, so a test sees it.
 */
const serialize = (node) => {
    if (Array.isArray(node)) {
        return node.map(serialize).join("");
    }

    if (node === null || node === undefined || typeof node === "boolean") {
        return "";
    }

    if (typeof node !== "object") {
        return escape(node);
    }

    const { children, dangerouslySetInnerHTML, ...props } = node.props ?? {};
    const attrs = Object.entries(props)
        .filter(
            ([name, value]) => value !== undefined && typeof value !== "function" && name !== "key",
        )
        .map(([name, value]) => ` ${name === "className" ? "class" : name}="${escape(value)}"`)
        .join("");
    const inner =
        dangerouslySetInnerHTML === undefined
            ? serialize(children)
            : dangerouslySetInnerHTML.__html;

    return `<${node.type}${attrs}>${inner}</${node.type}>`;
};

const render = (text, handlers = {}) => renderAskText(html, text, handlers);
const out = (text, handlers) => serialize(render(text, handlers));

// ─── Blocks ─────────────────────────────────────────────────────────────────

test("a paragraph; a blank line starts a new one", () => {
    assert.equal(out("Which one?"), '<div class="desk-md"><p>Which one?</p></div>');
    assert.deepEqual(parseAskText("First\nstill first\n\nSecond"), [
        { type: "p", text: "First still first" },
        { type: "p", text: "Second" },
    ]);
});

test("a bullet list with - and *, and an ordered list with 1. and 1)", () => {
    assert.deepEqual(parseAskText("Pick:\n- one\n* two"), [
        { type: "p", text: "Pick:" },
        { type: "ul", items: ["one", "two"] },
    ]);
    assert.deepEqual(parseAskText("1. one\n2) two"), [
        { type: "ol", start: 1, items: ["one", "two"] },
    ]);
    assert.equal(out("- a\n- b"), '<div class="desk-md"><ul><li>a</li><li>b</li></ul></div>');
    assert.equal(
        out("3. c\n4. d"),
        '<div class="desk-md"><ol start="3"><li>c</li><li>d</li></ol></div>',
    );
});

test("1-line numbered steps split into a lead and an ordered list", () => {
    assert.deepEqual(parseAskText("Do this: 1) build it 2) test it 3) ship it."), [
        { type: "p", text: "Do this:" },
        { type: "ol", start: 1, items: ["build it", "test it", "ship it."] },
    ]);
    assert.deepEqual(parseAskText("1) a 2) b"), [{ type: "ol", start: 1, items: ["a", "b"] }]);
    assert.equal(
        out("Steps: 1) one 2) two"),
        '<div class="desk-md"><p>Steps:</p><ol><li>one</li><li>two</li></ol></div>',
    );
});

test("prose with ' - ', '; ', ranges, 1 marker only, or markers out of order does not split", () => {
    for (const text of [
        "Phases 1-5 are done - the rest waits; 15-30 s each.",
        "Only 1) one marker here.",
        "Out of order: 1) a 3) c",
        "Starts at 2: 2) b 3) c",
        "No space:x1) a 2) b",
        "In code: `f(1) ` and `g 2) ` only",
    ]) {
        assert.deepEqual(parseAskText(text), [{ type: "p", text }], text);
        assert.equal(splitSteps(text), undefined, text);
    }
});

test("a fenced code block keeps its text exactly", () => {
    const text = "Run:\n```\n  npm test  **x**\n<b>y</b>\n```\nThen tell me.";

    assert.deepEqual(parseAskText(text), [
        { type: "p", text: "Run:" },
        { type: "code", text: "  npm test  **x**\n<b>y</b>" },
        { type: "p", text: "Then tell me." },
    ]);
    assert.match(
        out(text),
        /<pre class="desk-md-code"><code> {2}npm test {2}\*\*x\*\*\n&lt;b&gt;y&lt;\/b&gt;<\/code><\/pre>/,
    );
});

// ─── Inline ─────────────────────────────────────────────────────────────────

test("inline code, bold, an https link and a bare https URL", () => {
    assert.equal(
        out(
            "Run `npm test` **now**: see [the PR](https://github.com/a/b/pull/1) or https://example.com/x.",
        ),
        '<div class="desk-md"><p>Run <code>npm test</code> <strong>now</strong>: see ' +
            '<a class="desk-md-link" href="https://github.com/a/b/pull/1" target="_blank" rel="noopener noreferrer">the PR</a>' +
            ' or <a class="desk-md-link" href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.</p></div>',
    );
});

test("backslash escapes give the character as text", () => {
    assert.deepEqual(parseInline("\\*a\\* \\`b\\` \\_ \\| \\[c\\] \\\\"), [
        { type: "text", text: "*a* `b` _ | [c] \\" },
    ]);
    assert.equal(out("\\*\\*not bold\\*\\*"), '<div class="desk-md"><p>**not bold**</p></div>');
});

test("HTML is escaped through the real htm and Preact, and no vnode sets inner HTML", () => {
    const text =
        "<script>alert(1)</script> and <img src=x onerror=alert(1)> and `<b>x</b>` and **<i>y</i>**\n\n- <svg onload=alert(1)>";
    const tree = render(text);
    const shown = serialize(tree);

    assert.match(shown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(shown, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(shown, /<code>&lt;b&gt;x&lt;\/b&gt;<\/code>/);
    assert.match(shown, /<strong>&lt;i&gt;y&lt;\/i&gt;<\/strong>/);
    assert.match(shown, /<li>&lt;svg onload=alert\(1\)&gt;<\/li>/);
    assert.doesNotMatch(shown, /<script|<img|<svg|<i>|<b>/);

    for (const node of vnodes(tree)) {
        assert.equal(
            node.props?.dangerouslySetInnerHTML,
            undefined,
            `no inner HTML on <${node.type}>`,
        );
    }
});

test("an image stays text, and raw HTML stays text", () => {
    assert.equal(
        out("![x](https://example.com/a.png)"),
        '<div class="desk-md"><p>![x](https://example.com/a.png)</p></div>',
    );
});

test("javascript:, JaVaScRiPt:, data:, http: and vbscript: links are not links: their source is text", () => {
    for (const target of [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "http://example.com",
        "vbscript:msgbox(1)",
    ]) {
        const tree = render(`Click [here](${target}) now.`);

        assert.equal(
            vnodes(tree).filter((node) => node.type === "a").length,
            0,
            `${target}: no <a>`,
        );
        assert.equal(
            serialize(tree),
            `<div class="desk-md"><p>Click ${escape(`[here](${target})`)} now.</p></div>`,
        );
        assert.equal(httpsUrl(target), undefined);
    }

    assert.equal(
        vnodes(render("bare http://example.com")).filter((node) => node.type === "a").length,
        0,
        "a bare http URL is not a link",
    );
});

// ─── References ─────────────────────────────────────────────────────────────

/** The reference buttons of a tree: their class, and their text. */
const refs = (tree) =>
    vnodes(tree)
        .filter((node) => node.type === "button")
        .map((node) => ({ node, class: node.props.class, text: serialize(node.props.children) }));

test("artifact:<id>, plain, in code and as a link target, is a button that calls openArtifact", () => {
    const opened = [];
    const tree = render(
        "See artifact:intake-502-check, `artifact:a-b` and [the chart](artifact:c1).",
        { openArtifact: (id) => opened.push(id), openPath: () => {} },
    );
    const buttons = refs(tree);

    assert.deepEqual(
        buttons.map((each) => [each.class, each.text]),
        [
            ["desk-ref desk-ref-artifact", "artifact:intake-502-check"],
            ["desk-ref desk-ref-artifact", "artifact:a-b"],
            ["desk-ref desk-ref-artifact", "the chart"],
        ],
    );

    for (const each of buttons) {
        assert.equal(each.node.props.type, "button");
        each.node.props.onClick();
    }

    assert.deepEqual(opened, ["intake-502-check", "a-b", "c1"]);
    assert.equal(
        vnodes(tree).filter((node) => node.type === "a").length,
        0,
        "no <a> with a fake href",
    );
});

test("a desk path, plain, in code and as a link target, is a button that calls openPath", () => {
    const opened = [];
    const tree = render(
        "Read reports/2026-11-05-intake-go-live/502-check.md. Also `desk/T1.md` and [the plan](plans/T560/plan.md).",
        { openArtifact: () => {}, openPath: (path) => opened.push(path) },
    );
    const buttons = refs(tree);

    assert.deepEqual(
        buttons.map((each) => [each.class, each.text]),
        [
            ["desk-ref desk-ref-path", "reports/2026-11-05-intake-go-live/502-check.md"],
            ["desk-ref desk-ref-path", "desk/T1.md"],
            ["desk-ref desk-ref-path", "the plan"],
        ],
    );

    for (const each of buttons) {
        each.node.props.onClick();
    }

    assert.deepEqual(opened, [
        "reports/2026-11-05-intake-go-live/502-check.md",
        "desk/T1.md",
        "plans/T560/plan.md",
    ]);
});

test("bad references are not references: plain, in code, or as a link target", () => {
    const handlers = {
        openArtifact: () => assert.fail("no artifact"),
        openPath: () => assert.fail("no path"),
    };

    for (const bad of [
        "artifact:Bad_ID",
        "artifact:bad_id",
        "artifact:-x",
        `artifact:${"a".repeat(81)}`,
        "reports/../x.md",
        "/etc/passwd.md",
        "reports/.hidden.md",
        "reports/x.txt",
    ]) {
        for (const text of [`See ${bad} now`, `See \`${bad}\` now`, `See [it](${bad}) now`]) {
            assert.deepEqual(refs(render(text, handlers)), [], text);
        }
    }

    assert.equal(artifactId("artifact:Bad_ID"), undefined);
    assert.equal(artifactId(`artifact:${"a".repeat(80)}`), "a".repeat(80));
    assert.equal(deskPath("reports/../x.md"), false);
    assert.equal(deskPath("reports/x.md"), true);
});

test("without its handler a reference shows as code, not as a button", () => {
    assert.equal(
        out("artifact:a and reports/x.md"),
        '<div class="desk-md"><p><code>artifact:a</code> and <code>reports/x.md</code></p></div>',
    );
});

// ─── The page's helpers ─────────────────────────────────────────────────────

test("planAskTail is the part of planAskLine after the text", () => {
    for (const ask of [
        { id: "T5a", text: "Which?", open: true },
        {
            id: "T5a",
            text: "Which?",
            open: false,
            written: false,
            answer: { words: "A", by: "brian" },
        },
        { id: "T5a", text: "Which?", open: false, resolved: { why: "Gone.", by: "odrade" } },
    ]) {
        assert.equal(planAskLine(ask), `${ask.id}: ${ask.text}${planAskTail(ask)}`);
    }

    assert.equal(planAskTail({ id: "T5a", text: "Which?", open: true }), " · open");
});

test("openArtifactIn opens the supervisor's session and says where; with no supervisor, a warning", () => {
    const calls = [];
    const pocket = {
        openConversation: (id) => calls.push(["open", id]),
        notify: (level, message) => calls.push([level, message]),
    };

    assert.equal(openArtifactIn(pocket, 12, "intake-502-check"), true);
    assert.deepEqual(calls, [
        ["open", 12],
        ["info", "Open Artifacts, then intake-502-check."],
    ]);

    calls.length = 0;
    assert.equal(openArtifactIn(pocket, undefined, "x"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "warning");
    assert.match(calls[0][1], /not known/);
    assert.equal(openArtifactIn({}, 12, "x"), false, "an app without openConversation or notify");
});

test("openPathIn opens the Desk file sheet, or says the path when the app has no sheets", () => {
    const calls = [];
    const pocket = {
        openSheet: (id, props) => calls.push(["sheet", id, props]),
        notify: (level, message) => calls.push([level, message]),
    };

    assert.equal(openPathIn(pocket, true, "reports/x.md"), true);
    assert.equal(openPathIn(pocket, false, "reports/x.md"), false);
    assert.deepEqual(calls, [
        ["sheet", "file", { path: "reports/x.md" }],
        ["info", "Desk file: reports/x.md"],
    ]);
});

test("the page adds the Desk file sheet when the app has sheets, and it reads GET file", async () => {
    let sheet;
    const paths = [];

    setup({
        html,
        h,
        useState: (value) => [typeof value === "function" ? value() : value, () => {}],
        useEffect: (run) => run(),
        useRef: () => ({ current: null }),
        Loader: () => null,
        style() {},
        api: async (path) => {
            paths.push(path);

            return path === "threads"
                ? { threads: [], seen: 0 }
                : { path: "reports/x.md", text: "# X" };
        },
        page() {},
        sheet: (spec) => {
            sheet = spec;
        },
        rail: () => ({ update() {} }),
        on: () => () => {},
        onDispose() {},
    });

    assert.equal(sheet.id, "file");
    assert.equal(sheet.title, "Desk file");

    const shown = serialize(sheet.component({ path: "reports/x.md" }));

    assert.match(shown, /<h2 class="desk-file-path mono">reports\/x.md<\/h2>/);
    assert.ok(paths.includes("file?path=reports%2Fx.md"), paths.join(", "));
    assert.doesNotMatch(shown, /<input|<textarea|contenteditable/, "read only: no edit control");
});
