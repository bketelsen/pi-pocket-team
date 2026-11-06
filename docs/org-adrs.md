# Org-wide decisions (frostyard/core ADRs)

Conventions this repository follows that are decided at the org level are recorded as ADRs in
[frostyard/core](https://github.com/frostyard/core/tree/main/docs/adr). This repository is in the bketelsen account,
not the frostyard organization; Brian holds it to the same baseline (T960f, 2026-11-05). The ones that bind
pi-pocket-team:

- [ADR-0002 — Agent-portable instruction surface](https://github.com/frostyard/core/blob/main/docs/adr/0002-agent-portable-instruction-surface.md): one canonical [`AGENTS.md`](../AGENTS.md); `CLAUDE.md`, `GEMINI.md`, `.cursorrules` and `.github/copilot-instructions.md` are symlinks to it, and `.claude/skills` is a symlink to `.agents/skills/`. The local copy is [ADR-0002](adr/0002-agent-portable-instruction-surface.md).
- [ADR-0018 — Org-wide agent instruction and knowledge surfaces](https://github.com/frostyard/core/blob/main/docs/adr/0018-org-wide-agent-instruction-and-knowledge-surfaces.md): durable corrections live in the append-only `.memory/corrections.jsonl` (5 fields: `date`, `scope`, `correction`, `evidence`, `promoted_to`; see `.memory/README.md`).
- [ADR-0019 — Repository governance as machine-readable policy with risk tiers](https://github.com/frostyard/core/blob/main/docs/adr/0019-governance-as-code-and-risk-tiers.md): the PR template `.github/pull_request_template.md` declares a risk tier.
- [ADR-0021 — SHA-pinned actions and least-privilege CI workflows](https://github.com/frostyard/core/blob/main/docs/adr/0021-sha-pinned-actions-and-least-privilege-ci.md): every action in `.github/workflows/` is pinned to a commit SHA with a `# vX.Y.Z` comment, each workflow has `permissions: {}` at the top and `contents: read` for each job, and checkout sets `persist-credentials: false`.
- [ADR-0025 — One docs/ tree per repository, in core's four-category shape](https://github.com/frostyard/core/blob/main/docs/adr/0025-consolidate-repository-docs-into-docs.md): this `docs/` tree in `adr/`, `design/`, `specs/` and `plans/`, indexed in [docs/README.md](README.md). The docs from before the shape are indexed where they are.
- [ADR-0029 — ACMM conformance via canonical aliases](https://github.com/frostyard/core/blob/main/docs/adr/0029-acmm-conformance-via-canonical-aliases.md): the alias files above are committed relative symlinks, never copies.
- [ADR-0040 — Publish the repository settings contract](https://github.com/frostyard/core/blob/main/docs/adr/0040-publish-the-repository-settings-contract.md): `SECURITY.md` names GitHub private vulnerability reporting.
- [ADR-0043 — Pin repository tools in mise and name the verify gate](https://github.com/frostyard/core/blob/main/docs/adr/0043-pin-repository-tools-in-mise-and-name-the-verify-gate.md): `mise.toml` pins Node, with a committed `mise.lock`; CI installs Node from them.
- [ADR-0044 — Expose the make gate triad in every repository](https://github.com/frostyard/core/blob/main/docs/adr/0044-expose-the-make-gate-triad-in-every-repository.md): the `Makefile` exposes `make verify` (non-mutating), `make check` (formats, then verifies) and `make ci` (the gate CI runs).
- [ADR-0051 — ADRs state facts only, not the process that produced them](https://github.com/frostyard/core/blob/main/docs/adr/0051-adrs-state-facts-not-process.md): every ADR in [adr/](adr/) gives context, decision, consequences and alternatives only.
- [ADR-0068 — Label pull requests that touch high-risk paths](https://github.com/frostyard/core/blob/main/docs/adr/0068-label-pull-requests-that-touch-high-risk-paths.md): `.github/risk-paths.json` lists this repository's high-risk paths, and the caller `.github/workflows/risk-paths.yml` applies the `risk:high` label. The local copy is [ADR-0003](adr/0003-verify-gate-risk-paths-and-corrections.md).
- [ADR-0071 — Hold every code repository to one baseline](https://github.com/frostyard/core/blob/main/docs/adr/0071-hold-every-code-repository-to-one-baseline.md): rows B1 to B16 of core's [repository baseline spec](https://github.com/frostyard/core/blob/main/docs/specs/repository-baseline.md). B8 and B11 do not apply (no `go.mod`).

When changing behavior covered by one of these, update or supersede the ADR in frostyard/core first, then change this
repository in the same effort.
