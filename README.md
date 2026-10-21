# Your named agents in Pi Pocket

This drop-in gives Brian a Team panel, persistent identities in ordinary Pi Pocket conversations, and named delegation from Odrade to the specialists. Pi Pocket owns the local runtime, folders, providers, access modes, tools, and durable conversations. The local Pi Pocket checkout has one supporting API change: linked sessions accept an optional working directory. No upstream PR has been opened.

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
| Sheeana   | bketelsen/stomp                                                                |
| Moneo     | ~/projects/moneo (non-repository tasks)                                        |

Pi Pocket sets the child's actual working directory before the first request: project instructions, relative file tools, shell commands, and folder navigation use the destination. Odrade's session is unchanged. The normal linked-session return address carries reports back across folders.

## Prototype boundaries

- Direct identity selection keeps the existing model, folder, and history. Use a fresh session for a fresh task; select the model in Pi Pocket's native picker.
- Automatic delegation inherits the supervisor's model and thinking, and selects the specialist's repository folder. The Team panel can opt into a person's preferred model if Pi Pocket allows it under **Providers → Models for subagents**. Only the first model in an old fallback list is imported; there is no automatic fallback.
- This uses Pi Pocket's linked-session rules, including its limits. A specialist reports back through `team_message`; that report is model-driven, not an automatic completion hook. Odrade can do work directly or delegate one level.
- There is no automatic review workflow, scheduled duties, imported MCP setup, or shared notebook. This is a test of whether named people and task delegation are enough, before deciding what else is worth carrying over.
- Moving the app locally does not change a provider's content policies.

## Files and maintenance

Source: `/var/home/bjk/projects/pi-pocket-team`. Runtime copies: `~/.pi-pocket/extensions/team.ts` and `team-web/`. The extension reads only its independent profile directory (override with `PI_POCKET_TEAM_AGENTS`). Its durable document is `x.team.identity`; UI routes are in the owner-only `/api/x/team/` namespace.

Runtime imports use Pi Pocket's public extension API and installed Pi packages. Test and preview scripts use the checkout's internal test harness, isolated temporary data, and a fake model. Those development scripts are not installed.

Use the patched local Pi Pocket checkout. A server started before the working-directory change must be restarted before using repository delegation; the original API ignores `cwd`. Updating an upstream checkout without carrying this small patch also removes cross-folder support.

```sh
cd ~/projects/pi-pocket-team
npm test
./node_modules/.bin/tsc -p tsconfig.json
node --check team-web/index.js
npm run install-extension
```

The dependency and declaration links point to `~/projects/pi-pocket`; update those links if moving the checkout. `PI_POCKET_DIR` selects another installation destination.

For a one-time import from another stomp configuration, run `node import-stomp.mjs /path/to/stomp/config [extra-agent.md ...]`. Existing profiles are kept. The importer resolves model aliases but copies only the soul, role, and primary model. It does not copy credentials.

Disable **Team** in Extensions to remove the UI, tools, and prompt section. Stored identities remain available if it is re-enabled; ordinary conversations remain Pi Pocket conversations.
