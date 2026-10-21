// Links this project to a Pi Pocket checkout: node_modules, the extension types, and the checkout itself (tests and
// preview.ts import Pi Pocket's test harness and server files through _pocket). Set PI_POCKET_CHECKOUT for another
// checkout; the default is ../pi-pocket, next to this repository. Running it again repairs links and prints nothing
// when they are already right.
import { access, lstat, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const repository = import.meta.dirname;
const checkout = resolve(process.env.PI_POCKET_CHECKOUT || join(repository, "..", "pi-pocket"));

try {
    await access(join(checkout, "test", "helpers.ts"));
} catch {
    console.error(`Not a Pi Pocket checkout: ${checkout}`);
    console.error("Set PI_POCKET_CHECKOUT to your Pi Pocket checkout.");
    process.exit(1);
}

const links = [
    ["node_modules", join(checkout, "node_modules")],
    ["_pocket.d.ts", join(checkout, "types", "pocket.d.ts")],
    ["_pocket", checkout],
];

for (const [name, target] of links) {
    const path = join(repository, name);
    let current;

    try {
        current = await lstat(path);
    } catch {
        await symlink(target, path);
        console.log(`created  ${name} -> ${target}`);
        continue;
    }

    if (!current.isSymbolicLink()) {
        console.error(`${name} exists and is not a symlink. Move it away, then run this again.`);
        process.exit(1);
    }

    if (resolve(dirname(path), await readlink(path)) === target) {
        continue;
    }

    await rm(path);
    await symlink(target, path);
    console.log(`updated  ${name} -> ${target}`);
}
