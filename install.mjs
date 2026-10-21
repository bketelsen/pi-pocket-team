import { cp, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const target = join(process.env.PI_POCKET_DIR ?? join(homedir(), ".pi-pocket"), "extensions");

await mkdir(target, { recursive: true });
await access(join(target, "node_modules", "@earendil-works", "pi-durable"));

for (const name of ["team.ts", "team-web"]) {
    await cp(join(import.meta.dirname, name), join(target, name), { recursive: true });
}

console.log(`Installed named team in ${target}. Enable “Team” in Menu → Extensions.`);
