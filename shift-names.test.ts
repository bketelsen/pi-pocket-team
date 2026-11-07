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
