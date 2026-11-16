# 0004 — Agents follow lodge events through a bridge drop-in

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

frostyard's apps on lodge (the hub) publish thin CloudEvents on a NATS JetStream
broker (lodge ADR-0022). A client with the OAuth scope `events` makes a durable
subscription through `PUT /gateway/events/<name>` (lodge ADR-0023, ADR-0024):
lodge checks the client's grant, makes 1 pull consumer filtered to what the
grant can read, and the client pulls from it over `wss://<lodge>/nats`. An event
carries no content: the agent reads the object through its gateway tools.

The named agents run in Pi Pocket. An agent that follows an app (for example
Chani and frostmarks) must wake when an event comes, without a model call per
event, without waking Brian's chat with the agent, and without losing or
repeating an event across a server restart. Pi Pocket 0.29.0 adds
`host.inbox.deliver`: outside data, fenced, once for each key, within an hourly
limit. Drop-ins import only Pi Pocket's own packages: no npm install.

## Decision

The drop-in `events-bridge.ts` does it, for each named agent whose profile
`mcp:` list names a `mcp.json` entry with lodge's gateway URL (path
`/gateway/mcp`):

- **Credential.** Its own OAuth client for each agent (pi-mcp's sign-in, dynamic
  registration, PKCE), scope `events`, signed in by the owner on lodge's consent
  page. The tokens are in `~/.config/pi-pocket-team/events-bridge/<agent>.json`
  (0600), hidden from tools with `host.hide`. The bridge never reads or writes
  the `mcp` module's `oauth.json`: the agent's gateway entry keeps its own
  client and token, under the same grant.
- **Broker.** A vendored, pinned nats.js (`@nats-io/nats-core` 3.4.0 and its 3
  dependencies) bundled into 1 file, `_events-bridge-nats.mjs`, by
  `scripts/vendor-nats.mjs`. A test pins the bundle's SHA-256. The bridge pulls
  only from the consumers that lodge made, 1 message at a time, and never
  calls another JetStream API.
- **Store.** 1 file for each agent, `<agent>.events.json` (0600): the
  subscriptions, the undelivered events (batched or in the digest), the event ids
  seen, the wakes of the last hour, and the standing events session. An event is
  written before its JetStream ack. A delivery key is stable (the first event's
  id for a batch, the day for a digest), and the store fixes each message's
  events and its target session before a try. Pocket counts a key in 1 session,
  so a try cut off by a crash goes again to the same session: a restart neither
  loses nor repeats a wake.
- **Wakes.** Mode `now`: 60 s batches, at most 6 wakes an hour for each agent and
  subscription, through `host.inbox.deliver`; a 429 moves the batch to the
  digest; a 409 retries the same key, at most 5 times. Mode `digest`: 1 message
  at 08:00 America/New_York, or the tool `events_pending`. A wake goes to the
  agent's standing events session (`<Agent> events`, in its home), which the
  bridge makes once, checks at each delivery, and makes again when it is gone.
  Brian's chat with the agent never gets a wake.
- **Safety.** Events the agent wrote itself are dropped. A revoke (a 401 from
  lodge, or a consumer that lodge removed) deletes the undelivered events. A
  refresh that fails pauses the agent's subscriptions and posts 1 notice to its
  events session.
- **Tools.** `events_subscribe`, `events_list`, `events_unsubscribe` and
  `events_pending`. The profile's `mcp:` list gates them by Team's walk (the same
  as the MCP guard).

CI tests only Pi Pocket releases with `host.inbox`: the matrix pins v0.29.0.

## Consequences

- An agent follows an app with 1 tool call and 1 sign-in by Brian. lodge keeps
  the permission checks; the bridge holds no grant of its own.
- The vendored bundle is a supply-chain surface. It changes only through the
  vendor script, with its pinned versions and integrity hashes, and the test pin.
  A change to it needs a server restart (a `_` helper is not reloaded).
- The bridge needs Pi Pocket 0.29.0 or later. On an older server, its tools say
  so and do nothing; the rest of the project still runs.
- The sign-in has no callback route: Brian pastes the loopback address that his
  browser shows after the consent page. A callback route can replace this later.
- The identity check of the events session is by its folder (the agent's home)
  before a delivery, and by Team's walk in the session's prompt section after.
  A session moved to another agent by hand gets 1 more wake before a new one.
- Pocket counts the hourly limit in memory; the store counts it too, so a
  restart does not reset the cap.

## Alternatives considered

- **The `mcp` module's token for events too:** refused. Its `oauth.json` belongs
  to Pi's MCP client, and 2 users of 1 refresh token lose it at rotation. A
  separate client under the same grant costs nothing.
- **A webhook from lodge to Pocket:** refused. It needs an inbound route on the
  team VM and a second delivery queue; lodge's JetStream already keeps the
  events and redelivers them.
- **nats.js from npm at install time:** refused. Drop-ins take no npm imports,
  and the install must write the same bytes each time.
- **Wakes in Brian's chat with the agent:** refused (plan T1913, a standing
  events session): a wake there interrupts his work and mixes event noise into
  the chat.

## References

- Shapes: [modules/events-bridge.md](../modules/events-bridge.md)
- Builds on: lodge ADR-0022 (NATS broker), ADR-0023 (OAuth), ADR-0024 (gateway);
  [ADR-0003](0003-verify-gate-risk-paths-and-corrections.md) (the gate)
