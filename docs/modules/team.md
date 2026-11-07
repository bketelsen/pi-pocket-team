# Team

## Try it

1. Review `team.ts` and `team-web/index.js`, then turn on **Team** in **Menu → Extensions**.
2. Create a normal session in your local project folder and choose its model in Pi Pocket.
3. Open **Your team** in the rail or launcher. Choose **Odrade**, then **Use Odrade in this session**. Return to the conversation and chat.
4. For a specialist, use another new session and select that person. The `/team-agent odrade` command also assigns an identity; `/team-agent clear` removes it.
5. Ask Odrade to delegate a self-contained task in an agent's repository, or choose the repository in the Team panel and press **Start linked task**. The child is an ordinary conversation in that repository's folder, even when Odrade's session is elsewhere.

The owner must enable the drop-in: Pi Pocket's extension policy explicitly reserves this action for the owner. Installing the files does not enable it or restart the server.

## Writing an agent profile

Profiles are Markdown files in `~/.config/pi-pocket-team/agents/` (override with `PI_POCKET_TEAM_AGENTS`). The file name is the agent id: lowercase, and it must match `[a-z0-9][a-z0-9_-]*.md`. The body is the identity text; its first `# Heading` is the display name.

Frontmatter fields:

| Field          | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `model`        | `provider/model`. A list uses only the first model.                         |
| `role`         | `supervisor`, `clerk`, or `agent`. Default: `agent`.                        |
| `repositories` | Map of repository name to an absolute or `~/` folder.                       |
| `workspace`    | One folder, for non-repository work.                                        |
| `home`         | The agent's home folder: absolute or `~/`. See [Agent homes](#agent-homes). |

A supervisor, `lead.md`, named "Lead", with no repositories:

```markdown
---
role: supervisor
---

# Lead

Lead keeps the team pointed at the goal.

## Responsibilities

- Break work into self-contained tasks.
- Delegate to one agent at a time.
```

An agent, `alice.md`, named "Alice":

```markdown
---
model: anthropic/claude-sonnet-4-5
role: agent
repositories:
    example/web: ~/projects/web
---

# Alice

Alice makes the web front end small and fast.

## Responsibilities

- Keep the web build green.
- Report back with what changed.
```

## Repository ownership

Odrade owns the team. Her profile names a home, `~/agents/odrade`, and no repository. Her current folder is independent of the specialists' working folders. Repository mappings are read fresh for each delegation, so existing Odrade conversations see edits without reselecting her identity.

An agent's Markdown frontmatter can contain:

```yaml
repositories:
    frostyard/nsl: ~/projects/frostyard/nsl
    frostyard/intuneme: ~/projects/frostyard/intuneme
    frostyard/igloo: ~/projects/frostyard/igloo
```

Odrade calls `team_delegate` with `agent: "duncan"` and `repository: "frostyard/nsl"`. A single owned repository is selected automatically; with multiple repositories the tool requires a name from the map. The Team panel has the same choices and shows the destination folder before starting. The tool's optional `title` names the desk thread and the linked session; without it, the task's first non-empty line is the title, without a leading `Task:`, `Goal:`, or `Title:`. `repository: "home"` starts the task in the agent's own home; see [Agent homes](#agent-homes).
When the folder is the top of a git work tree, each delegation gets its own worktree beside the main checkout, at `<checkout>--<agent>-<slug>` on branch `<agent>/<slug>`, so 2 jobs in 1 repository share no folder and no branch. When the worktree cannot be made, the delegation works in the main checkout, and the tool result and the task say so in 1 sentence.

For non-repository work, a `workspace` supplies a working folder: the Clerk's profile has `workspace: ~/agents/odrade`. An agent with neither repositories nor a workspace inherits the source folder. All mapped paths are absolute or begin with `~/` and must exist when a task starts; delegation does not silently clone or create folders.

The tool takes an optional `shift` object, `{ objective?, stop_when, start?, until?, for?, max?, worker?, pr_check? }`: the linked session then runs a shift goal in rounds and reports back to Odrade's session when it stops. `night_shift` is its old name, with the same fields; a call that gives both is refused with `Give shift or night_shift, not both.`, before anything starts. A shift from the tool cannot have a free check command. `pr_check` is the only check it takes: a structured PR check, and the module builds the `gh` command. `worker` is the provider/model for subagents, such as `github-copilot/claude-sonnet-5.5`; it must be in the owner's allowed list for subagents. See [Delegated shifts](shift.md#delegated-shifts).

```json
{
    "agent": "duncan",
    "repository": "frostyard/nsl",
    "task": "Tend the release branch",
    "shift": {
        "objective": "Fix the flaky login tests",
        "stop_when": "the suite passes 3 times in a row",
        "start": "06:00",
        "for": "8h",
        "max": 30,
        "worker": "github-copilot/claude-sonnet-5.5",
        "pr_check": {
            "pr": 128,
            "repo": "frostyard/nsl",
            "checks": "required",
            "label": "ready-for-human"
        }
    }
}
```

## Agent homes

An agent can have a home: 1 folder of its own, such as `~/agents/duncan`, with an AGENTS.md, `notes/`, `plans/` and `reports/`, apart from every repository. The profile names it with `home:`. A home is a local git repository with no remote, and it never gets a worktree.

**Why a home only plans.** Pi loads AGENTS.md only from Pi's own folder, the session's folder, and the folders above it, never from a folder below. A session in a home never sees a repository's AGENTS.md, skills or project memory. So a change to a repository runs in a session that starts in that repository, which is the only place where its rules load.

**The home section.** For an identity with a home or repositories, the `named_team` section adds `Your home: <folder>` and `Your repositories:`, 1 line for each repository: its name, its folder, and the path of its root `AGENTS.md` when that file exists. Paths only: the section never holds a file's contents, and it runs no git command. When the session's folder is inside the agent's home, 4 rules come with it: read a repository's AGENTS.md before you answer about it; never change a repository from the home; start the work with `team_work`; in a linked session, report the plan to the session that started you. The supervisor's roster shows each member's home.

**Identity by folder.** A session whose folder is an agent's home (the home itself or a folder under it, by real paths) carries that agent's identity with no selection. The order is: the identity stored in the conversation; else an explicit clear; else the folder. The longest home wins, and 2 agents with 1 home give none. The session route says `implicit: true` when the folder gave it, and the status item pins such an identity once with `POST session/:source/pin`, in 1 commit, only when the folder still says so: a selection, a clear, or a folder that moved wins, and the route says why. The commit reads the session's folder again, so a folder that moves while the pin is made changes nothing. **Clear identity** (`POST session/:source/identity` with `agent: null`, or `/team-agent clear`) stores `cleared: true` beside the deleted `persona`: the folder must not bring the agent back. Selecting an agent deletes `cleared`. `x.team.identity` is stored data: the kind and the meaning of `persona` never change; `cleared` is a new field beside it.

**The guard.** When a session's folder is inside any agent's home, a `beforeTool` hook blocks an `edit` or `write` whose target is inside a roster repository folder, or a sibling worktree of it (`<folder>--*`). The block names the repository and says to start a repository session with `team_work`. A path inside the home is the agent's own. The guard resolves the target as Pi Durable does (`@` stripped, `~/`, `file://`, a no-break space as a space), against the session's own folder as Pocket stores it, and follows every symbolic link: also a link to a file that is not there yet, or a link to a folder. More than 40 links make the goal unknown, and the call is blocked. A profile folder it cannot read never blocks a session: it keeps the last good roster, and with none, no home is known. `bash` is not parsed: the home's AGENTS.md carries that rule, and a command heuristic would be wrong as often as right.

**`team_work`.** An agent (role `agent`) in a session inside its own home starts a linked session in a fresh worktree of 1 of its own repositories, with the tool `team_work`: `repository` (optional when it owns 1), `task` (1 to 6000 characters), `title` (optional, 120 at most). The child loads the repository's own AGENTS.md, skills and memory, and gets the identity and the profile model when the owner allows that model for subagents. It refuses a session with no identity, another role, a folder outside the agent's home, and an unknown repository, each with its own words. Pi Pocket refuses a start from a linked session, and the tool says so: "team_work works only in a top-level session. Report the plan to the session that started you." The result gives the address, the worktree path and its branch, and says to remove the worktree when its PR merges. It opens no desk thread: the agent keeps its own worktree and PR. A replay (`x.team.work:<task>:<call>`) finds the worktree it made and the session it started. A folder that is not the top of a git work tree gets no worktree, and the tool then refuses and starts nothing: `team_delegate` falls back to the main checkout, `team_work` does not. A start that Pi Pocket refuses takes away the worktree and branch this call made, with nothing forced; a worktree that a replay found, or that a linked session already works in, stays, and the error says where.

**`repository: "home"`.** `team_delegate`, and the Team page's **Start linked task**, take `repository: "home"`: the task starts in the agent's home itself, with no worktree, and its desk thread has no repository and `cwd` = the home. It refuses an agent whose profile has no home. Without a repository, an only repository or a workspace, the home is the default target. With 2 or more repositories and none named, the error lists them and `home`. Code work with a repository still gets its worktree, also when the supervisor's own session is in a home. A Clerk keeps its `workspace`. On the Team page each agent card shows `Home: <folder>` and the hint "Star this folder in New session to get a launcher entry", and the repository picker offers `home`.

## Brian's team (an example)

Brian's own team has Dune names. It is only an example; write your own profiles as above.

The profiles in `~/.config/pi-pocket-team/agents/` are the only list of the team. This page does not copy them: a copied list drifts as agents and repositories come and go. The team has 3 roles:

- **Supervisor** (`role: supervisor`): Odrade. She plans, delegates with `team_delegate`, and works the Desk. Her profile has a home and no repository.
- **Clerk** (`role: clerk`): takes the routine desk news off the supervisor (see [Desk](desk.md#desk)). Its profile has its own `model` and a `workspace`, and no repository.
- **Specialists** (`role: agent`): each owns 1 or more repositories and has a home under `~/agents/`.

To see who owns what now, read the profiles' frontmatter, open **Your team** (each agent shows its home, its preferred model and its repositories), or read the roster in the supervisor's prompt.

Selecting a person stores their identity in that conversation. It persists across restart and follows a native conversation fork. Other sessions keep their own identities. Editing a profile affects subsequent selections; reselect it to update an existing session.

Pi Pocket sets the child's actual working directory before the first request: project instructions, relative file tools, shell commands, and folder navigation use the destination. Odrade's session is unchanged. The normal linked-session return address carries reports back across folders.

**Run-end answers before a desk-tracked start.** Since Pi Pocket 0.28.0, a linked session's run end goes to the session that started it, and starts a run there. Reports come by `team_message` to the desk, so before each desk-tracked start Team calls the desk's optional `reportsOff` for the supervisor, outside any commit: a delegated task, a shift, the Clerk, a plan start (from `team_delegate` and from the Desk page's New plan), and a plan consult. The desk turns the supervisor's run-end answers off once (Pocket's `linkedSessions.reports`, Pi Pocket 0.28.0-bk.1 and later), and records it; see [Desk](desk.md#what-these-parts-do). A failure is 1 warning notice in the supervisor's session, and the start goes on. An older desk has no `reportsOff`: Team skips the call. `team_work` and the Team panel's **Start linked task** do not call it, so their lead keeps its answers, unless that lead is a desk supervisor: the switch is on the lead, so it holds for every session the lead started.

## Prototype boundaries

- Direct identity selection keeps the existing model, folder, and history. Use a fresh session for a fresh task; select the model in Pi Pocket's native picker.
- Automatic delegation (`team_delegate`) runs the specialist on the model in its profile when Pi Pocket allows that model under **Providers → Models for subagents**; otherwise it runs on the supervisor's model, and the tool result says so. Odrade's roster shows each agent's model. Thinking stays at the supervisor's level or lower. If core refuses the start (the model can't be used now), the tool fails and tells Pi to stop and tell the user, not to try another model. Delegation selects the specialist's repository folder. The Team panel's start can also opt into a person's preferred model. Only the first model in an old fallback list is imported; there is no automatic fallback.
- This uses Pi Pocket's linked-session rules, including its limits. A specialist reports back through `team_message`; that report is model-driven, not an automatic completion hook. The supervisor can do work directly or delegate one level.
- There is no automatic review workflow, scheduled duties, imported MCP setup, or shared notebook. This is a test of whether named people and task delegation are enough, before deciding what else is worth carrying over.
- Moving the app locally does not change a provider's content policies.

## Shifts from the Desk's goal board

The Desk's goal board starts its rows through Team, never through a model: `startShift` on Team's global API (`Symbol.for("pi-pocket-team.team")`). It is the same start as `team_delegate` with `shift`, from the supervisor's session: the persona, the worktree, the desk thread, the identity, the allowed model (the agent's profile model when the owner allows it for subagents, else the supervisor's), and the goal. `team_delegate` and `startShift` share 1 function, `delegate(deps, args)` in `team.ts`; `deps` holds the source session, the key, the commit, the context, the reader, the router's memo, and the optional `limit`.

- **The request:** `{ supervisor, read, commit, context, key, agent, repository?, title, task, shift: { objective?, stop_when, max, for, worker?, pr_check? }, limit: { reserve } }`. The board gives `for` (a length of time), never `until` or `start`. With `limit`, the desk's open refuses at the cap minus `reserve` and never uses an OK, and a refusal is not recorded for the page's **Allow 1**.
- **The result:** `{ thread, session, address, replay }`, or `{ error, unknown }` (with `deskFull: true` when the desk's open refused at the limit). `unknown` is true only when Pocket's `linkedSessions.start` threw, or the thread of the key closed before its session was bound (a thrown start of an earlier try): Pocket may have admitted the session. Team's own refusals (a model not on the allowed list, a bad `pr_check`, no such repository, a source that is not a supervisor's) give `unknown: false`, in `team_delegate`'s words. It never throws.
- **A replay** with the same key returns the first result with `replay: true`, and starts nothing again. `team_delegate`'s results, errors, replay and key (`x.team.delegate:<task>:<call>`) do not change. A board start's router record is kept in memory for the call only (a tool call keeps it in its memo).

## Agent memory

Pi Pocket's memory has two scopes: a project (one repository or folder) and everywhere. An agent that owns several repositories gets its lessons split between them, and everywhere reaches every session. Team adds a third layer: lessons for one named agent. They apply in every session that carries that identity, linked tasks included, in whatever folder.

- **Pi proposes, Brian approves.** The `team_memory` tool (add, update, remove, list) acts on the session's identity. Everything Pi writes waits for the owner. A proposed change or forget leaves the lesson in force until it's approved, and an approval holds only if the text is still what the owner saw. Odrade, the supervisor, can also give `agent: <id>` to add or list lessons for a named agent.
- **The identity gate.** A drop-in's tool list is the same in every session, so `team_memory` is listed everywhere, but it refuses to work without a named identity. The guide for using it appears only in the `named_team` prompt section, and that section appears only with an identity.
- **The prompt.** The `named_team` section lists the approved lessons as "Lessons for <Name>, across all <Name>'s repositories", with a short guide. A lesson about one repository goes in that repository by a PR (a test, an `AGENTS.md` rule, or a `.memory/corrections.jsonl` line); the built-in `memory` tool with scope project keeps only facts of this machine. The agent's role, the owner's preferences for its work, and anything spanning its repositories go to `team_memory`. The section's text stays the same while the lessons do.
- **Review.** In the Team panel, each agent lists its lessons, waiting ones first, with Approve/Discard, Edit, and Forget. A lesson the owner adds there counts at once. The rail button's badge counts what waits, across all agents. All memory routes (`/api/x/team/memory…`) are owner-only.
- **Rules, as Pi Pocket's own memory:** a lesson is one line with invisible characters stripped, at most 300 characters. An agent keeps at most 40 approved lessons, and one writer may have at most 20 waiting for each agent. The pending cap is per agent: Brian is the one requester, so a single global cap would let one busy agent block the rest. A tool call that runs again after a restart finds the lesson it saved (keyed by task and call), so it never adds one twice.
- **Storage:** one app-wide document, `x.team.memory`: `{ agents: { <agentId>: { <lessonId>: lesson } } }`. Each lesson has its id, agent, text, who wrote it and whether Pi did, the source session, created and updated times, `pending`, and any `proposal`. It is stored data: never rename the kind or change what a field means.

## The supervisor button

The rail has a second Team button, with the supervisor's name ("Odrade") and a chess-queen icon: the piece that moves the whole board, with 3 rays above her crown. It shows on the phone's home screen too, and the launcher has "Open Odrade's session". One tap opens the supervisor session that the Desk binds threads to: when there are more, the one with the newest desk event. PiP stays the front door for spoken requests (it messages Odrade with `[via PiP]`); this button is the 1-tap way to her session.

- **What it opens.** `GET /api/x/team/supervisor` (owner-only, read only) asks the Desk (`supervisors` on its global API) for every supervisor conversation that has a thread, newest `lastEventAt` first. It keeps those the owner can see, and prefers one that is not archived; an archived one still opens, with a warning.
- **No bound session.** With the Desk off, or no thread bound to a supervisor yet, a tap only shows a notice. It opens, starts, and changes nothing.
- **The badge** counts the open asks for Brian on that supervisor's threads that are not parked or closed. The button asks again once a minute while the tab shows, when the tab shows again, and at each tap.

## Team files

Runtime copies: `~/.pi-pocket/extensions/team.ts` and `team-web/`. The extension reads only its independent profile directory (override with `PI_POCKET_TEAM_AGENTS`). Its durable document is `x.team.identity` (`persona`, and `cleared` for an explicit none); UI routes are in the owner-only `/api/x/team/` namespace.

Runtime imports use Pi Pocket's public extension API and installed Pi packages. Test and preview scripts (`team.test.ts`, `team-memory.test.ts`, `preview.ts`) use the checkout's internal test harness, isolated temporary data, and a fake model. They are not installed.

Pi Pocket v0.21.0 or later (Pi Durable 1.4) has the working-directory support (PR #112) that repository delegation needs. The links to the checkout come from `npm run link`. `PI_POCKET_DIR` selects another installation destination.

Disable **Team** in Extensions to remove the UI, tools, and prompt section. Stored identities remain available if it is re-enabled; ordinary conversations remain Pi Pocket conversations.
