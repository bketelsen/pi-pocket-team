// Shift names: every text that a person or a model reads says "shift". Only stored names, live identities and the
// old aliases keep "night-shift". The test reads every string literal, every template-literal text part and every
// regular expression literal of the modules (comments are no literals, so they are skipped), and fails on one that
// names the old feature and is not on the list below. Each entry on the list must still occur, as often as it says.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const OLD_NAME = /night[\s_-]?shift/i;

const here = import.meta.dirname;
const scripts = (folder: string) =>
    readdirSync(join(here, folder))
        .filter((name) => name.endsWith(".js"))
        .sort()
        .map((name) => `${folder}/${name}`);

const FILES = [
    "night-shift.ts",
    "team.ts",
    "desk.ts",
    "night-shift-web/index.js",
    ...scripts("desk-web"),
    ...scripts("team-web"),
];

/** A literal that may name the old feature: the file, its exact text, how many times it occurs there, and why. */
type Allowed = { file: string; text: string; count: number; why: string };

const ALLOWED: Allowed[] = [
    // night-shift.ts
    {
        file: "night-shift.ts",
        text: "`/night-shift` is now `/team-shift`.",
        count: 1,
        why: "the first line of each answer of the alias command /night-shift",
    },
    {
        file: "night-shift.ts",
        text: "pi-pocket-team.night-shift",
        count: 1,
        why: "the global symbol of the live API: other modules find it by this name",
    },
    {
        file: "night-shift.ts",
        text: "x.night-shift.goal",
        count: 1,
        why: "the stored document kind",
    },
    {
        file: "night-shift.ts",
        text: "x.night-shift.driver",
        count: 1,
        why: "the stored task name",
    },
    {
        file: "night-shift.ts",
        text: "x.night-shift.report:",
        count: 2,
        why: "the stored request key of a report: a replay must find the first send",
    },
    {
        file: "night-shift.ts",
        text: "x.night-shift.report:stop:",
        count: 1,
        why: "the stored request key of a report after a stop",
    },
    {
        file: "night-shift.ts",
        text: ":x-night-shift-",
        count: 1,
        why: "the stored request id of a round: a restart must find the first send",
    },
    {
        file: "night-shift.ts",
        text: "/^\\[(?:shift\\]|night-shift\\]|via |scheduled\\]|subagent |goal\\] |background\\] )/",
        count: 1,
        why: "the reader of the round prefix: older entries hold [night-shift]",
    },
    {
        file: "night-shift.ts",
        text: "night-shift",
        count: 5,
        why: "the module name, the prompt section id, the alias command name, and the report value from: night-shift (its type and its value)",
    },
    {
        file: "night-shift.ts",
        text: "night-shift-web",
        count: 1,
        why: "the client folder name",
    },
    // team.ts
    {
        file: "team.ts",
        text: "pi-pocket-team.night-shift",
        count: 1,
        why: "the global symbol of the shift module's live API",
    },
    {
        file: "team.ts",
        text: "night-shift",
        count: 1,
        why: "the report value from: night-shift, in the type of the desk's API",
    },
    {
        file: "team.ts",
        text: "The shift module (night-shift.ts) is off. Brian turns it on in Menu → Extensions.",
        count: 1,
        why: "Menu → Extensions lists the module by its file name",
    },
    {
        file: "team.ts",
        text: "The shift module (night-shift.ts) is too old for pr_check: Brian must install the new version.",
        count: 1,
        why: "the file name of the module to install",
    },
    {
        file: "team.ts",
        text: "The old name of shift, with the same fields. Give shift or night_shift, not both.",
        count: 1,
        why: "the description of the alias argument night_shift",
    },
    {
        file: "team.ts",
        text: "Give shift or night_shift, not both.",
        count: 1,
        why: "the refusal of a call that gives both arguments",
    },
    // desk.ts
    {
        file: "desk.ts",
        text: "pi-pocket-team.night-shift",
        count: 1,
        why: "the global symbol of the shift module's live API",
    },
    {
        file: "desk.ts",
        text: "night-shift",
        count: 8,
        why: "the report value from: night-shift (types and compares), and the stored archive skip reason night-shift (its type, its value, and archiveReasonText)",
    },
    {
        file: "desk.ts",
        text: "night-shift-unknown",
        count: 3,
        why: "the stored archive skip reason night-shift-unknown (archiveReasonText shows it as shift-unknown)",
    },
    {
        file: "desk.ts",
        text: "/^\\[(?:shift\\]|night-shift\\]|via |scheduled\\]|subagent |goal\\] |desk\\] )/",
        count: 1,
        why: "the reader of the round prefix: older entries hold [night-shift]",
    },
];

/** Every literal of a source text that names the old feature, in order. */
function oldNamesIn(file: string, text: string): string[] {
    const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const found: string[] = [];

    const visit = (node: ts.Node): void => {
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isRegularExpressionLiteral(node)
        ) {
            if (OLD_NAME.test(node.text)) {
                found.push(node.text);
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    return found;
}

const oldNames = (file: string): string[] =>
    oldNamesIn(file, readFileSync(join(here, file), "utf8"));

test("the scan reads literals, template parts and patterns, and skips comments", () => {
    assert.deepEqual(
        oldNamesIn(
            "fixture.ts",
            [
                "// night shift in a comment",
                'const a: "night_shift" = "night_shift";',
                "const b = `x ${a} Night-Shift y ${a} z`;",
                "const c = /nightshift/;",
                "/* night-shift */",
            ].join("\n"),
        ),
        ["night_shift", "night_shift", " Night-Shift y ", "/nightshift/"],
    );
});

test("no literal names the old feature, except the allowed stored names, identities and aliases", () => {
    const unexpected: string[] = [];

    for (const file of FILES) {
        for (const text of oldNames(file)) {
            if (!ALLOWED.some((each) => each.file === file && each.text === text)) {
                unexpected.push(`${file}: ${JSON.stringify(text)}`);
            }
        }
    }

    assert.deepEqual(unexpected, [], "say shift in the text, or add the literal with its reason");
});

test("each allowed literal still occurs, as often as the list says", () => {
    for (const each of ALLOWED) {
        assert.ok(FILES.includes(each.file), `${each.file} is scanned`);
        assert.ok(each.why.length > 0, `${each.text} has a reason`);
        assert.equal(
            oldNames(each.file).filter((text) => text === each.text).length,
            each.count,
            `${each.file}: ${JSON.stringify(each.text)} (${each.why})`,
        );
    }
});

// The docs: prose that names the current feature says shift too. Code spans and fenced blocks hold stored names and
// identifiers (`x.night-shift.goal`, `night-shift.ts`), so the scan skips them. The pattern allows any white space,
// a line break too, between the 2 words.
const DOC_OLD_NAME = /night[\s_-]*shifts?/gi;

const markdown = (folder: string): string[] =>
    readdirSync(join(here, folder), { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => `${folder}/${name}`);

const DOCS = [
    "README.md",
    "AGENTS.md",
    "bench/README.md",
    "docs/README.md",
    "docs/beacon.md",
    "docs/setup.md",
    ...markdown("docs/modules"),
    ...markdown("site/content"),
    "site/properdocs.yml",
];

/** Prose that may name the old feature: the file, how many times, and why. */
const DOC_ALLOWED: Allowed[] = [
    {
        file: "docs/modules/night-shift.md",
        text: "night shift",
        count: 2,
        why: "the old path of the page: its title and its 1 line say the feature has a new name",
    },
    {
        file: "docs/modules/shift.md",
        text: "night shift",
        count: 1,
        why: "the section Old names says what the feature was called",
    },
    {
        file: "site/content/modules/shift.md",
        text: "night shift",
        count: 1,
        why: "the section Old names says what the feature was called",
    },
    {
        file: "docs/setup.md",
        text: "night shift",
        count: 1,
        why: "it says what shift-names.test.ts looks for",
    },
    {
        file: "site/content/contributing/build.md",
        text: "night shift",
        count: 1,
        why: "it says what shift-names.test.ts looks for",
    },
    {
        file: "AGENTS.md",
        text: "night-shift",
        count: 1,
        why: "the rule that stored names keep the old name names it",
    },
    {
        file: "docs/modules/shift.md",
        text: "night-shift",
        count: 1,
        why: "the section Old names says which names keep it",
    },
    {
        file: "docs/README.md",
        text: "night-shift",
        count: 2,
        why: "the index links the old path of the page, modules/night-shift.md (its text and its target)",
    },
];

/** Every prose mention of the old feature in a Markdown or YAML text, outside code, with white space as 1 space. */
function oldNamesInProse(text: string): string[] {
    const prose = text
        .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
        .replace(/`[^`\n]*`/g, "");

    return [...prose.matchAll(DOC_OLD_NAME)].map((match) =>
        match[0].replace(/\s+/g, " ").toLowerCase(),
    );
}

test("the docs scan finds a name split over 2 lines, and skips code spans and fenced blocks", () => {
    assert.deepEqual(
        oldNamesInProse(
            [
                "R1 still counts night",
                "  shifts only. A `night-shift.ts` file and a `x.night-shift.goal` kind.",
                "```text",
                "/night-shift status",
                "```",
                "A Night-shift goal.",
            ].join("\n"),
        ),
        ["night shifts", "night-shift"],
    );
});

test("no doc names the current feature night shift, except the old names it explains", () => {
    const unexpected: string[] = [];

    for (const file of DOCS) {
        const found = oldNamesInProse(readFileSync(join(here, file), "utf8"));
        const allowed = DOC_ALLOWED.filter((each) => each.file === file);

        for (const text of found) {
            if (!allowed.some((each) => each.text === text)) {
                unexpected.push(`${file}: ${JSON.stringify(text)}`);
            }
        }

        for (const each of allowed) {
            assert.equal(
                found.filter((text) => text === each.text).length,
                each.count,
                `${file}: ${JSON.stringify(each.text)} (${each.why})`,
            );
        }
    }

    assert.deepEqual(unexpected, [], "say shift in the doc, or add the mention with its reason");
});
