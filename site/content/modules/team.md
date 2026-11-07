# Team

Team gives Pi Pocket named people. An identity is a Markdown profile: a name, a model, the repositories that person owns, and a home folder. In a session that carries the identity, Pi becomes that person. A supervisor delegates self-contained tasks into the agents' repositories, and each agent keeps its own lessons across every repository it tends.

Files: `team.ts` and `team-web/`. The module also adds a prompt section, the `team_delegate`, `team_work` and `team_memory` tools, and the "Your team" rail page.

## Turn it on, and use it

1. Review `team.ts` and `team-web/index.js`, then turn on **Team** in **Menu → Extensions**.
2. Create a normal session in your local project folder and choose its model in Pi Pocket.
3. Open **Your team** in the rail or launcher. Choose **Odrade**, then **Use Odrade in this session**. Return to the conversation and chat.
4. For a specialist, use another new session and select that person. The `/team-agent odrade` command also assigns an identity; `/team-agent clear` removes it.
5. Ask Odrade to delegate a self-contained task in an agent's repository, or choose the repository in the Team panel and press **Start linked task**. The child is an ordinary conversation in that repository's folder, even when Odrade's session is elsewhere.

Selecting a person stores their identity in that conversation. It persists across a restart and follows a native conversation fork. Other sessions keep their own identities.

## Write an agent profile

Profiles are Markdown files in `~/.config/pi-pocket-team/agents/`; `PI_POCKET_TEAM_AGENTS` selects another folder. The file name is the agent id: lowercase, and it must match `[a-z0-9][a-z0-9_-]*.md`. The body is the identity text, and its first `#` heading is the display name.

| Field          | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `model`        | `provider/model`. A list uses only the first model.   |
| `role`         | `supervisor`, `clerk`, or `agent`. Default: `agent`.  |
| `repositories` | Map of repository name to an absolute or `~/` folder. |
| `workspace`    | One folder, for non-repository work.                  |
| `home`         | The agent's home folder: absolute or `~/`.            |

An agent with several repositories gets its lessons split between them. Repository mappings are read fresh for each delegation, so an existing conversation sees an edit without reselecting the identity.

## Delegate

`team_delegate` takes an `agent`, a `task`, an optional `title`, and a `repository` when the agent owns more than one. A single owned repository is selected automatically. The tool's optional `title` names the desk thread and the linked session; without it, the task's first non-empty line is the title.

When the folder is the top of a git work tree, each delegation gets its own worktree beside the main checkout, at `<checkout>--<agent>-<slug>` on branch `<agent>/<slug>`, so 2 jobs in 1 repository share no folder and no branch. Remove the worktree when its pull request merges.

`repository: "home"` starts the task in the agent's own home instead, with no worktree. `team_work` does the same from inside an agent's home: it starts a linked session in a fresh worktree of 1 of its own repositories.

Before each desk-tracked start (a task, a shift, the Clerk, a plan, a plan consult), Team asks the desk to turn off the supervisor's run-end answers (Pi Pocket 0.28.0-bk.1 and later): the reports come by `team_message`, so a linked session's run end does not wake the supervisor. `team_work` and the Team panel's start do not ask, so their lead keeps its answers, unless that lead is a desk supervisor.

The Desk's goal board starts its shift rows through Team too, with `startShift`: the same start as `team_delegate` with `shift`, from the supervisor's session, under the board's key. A replay of the key starts nothing again. The board's start never takes the desk's last free slots or Brian's OKs, and a start whose result is unknown (Pocket's start threw) is never tried again by itself.

## Agent memory

Pi Pocket's memory has 2 scopes: a project, and everywhere. Team adds a third layer: lessons for 1 named agent, which apply in every session that carries that identity, linked tasks included.

- **Pi proposes, the owner approves.** The `team_memory` tool acts on the session's identity. A proposed change leaves the lesson in force until it is approved, and an approval holds only if the text is still what the owner saw.
- **Review on the page.** In the Team panel each agent lists its lessons, waiting ones first, with Approve, Discard, Edit and Forget. A lesson the owner adds there counts at once.
- **Rules.** A lesson is one line, at most 300 characters. An agent keeps at most 40 approved lessons, and one writer may have at most 20 waiting for each agent. A tool call that runs again after a restart finds the lesson it saved, so it never adds one twice.

## Limits and rules

- The owner must enable the drop-in: Pi Pocket's extension policy reserves that action for the owner. Installing the files does not enable it or restart the server.
- Automatic delegation runs the specialist on the model in its profile when Pi Pocket allows that model under **Providers → Models for subagents**; otherwise it runs on the supervisor's model, and the tool result says so. There is no automatic fallback: if the model cannot be used now, the tool fails and tells Pi to stop.
- A specialist reports back through `team_message`. That report is model-driven, not an automatic completion hook.
- There is no automatic review workflow, no scheduled duties, no imported MCP setup, and no shared notebook. This is a test of whether named people and task delegation are enough.
- All memory routes (`/api/x/team/memory…`) are owner-only. The durable documents `x.team.identity` and `x.team.memory` hold stored data: never rename a kind or change what a field means.
- Disable **Team** in Extensions to remove the UI, tools and prompt section. Stored identities remain available if it is re-enabled.

## Read more

The full detail is in the reference page: [Team](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/team.md), [writing an agent profile](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/team.md#writing-an-agent-profile), [repository ownership](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/team.md#repository-ownership), [agent homes](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/team.md#agent-homes), [agent memory](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/team.md#agent-memory) and [prototype boundaries](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/team.md#prototype-boundaries).

The Desk is where a delegation's thread lives: see [Desk](desk.md).
