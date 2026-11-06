# Home seed

`homes/seed.mjs` makes each agent's home folder, `~/agents/<id>/`: a local git repository with no remote, an `AGENTS.md` with the agent's charter and its repositories, and the folders `notes/`, `plans/` and `reports/`. It reads the `home:` field of the profile, writes nothing over an existing file, and leaves a folder that is already a git repository as it is. `--check` prints what it would do; `--agent <id>` seeds 1 agent. See [homes/README.md](../../homes/README.md). How a session uses a home: [Agent homes](team.md#agent-homes) under Team.
