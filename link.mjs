// Links this project to a Pi Pocket checkout: node_modules, the extension types, and the checkout itself (tests and
// preview.ts import Pi Pocket's test harness and server files through _pocket). Set PI_POCKET_CHECKOUT for another
// checkout. The default is ../pi-pocket-live, the link to the release folder that the server runs, when it is a
// checkout; else ../pi-pocket, next to this repository. The links go through ../pi-pocket-live, not to the release
// folder it names, so they follow the server to each new release. Running it again repairs links and prints nothing
// when they are already right.
import { existsSync } from "node:fs";
import { access, lstat, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** True when `path` holds Pi Pocket's test harness, which the tests import. */
const isCheckout = (path) => existsSync(join(path, "test", "helpers.ts"));

/**
 * The checkout to link: `PI_POCKET_CHECKOUT` when set; else `pi-pocket-live` beside the repository when it is a
 * checkout; else `pi-pocket` beside the repository.
 */
export function checkoutFor(repository, env = process.env, checkout = isCheckout) {
    if (env.PI_POCKET_CHECKOUT) {
        return resolve(env.PI_POCKET_CHECKOUT);
    }

    const live = resolve(repository, "..", "pi-pocket-live");

    return checkout(live) ? live : resolve(repository, "..", "pi-pocket");
}

if (import.meta.main) {
    const repository = import.meta.dirname;
    const checkout = checkoutFor(repository);

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
            console.error(
                `${name} exists and is not a symlink. Move it away, then run this again.`,
            );
            process.exit(1);
        }

        if (resolve(dirname(path), await readlink(path)) === target) {
            continue;
        }

        await rm(path);
        await symlink(target, path);
        console.log(`updated  ${name} -> ${target}`);
    }
}
