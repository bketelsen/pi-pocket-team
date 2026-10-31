// Isolated browser preview of the Desk's Dashboard: Pocket's test harness (temporary data, test credentials, a fake
// model), only `desk.ts` on, and the facts of `desk-dashboard-fixture.ts`. Nothing reads Brian's data or GitHub.
//
// The collector never runs here, so it cannot overwrite the fixture: it starts only from a desk sweep or `desk sync`,
// and the desk has no thread, so no sweeper starts. The fake `gh` also fails every call.
//
// Routes beside the app's own, for the checks:
//   /preview-login            sign in as the owner
//   /preview-fixture?name=N   seed variant N again (main, empty, not-started, stale, usage-unavailable, partial-usage)
//   /preview-fail?on=1|0      make `GET dashboard` fail with a 500, or not
//   /preview-delay?ms=N       hold each `GET dashboard` answer N ms (the loading state)
//   /preview-module?on=0|1    turn the preview's Desk module off (its browser module goes) or on again
//   /preview-count            how many `GET dashboard` requests came
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./_pocket/test/helpers.ts";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHandler } from "./_pocket/src/server/http.ts";
import { setAuthCookie } from "./_pocket/src/server/auth.ts";
import { DeskDashboard } from "./_desk-dashboard.ts";
import { DeskUsage } from "./_desk-usage.ts";
import { dashboardFixture, VARIANTS, type Variant } from "./desk-dashboard-fixture.ts";

const fakeGh = join(root, "preview-gh");
const agents = join(root, "preview-agents");
const config = join(root, "preview-desk.json");

writeFileSync(fakeGh, "#!/bin/sh\necho 'preview: no GitHub here' >&2\nexit 1\n", { mode: 0o755 });
mkdirSync(agents, { recursive: true });
writeFileSync(config, JSON.stringify({ digest: { minutes: 0 } }));
process.env.PI_POCKET_DESK_GH = fakeGh;
process.env.PI_POCKET_DESK_CONFIG = config;
process.env.PI_POCKET_TEAM_AGENTS = agents;

const extensions = join(root, "data", "extensions");

mkdirSync(extensions, { recursive: true });

for (const file of ["desk.ts", "_desk-usage.ts", "_desk-dashboard.ts", "_desk-metrics.ts"]) {
    cpSync(join(import.meta.dirname, file), join(extensions, file));
}

cpSync(join(import.meta.dirname, "desk-web"), join(extensions, "desk-web"), { recursive: true });

const app = await openApp(scriptedModel());

await app.setExtensionEnabled(owner(app), "desk.ts", true);

const session = await newSession(app);

/** Replace both documents with 1 variant of the fixture, at the real clock. */
const seed = async (variant: Variant): Promise<void> => {
    const fixture = dashboardFixture(Date.now(), variant);

    await app.harness.commit(async (tx) => {
        const dashboard = (await tx.doc(DeskDashboard)) as unknown as Record<string, unknown>;
        const usage = (await tx.doc(DeskUsage)) as unknown as Record<string, unknown>;

        for (const key of Object.keys(dashboard)) {
            delete dashboard[key];
        }

        for (const key of Object.keys(usage)) {
            delete usage[key];
        }

        Object.assign(dashboard, fixture.dashboard);
        Object.assign(usage, fixture.usage);
    }, context);
};

await seed("main");

let fail = false;
let delay = 0;
let count = 0;
const host = "127.0.0.2";
const handler = createHandler({ app, listen: { host, port: 0 }, restart: () => {} });

const text = (res: import("node:http").ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
};

const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (url.pathname === "/preview-login") {
        setAuthCookie(req, res, app.config.ownerToken);
        res.writeHead(302, { location: `/s/${session}` });
        res.end();

        return;
    }

    if (url.pathname === "/preview-fixture") {
        const name = url.searchParams.get("name") as Variant;

        if (!VARIANTS.includes(name)) {
            text(res, 400, `name must be 1 of ${VARIANTS.join(", ")}`);

            return;
        }

        void seed(name).then(
            () => text(res, 200, `seeded ${name}`),
            (error: unknown) => text(res, 500, String(error)),
        );

        return;
    }

    if (url.pathname === "/preview-fail") {
        fail = url.searchParams.get("on") === "1";
        text(res, 200, `fail ${String(fail)}`);

        return;
    }

    if (url.pathname === "/preview-delay") {
        delay = Math.max(0, Number(url.searchParams.get("ms")) || 0);
        text(res, 200, `delay ${String(delay)}`);

        return;
    }

    if (url.pathname === "/preview-module") {
        // Turns the preview's own Desk module off or on: its browser module goes, and its dispose runs.
        const on = url.searchParams.get("on") === "1";

        void app.setExtensionEnabled(owner(app), "desk.ts", on).then(
            () => text(res, 200, `desk.ts ${on ? "on" : "off"}`),
            (error: unknown) => text(res, 500, String(error)),
        );

        return;
    }

    if (url.pathname === "/preview-count") {
        text(res, 200, String(count));

        return;
    }

    if (url.pathname === "/api/x/desk/dashboard") {
        count += 1;

        if (fail) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "preview: the dashboard read failed on purpose" }));

            return;
        }

        if (delay > 0) {
            setTimeout(() => void handler(req, res), delay);

            return;
        }
    }

    void handler(req, res);
});

await new Promise<void>((resolve) => server.listen(0, host, resolve));
console.log(`Preview: http://${host}:${(server.address() as { port: number }).port}/preview-login`);

const stop = async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
    process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
