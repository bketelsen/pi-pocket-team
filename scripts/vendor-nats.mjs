// Builds `_events-bridge-nats.mjs`, the vendored NATS client of the events bridge (docs/adr/0004): 1 ESM file from
// the pinned packages below, bundled by the pinned esbuild. Run it only to move the pin:
//
//     node scripts/vendor-nats.mjs
//
// It needs the npm registry. It installs the exact versions into a temporary folder, checks each package's integrity
// against the pin, bundles the entry, writes the file, and prints its SHA-256. Then copy that hash into
// `NATS_SHA256` in `events-bridge.test.ts` (the test fails on any other bytes) and into docs/modules/events-bridge.md.
// Drop-ins import only Pi Pocket's packages, so the client comes with the module (plan T1913, Design 6).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The packages of the bundle, each at an exact version with npm's integrity. */
export const PINS = {
    "@nats-io/nats-core": {
        version: "3.4.0",
        integrity:
            "sha512-QMDM86EUNm+wudlKC67HLar/KHHQUvJGLfb4jbahje3pUk3K9afeck9fwsxBZF0eUFox6T/TA6m/t+lQqf+QsQ==",
    },
    "@nats-io/nkeys": {
        version: "2.0.3",
        integrity:
            "sha512-JVt56GuE6Z89KUkI4TXUbSI9fmIfAmk6PMPknijmuL72GcD+UgIomTcRWiNvvJKxA01sBbmIPStqJs5cMRBC3A==",
    },
    "@nats-io/nuid": {
        version: "3.0.0",
        integrity:
            "sha512-QbXZDrxmYlrn5AD06gYcUTmEHwxn96HBQMIk7XTjDlEcx6FPzVBBPjp4AMRh1lEv6B4iJ6Xb/Uz61JugPXFRQg==",
    },
    tweetnacl: {
        version: "1.0.3",
        integrity:
            "sha512-6rt+RN7aOi1nGMyC4Xa5DdYiukl2UWCbcJft7YhxReBGQD7OAM8Pbxw6YMo4r2diNEA8FEmu32YOn9rhaiE5yw==",
    },
};

/** The bundler, pinned too: the same version and arguments give the same bytes. */
export const ESBUILD = "0.25.12";

/** What the bridge imports: the WebSocket connect and the error classes it tells apart. */
const ENTRY = `export {
    wsconnect,
    AuthorizationError,
    ClosedConnectionError,
    ConnectionError,
    NoRespondersError,
    PermissionViolationError,
    RequestError,
    TimeoutError,
} from "@nats-io/nats-core";
`;

/** tweetnacl asks for `require("crypto")` when it finds no Web Crypto: an ESM file has no `require`, so give it one. */
const BANNER =
    'import { createRequire as __vendorCreateRequire } from "node:module"; const require = __vendorCreateRequire(import.meta.url);';

const HEADER = `// Vendored NATS client for events-bridge.ts: do not edit. Made by scripts/vendor-nats.mjs from
// @nats-io/nats-core ${PINS["@nats-io/nats-core"].version} (Apache-2.0), @nats-io/nkeys ${PINS["@nats-io/nkeys"].version} (Apache-2.0), @nats-io/nuid ${PINS["@nats-io/nuid"].version} (Apache-2.0)
// and tweetnacl ${PINS.tweetnacl.version} (Unlicense), bundled by esbuild ${ESBUILD}. See https://github.com/nats-io/nats.js.
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const work = mkdtempSync(join(tmpdir(), "vendor-nats-"));

    try {
        writeFileSync(
            join(work, "package.json"),
            JSON.stringify({
                private: true,
                dependencies: {
                    "@nats-io/nats-core": PINS["@nats-io/nats-core"].version,
                    esbuild: ESBUILD,
                },
            }),
        );
        execFileSync("npm", ["install", "--no-audit", "--no-fund", "--save-exact"], {
            cwd: work,
            stdio: "inherit",
        });

        const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8"));

        for (const [name, pin] of Object.entries(PINS)) {
            const entry = lock.packages[`node_modules/${name}`];

            if (entry?.version !== pin.version || entry?.integrity !== pin.integrity) {
                throw new Error(
                    `${name}: npm installed ${entry?.version} (${entry?.integrity}), not the pin ${pin.version} (${pin.integrity})`,
                );
            }
        }

        writeFileSync(join(work, "entry.mjs"), ENTRY);
        execFileSync(
            join(work, "node_modules", ".bin", "esbuild"),
            [
                "entry.mjs",
                "--bundle",
                "--format=esm",
                "--platform=node",
                "--target=node22",
                "--legal-comments=inline",
                `--banner:js=${BANNER}`,
                "--outfile=out.mjs",
            ],
            { cwd: work, stdio: "inherit" },
        );

        const bytes = HEADER + readFileSync(join(work, "out.mjs"), "utf8");
        const target = join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "_events-bridge-nats.mjs",
        );

        writeFileSync(target, bytes);
        console.log(`wrote ${target}`);
        console.log(`sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
