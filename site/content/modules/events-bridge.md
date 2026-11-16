# Events bridge

A named agent can follow the events of a lodge app (for example new bookmarks in frostmarks) and wake when they come. Each agent has its own lodge sign-in (scope `events`), its own subscriptions, and its own standing session, `<Agent> events`, in its home. Your chat with the agent never gets these wakes.

Files: `events-bridge.ts` and the vendored NATS client `_events-bridge-nats.mjs`. It needs Pi Pocket 0.29.0 or later and the Team module.

## Who gets it

An agent whose profile `mcp:` list names an entry of Pi's `mcp.json` with lodge's gateway URL (it ends in `/gateway/mcp`). Other sessions get a refusal from each tool.

## Tools

- `events_subscribe(topic_prefix, mode)`: follow a topic, such as `marks.bookmark`. `now` wakes the agent in 60 s batches, at most 6 times an hour for each subscription; `digest` sends 1 message a day at 08:00 New York time. Only the owner can start it. The first call asks you to sign the bridge in.
- `events_list`: the subscriptions, what waits, and whether the bridge is paused.
- `events_unsubscribe(id)`: end a subscription; what waits for it is deleted.
- `events_pending`: read what waits in the digest now.

The agent needs a grant first: it asks with its gateway's `request_access`, and you approve it on lodge's consent page.

## Sign in

The first subscription shows a card. Open its lodge link, check that the principal is the agent's id with the scope `events`, and approve. Your browser then opens a `http://127.0.0.1:8792/...` address that does not load: copy that whole address into the card. The tokens go to `~/.config/pi-pocket-team/events-bridge/<agent>.json`, readable only by the server's user, and are hidden from tools. If a refresh fails, the bridge pauses and the events session gets 1 notice; ask the agent to subscribe again to sign in.

## What to expect

- An event carries no content: the agent reads the object through its gateway tools.
- A busy session, or the hourly cap, moves a batch to the digest; nothing is lost.
- The agent's own events are dropped. If lodge revokes the client, the events that wait are deleted.
- A restart neither loses nor repeats a wake.

The full reference is [docs/modules/events-bridge.md](https://github.com/bketelsen/pi-pocket-team/blob/main/docs/modules/events-bridge.md).
