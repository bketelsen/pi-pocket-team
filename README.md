# Brian's Pi Pocket extensions

Drop-in extensions for Brian's Pi Pocket server. Each module is a `.ts` file plus a browser folder; installed, they live in `~/.pi-pocket/extensions/`.

| Module       | Files                          | What it is                                                                                                                                          |
| ------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Team**     | `team.ts`, `team-web/`         | Named agents (Odrade and the specialists) in ordinary Pi Pocket sessions, Odrade's delegation into their repositories, and each agent's own memory. |
| **Homewiki** | `homewiki.ts`, `homewiki-web/` | The "Wiki" rail page: renders Bellonda's homewiki checkout (`/var/home/bjk/projects/homewiki`) live from disk, read-only and owner-only.            |

## Test

```sh
cd ~/projects/pi-pocket-team
npm test                                  # node --test, plus node --check of both browser modules
./node_modules/.bin/tsc -p tsconfig.json  # types of team.ts and homewiki.ts
```

The tests run each module inside a real Pi Pocket app built by the checkout's test harness: temporary data, test credentials, a fake model. `homewiki.test.ts` points the module at a fixture wiki with `PI_POCKET_HOMEWIKI_ROOT`; the server never sets it, so production reads the real checkout. `team-memory.test.ts` checks agent memory's rules directly and through the app, with fixture agent profiles. `npm run preview` (`preview.ts`) opens an isolated app with sample lessons, to look at the panel.

## Install

```sh
npm run install-check      # list what an install would write; writes nothing
npm run install-extension  # copy changed files into ~/.pi-pocket/extensions/
```

The installer compares every file byte for byte and writes only those that differ, so installing unchanged source touches nothing. It never deletes: installed files the project doesn't have are listed and left alone. `PI_POCKET_DIR` selects another installation.

An install writes into the running server: a saved module reloads at once, and open tabs pick up browser changes. Installing never turns a module on or off and never restarts the server; Brian does both, in **Menu → Extensions**. Run `npm test` before every install.

# Team

## Try it

1. Review `team.ts` and `team-web/index.js`, then turn on **Team** in **Menu → Extensions**.
2. Create a normal session in your local project folder and choose its model in Pi Pocket.
3. Open **Your team** in the rail or launcher. Choose **Odrade**, then **Use Odrade in this session**. Return to the conversation and chat.
4. For a specialist, use another new session and select that person. The `/team-agent odrade` command also assigns an identity; `/team-agent clear` removes it.
5. Ask Odrade to delegate a self-contained task in an agent's repository, or choose the repository in the Team panel and press **Start linked task**. The child is an ordinary conversation in that repository's folder, even when Odrade's session is elsewhere.

The owner must enable the drop-in: Pi Pocket's extension policy explicitly reserves this action for the owner. Installing the files does not enable it or restart the server.

## What is preserved

Eight plain Markdown profiles live in `~/.config/pi-pocket-team/agents`: Odrade, Duncan Idaho, Moneo, Murbella, Sheeana, Miles Teg, Lucilla, and Bellonda. They contain each soul, responsibilities, role, preferred primary model, and repository-to-folder map. They are independent copies, so this extension does not need stomp or its VM.

Selecting a person stores their identity in that conversation. It persists across restart and follows a native conversation fork. Other sessions keep their own identities. Editing a profile affects subsequent selections; reselect it to update an existing session.

The import excludes notebooks, conversation histories, credentials, VM paths, MCP configuration, schedules, and stomp's house rules. The old workspace-tool and VM-only instructions in Murbella's and Sheeana's imported souls have been updated for local repositories. Pi Pocket supplies its own tools and provider configuration. Identities describe people; they do not configure providers.

## Repository ownership

Odrade owns the team and has no assigned repository. Her current folder is independent of the specialists' working folders. Repository mappings are read fresh for each delegation, so existing Odrade conversations see edits without reselecting her identity.

An agent's Markdown frontmatter can contain:

```yaml
repositories:
  frostyard/nsl: ~/projects/frostyard/nsl
  frostyard/intuneme: ~/projects/frostyard/intuneme
  frostyard/igloo: ~/projects/frostyard/igloo
```

Odrade calls `team_delegate` with `agent: "duncan"` and `repository: "frostyard/nsl"`. A single owned repository is selected automatically; with multiple repositories the tool requires a name from the map. The Team panel has the same choices and shows the destination folder before starting.

For non-repository work, `workspace: ~/projects/moneo` supplies a working folder. An agent with neither repositories nor a workspace inherits the source folder. All mapped paths are absolute or begin with `~/` and must exist when a task starts; delegation does not silently clone or create folders.

Current ownership:

| Agent     | Repositories / workspace                                                       |
| --------- | ------------------------------------------------------------------------------ |
| Odrade    | Team; no repository                                                            |
| Duncan    | frostyard/nsl, intuneme, igloo                                                 |
| Lucilla   | frostyard/updex, repogen, incus, bootc-debian, homebrew-tap, std, clix, gchlog |
| Murbella  | frostyard/snosi                                                                |
| Miles Teg | bketelsen/fleet                                                                |
| Bellonda  | bketelsen/homewiki                                                             |
| Sheeana   | bketelsen/pi-pocket, pi-pocket-team                                            |
| Moneo     | ~/projects/moneo (non-repository tasks)                                        |

Pi Pocket sets the child's actual working directory before the first request: project instructions, relative file tools, shell commands, and folder navigation use the destination. Odrade's session is unchanged. The normal linked-session return address carries reports back across folders.

## Prototype boundaries

- Direct identity selection keeps the existing model, folder, and history. Use a fresh session for a fresh task; select the model in Pi Pocket's native picker.
- Automatic delegation inherits the supervisor's model and thinking, and selects the specialist's repository folder. The Team panel can opt into a person's preferred model if Pi Pocket allows it under **Providers → Models for subagents**. Only the first model in an old fallback list is imported; there is no automatic fallback.
- This uses Pi Pocket's linked-session rules, including its limits. A specialist reports back through `team_message`; that report is model-driven, not an automatic completion hook. Odrade can do work directly or delegate one level.
- There is no automatic review workflow, scheduled duties, imported MCP setup, or shared notebook. This is a test of whether named people and task delegation are enough, before deciding what else is worth carrying over.
- Moving the app locally does not change a provider's content policies.

## Agent memory

Pi Pocket's memory has two scopes: a project (one repository or folder) and everywhere. An agent that owns several repositories gets its lessons split between them, and everywhere reaches every session. Team adds a third layer: lessons for one named agent. They apply in every session that carries that identity, linked tasks included, in whatever folder.

- **Pi proposes, Brian approves.** The `team_memory` tool (add, update, remove, list) acts on the session's identity. Everything Pi writes waits for the owner. A proposed change or forget leaves the lesson in force until it's approved, and an approval holds only if the text is still what the owner saw. Odrade, the supervisor, can also give `agent: <id>` to add or list lessons for a named agent.
- **The identity gate.** A drop-in's tool list is the same in every session, so `team_memory` is listed everywhere, but it refuses to work without a named identity. The guide for using it appears only in the `named_team` prompt section, and that section appears only with an identity.
- **The prompt.** The `named_team` section lists the approved lessons as "Lessons for <Name>, across all <Name>'s repositories", with a short guide. Repository facts go to the built-in `memory` tool with scope project. The agent's role, the owner's preferences for its work, and anything spanning its repositories go to `team_memory`. The section's text stays the same while the lessons do.
- **Review.** In the Team panel, each agent lists its lessons, waiting ones first, with Approve/Discard, Edit, and Forget. A lesson the owner adds there counts at once. The rail button's badge counts what waits, across all agents. All memory routes (`/api/x/team/memory…`) are owner-only.
- **Rules, as Pi Pocket's own memory:** a lesson is one line with invisible characters stripped, at most 300 characters. An agent keeps at most 40 approved lessons, and one writer may have at most 20 waiting for each agent. The pending cap is per agent: Brian is the one requester, so a single global cap would let one busy agent block the rest. A tool call that runs again after a restart finds the lesson it saved (keyed by task and call), so it never adds one twice.
- **Storage:** one app-wide document, `x.team.memory`: `{ agents: { <agentId>: { <lessonId>: lesson } } }`. Each lesson has its id, agent, text, who wrote it and whether Pi did, the source session, created and updated times, `pending`, and any `proposal`. It is stored data: never rename the kind or change what a field means.

## Team files

Runtime copies: `~/.pi-pocket/extensions/team.ts` and `team-web/`. The extension reads only its independent profile directory (override with `PI_POCKET_TEAM_AGENTS`). Its durable document is `x.team.identity`; UI routes are in the owner-only `/api/x/team/` namespace.

Runtime imports use Pi Pocket's public extension API and installed Pi packages. Test and preview scripts (`team.test.ts`, `team-memory.test.ts`, `preview.ts`) use the checkout's internal test harness, isolated temporary data, and a fake model. They are not installed.

Use the patched local Pi Pocket checkout. A server started before the working-directory change must be restarted before using repository delegation; the original API ignores `cwd`. Updating an upstream checkout without this patch, before #112 ships, removes cross-folder support.

The dependency and declaration links point to `~/projects/pi-pocket`; update those links if moving the checkout. `PI_POCKET_DIR` selects another installation destination.

For a one-time import from another stomp configuration, run `node import-stomp.mjs /path/to/stomp/config [extra-agent.md ...]`. Existing profiles are kept. The importer resolves model aliases but copies only the soul, role, and primary model. It does not copy credentials.

Disable **Team** in Extensions to remove the UI, tools, and prompt section. Stored identities remain available if it is re-enabled; ordinary conversations remain Pi Pocket conversations.

# Homewiki

The "Wiki" rail page shows `bketelsen/homewiki`, Bellonda's checkout, as it is on disk, uncommitted edits included. The page notes the checkout's commit and whether it has uncommitted edits.

- **Pages:** `README.md` and every `.md` file under `docs/`, skipping hidden files and folders. `README.md` comes first; the rest sort by their `order` frontmatter (none sorts last), then by path. The title is the frontmatter `title`, else the first `#` heading, else the path. A subfolder of `docs/` becomes a section.
- **Read-only, list-only:** `GET /api/x/homewiki/pages` returns the list; `GET /api/x/homewiki/page?path=…` serves a page only when `path` is exactly one in that list, with its frontmatter stripped. Anything else (`../`, absolute paths, `.git/config`, files outside `docs/`) is a 404. Both routes are owner-only.
- **Live:** a watcher on the checkout tells open tabs when a Markdown file changes, at most once a second, so Bellonda's edits show without a reload.

The wiki's content belongs to Bellonda; this module only renders it.
