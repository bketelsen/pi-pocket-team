// The site's pages (site/content/**/*.md): each page's front matter must parse as a YAML mapping. ProperDocs does not
// fail a strict build on bad front matter: it renders the lines as page text, and the page's title, description and
// `hide` are lost. An unquoted ": " in a value is the usual cause (pi-pocket-team#132, cross-review finding 1).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = join(repository, "site", "content");

function pages(folder) {
    const found = [];

    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);

        if (entry.isDirectory()) {
            found.push(...pages(path));
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
            found.push(path);
        }
    }

    return found;
}

/** The front matter of a page: the text between a first line `---` and the next line `---`, or undefined. */
export function frontMatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);

    return match === null ? undefined : match[1];
}

/** Undefined when the front matter is a YAML mapping, else the problem. */
export function frontMatterProblem(yaml) {
    try {
        const value = parse(yaml);

        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? undefined
            : "it is not a mapping";
    } catch (error) {
        return error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
}

test("every site page's front matter parses as a mapping", () => {
    const all = pages(content);
    const problems = [];
    let checked = 0;

    for (const path of all) {
        const yaml = frontMatter(readFileSync(path, "utf8"));

        if (yaml === undefined) {
            continue;
        }

        checked++;

        const problem = frontMatterProblem(yaml);

        if (problem !== undefined) {
            problems.push(`${relative(repository, path)}: ${problem}`);
        }
    }

    assert.ok(all.length > 0, "site/content has no page");
    assert.ok(checked > 0, "no page has front matter, so nothing was checked");
    assert.deepEqual(
        problems,
        [],
        'fix the front matter, for example quote a value that holds ": "',
    );
});

test("the check fails on an unquoted ': ' in a value, and passes when it is quoted", () => {
    const problem = frontMatterProblem("title: x\ndescription: a: b\n");

    assert.equal(typeof problem, "string");
    assert.ok(problem.length > 0);
    assert.equal(frontMatterProblem('title: x\ndescription: "a: b"\n'), undefined);
    assert.equal(frontMatterProblem("- a\n- b\n"), "it is not a mapping");
});
