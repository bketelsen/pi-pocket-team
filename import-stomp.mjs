// One-time migration of identities, not histories, infrastructure, or credentials.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";

const source = process.argv[2] ?? join(homedir(), ".config", "stomp");
const target =
    process.env.PI_POCKET_TEAM_AGENTS ?? join(homedir(), ".config", "pi-pocket-team", "agents");
const { models = {} } = parse(await readFile(join(source, "stomp.yaml"), "utf8"));
const files = (await readdir(join(source, "agents")))
    .filter((name) => /^[a-z0-9][a-z0-9_-]*\.md$/.test(name))
    .map((name) => join(source, "agents", name));

// Optional extra profile files, e.g. one exported from the old VM.
files.push(...process.argv.slice(3));
await mkdir(target, { recursive: true });

for (const file of files) {
    const name = basename(file);

    if (!/^[a-z0-9][a-z0-9_-]*\.md$/.test(name)) {
        throw new Error("Agent filenames must be lowercase identifiers ending in .md.");
    }

    const { frontmatter, body } = parseFrontmatter(await readFile(file, "utf8"));
    const refs = Array.isArray(frontmatter.model) ? frontmatter.model : [frontmatter.model];
    const model = models[refs[0]] ?? refs[0] ?? "";
    const role = frontmatter.role === "supervisor" ? "supervisor" : "agent";
    const content = `---\nmodel: ${JSON.stringify(model)}\nrole: ${role}\n---\n\n${body.trim()}\n`;

    try {
        await writeFile(join(target, name), content, { flag: "wx", mode: 0o600 });
        console.log(`Imported ${name}`);
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }

        console.log(`Kept existing ${name}`);
    }
}
