# Brian's Pi Pocket extensions

This is Brian's extension project: drop-in modules for his running Pi Pocket server. See README.md for what each module does.

- **Modules:** Team (`team.ts`, `team-web/`) and Homewiki (`homewiki.ts`, `homewiki-web/`). A new module also goes in `MODULES` in `install.mjs`.
- **Docs:** Pi Pocket's extension docs start at `/var/home/bjk/projects/pi-pocket/docs/extensions.md`; the exact types are `_pocket.d.ts` (a link into the checkout). Read the guide your change needs before writing it.
- **Test before install, every time.** Run `npm test` (node --test, plus `node --check` of the browser modules) and `./node_modules/.bin/tsc -p tsconfig.json` before every commit and every install.
- **Installs are live.** `npm run install-extension` writes into `~/.pi-pocket/extensions/`, and a saved module reloads into the running server the whole team works in. Run `npm run install-check` first and make sure every file it lists is one you meant to change. If an installed file differs from the project's and you don't know why, stop and ask: someone may have edited the live copy.
- **Brian turns modules on and off, and restarts the server.** Never enable or disable an extension or restart the server; finish, test, and tell him what needs doing.
- **Tests stay isolated.** They use the Pi Pocket checkout's test harness (temporary data, test credentials, a fake model). Point modules at fixtures with environment variables (`PI_POCKET_TEAM_AGENTS`, `PI_POCKET_HOMEWIKI_ROOT`), never at Brian's real data.
- **Nothing secret in git.** `node_modules` and `_pocket.d.ts` are links into the Pi Pocket checkout and stay ignored. Never commit anything from `~/.pi-pocket` or `~/.config/pi-pocket-team`, tokens, or credentials.
- The homewiki's content belongs to Bellonda; this module only renders it.
