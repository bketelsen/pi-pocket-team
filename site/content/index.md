---
title: pi-pocket-team
description: "Drop-in extensions for Pi Pocket: named agents, a desk of background work, night shifts, a wiki page, a terminal page and a shadow model router."
hide:
    - navigation
    - toc
---

<div class="fy-hero" markdown>
<div class="fy-hero__text" markdown>
<p class="fy-eyebrow">pi-pocket-team</p>

# pi-pocket-team

<p class="fy-hero__lede">Drop-in extensions for Pi Pocket, written for Brian Ketelsen's own server and shared as they are. Six modules extend one server: named agents that delegate work, a desk that keeps the work in the background, night shifts, a wiki page, a terminal page, and a shadow router that only records.</p>

[Install into Pi Pocket →](getting-started/install.md){ .md-button .md-button--primary }
[Build and test](contributing/build.md){ .md-button }

</div>
<img class="fy-hero__icon" src="assets/logo.svg" alt="">
</div>

pi-pocket-team is a set of drop-in extensions for [Pi Pocket](https://github.com/TannerMidd/pi-pocket). Every module is a plain source file that runs inside the server you already use. An install writes the changed files into the server's extensions folder, and a saved module reloads at once.

## The modules

<div class="grid cards" markdown>

- **[Team](modules/team.md)**

    ***

    Named agents in ordinary sessions, a supervisor's delegation into their repositories, and each agent's own memory.

- **[Homewiki](modules/homewiki.md)**

    ***

    The "Wiki" rail page: a Markdown wiki checkout rendered live from disk, read-only and owner-only.

- **[Night shift](modules/night-shift.md)**

    ***

    Pi works on an objective in rounds while you sleep, until a stop condition, a round limit or a deadline, then writes a summary.

- **[Model router](modules/model-router.md)**

    ***

    Shadow only: records the model tier and model it would pick for a delegated night shift, on the desk thread.

- **[Desk](modules/desk.md)**

    ***

    One thread for each piece of work the team runs in the background: its agents, its PRs, its asks and its reports.

- **[Terminal](modules/terminal.md)**

    ***

    The "Terminal" rail page: an interactive login shell as the server's user, in a folder you pick.

</div>

## Start here

<div class="grid cards" markdown>

- <span class="fy-index">01</span> **[Install](getting-started/install.md)**

    Check the requirements, then install the modules into your Pi Pocket.

- <span class="fy-index">02</span> **[Team](modules/team.md)**

    Write an agent profile and delegate the first task.

- <span class="fy-index">03</span> **[Desk](modules/desk.md)**

    Read the threads, answer the asks, and see what waits on you.

- <span class="fy-index">04</span> **[Build and test](contributing/build.md)**

    Run the checks, and build this site yourself.

</div>

## Where the detail is

These pages summarize. The full detail, with every setting, limit and test, is in the [README](https://github.com/bketelsen/pi-pocket-team#readme). The maintainer contracts, the design notes, the ADRs and the plans are in [docs/](https://github.com/bketelsen/pi-pocket-team/tree/main/docs).
