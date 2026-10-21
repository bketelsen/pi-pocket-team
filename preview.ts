// Isolated browser preview: test credentials and a fake model, no production changes.
import {
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "/var/home/bjk/projects/pi-pocket/test/helpers.ts";
import { cpSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHandler } from "/var/home/bjk/projects/pi-pocket/src/server/http.ts";
import { setAuthCookie } from "/var/home/bjk/projects/pi-pocket/src/server/auth.ts";

process.env.PI_POCKET_TEAM_AGENTS = join(homedir(), ".config", "pi-pocket-team", "agents");
const extensions = join(root, "data", "extensions");

mkdirSync(extensions, { recursive: true });
cpSync(join(import.meta.dirname, "team.ts"), join(extensions, "team.ts"));
cpSync(join(import.meta.dirname, "team-web"), join(extensions, "team-web"), { recursive: true });
const app = await openApp(scriptedModel());

await app.setExtensionEnabled(owner(app), "team.ts", true);
const session = await newSession(app);
const host = "127.0.0.2";
const handler = createHandler({ app, listen: { host, port: 0 }, restart: () => {} });
const server = createServer((req, res) => {
    if (req.url === "/preview-login") {
        setAuthCookie(req, res, app.config.ownerToken);
        res.writeHead(302, { location: `/s/${session}` });
        res.end();

        return;
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
