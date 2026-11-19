# Events bridge

The events bridge wakes a named agent when a lodge app publishes an event that the agent follows. Each agent has its own lodge OAuth client (scope `events`), its own durable subscriptions, and its own standing events session, `<Agent> events`, in its home. Brian's chat with the agent never gets a wake.

Files: `events-bridge.ts`, and the vendored NATS client `_events-bridge-nats.mjs` (made by `scripts/vendor-nats.mjs`). It needs Pi Pocket 0.29.0 or later (`host.inbox`) and the Team module. Why it is built this way: [ADR-0004](../adr/0004-agents-follow-lodge-events-through-a-bridge.md); why it holds events until Team and lodge confirm them: [ADR-0005](../adr/0005-events-bridge-holds-events-until-confirmed.md).

## Who gets it

An agent whose profile `mcp:` list names an entry of Pi's `mcp.json` whose URL is a lodge gateway (path `/gateway/mcp`, `https`, or `http` on loopback). For example Chani, with `mcp: [frostnotes, frostmail, chani-lodge]`. Team's walk decides the agent of a session (the same walk as the MCP guard): a subagent or a linked session of the agent counts as the agent. Any other session gets a refusal from each tool, and no prompt section.

## Tools

All 4 are deferred: the agent loads them with tool search.

| Tool                                   | What it does                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events_subscribe(topic_prefix, mode)` | Follows the events under a topic prefix, such as `marks.bookmark` or `marks`. `mode` is `now` or `digest`. The same topic again changes the mode. Only the owner can start it: the first call asks Brian to sign the bridge in. |
| `events_list`                          | The subscriptions, their waiting events, the wakes of this hour, the pause state, the events session, and the subscriptions that ended.                                                                                         |
| `events_unsubscribe(id)`               | Ends a subscription at lodge and deletes its waiting events.                                                                                                                                                                    |
| `events_pending(max?)`                 | Reads the events that wait in the digest, oldest first (40 by default, 100 at most). They count as delivered once read. While the bridge holds events (see [Holds](#holds)), it gives none and says why.                        |

A subscription needs a grant: the agent asks with its gateway's `request_access`, and Brian approves it on lodge's consent page. lodge refuses a topic that the grant does not reach (`403`), and filters each consumer to the paths the grant can read.

## Sign-in

The first `events_subscribe` shows Brian a card:

1. Open the lodge address on the card.
2. On lodge's consent page, the principal must be the agent's id, with the scope `events`. Approve it.
3. The browser then goes to `http://127.0.0.1:8792/events-bridge/callback?...`, which does not load. Copy the whole address from the address bar into the card's field.

The tokens go to `~/.config/pi-pocket-team/events-bridge/<agent>.json` (0600). Each token is hidden from tools (`host.hide`) before the write that stores it, and every token file is read and hidden before the module counts as loaded; a file whose tokens cannot be hidden is deleted, and that agent signs in again. A rotated token is released after the write that replaces it, so each agent holds 2 hidden values. When Pocket refuses to hide a token, nothing is written. The hidden values stay across a reload. The bridge never uses the `mcp` module's `oauth.json`. A refresh that fails pauses the agent's subscriptions, and the events session gets 1 notice; a notice that does not go is tried again after 30 s, doubled each time, 1 hour at most. While paused, no event leaves the bridge (see [Holds](#holds)). The next `events_subscribe` signs in again and ends the pause.

## Wakes

- **now:** events are batched for 60 s from the first one. A batch is 1 message to the events session, through `host.inbox.deliver`, at most 6 an hour for each subscription. When its delivery starts, the store fixes its events (at most 40, and only the lines that fit in 7,000 characters, because Pocket cuts a payload at 8,000; the rest go to the digest) and its place in the hour, so a restart keeps both. Past the cap, or on a `429`, the batch goes to the digest and gives its place back. A `409` (the session does not take messages now) is tried again with the same key after 30 s, 1, 2, 4 and 8 minutes: 5 times at most, then the digest. A `410` (the session is gone) makes a new events session and tries again at once.
- **digest:** 1 message a day at 08:00 America/New_York with the oldest events that fit (40 at most). The store fixes that message's day (its key) and events before the first try; a retry, a restart or a later day sends that same message. The rest wait for `events_pending` or the next day. The digest keeps 1,000 events; past it, the oldest go (never those of the message on its way), and the next message counts them.
- Each write checks the store again: a revoke or an unsubscribe while the bridge waits (for example for a new session) deletes the batch, and nothing goes.
- Each message lists 1 event per line: time, type, subject, selector, author and id. An event carries no content: the agent reads the object through its gateway tools. Pocket fences the lines as outside data. The type `org.frostyard.lodge.resync` means that events were lost.
- The prompt section of the agent's sessions counts the events in the digest.

## The events session

The bridge makes 1 standing session per agent, `<Agent> events`, in the agent's home (so Team gives it the agent's identity), on the profile's model as Team's `roster()` gives it (none for a worker-only model such as MAI-Code: the session then takes the source's model). It records the session's id. Before each delivery it checks that the session is still in the agent's home, not archived, and that Team confirmed its identity in this process; Pocket's `410` says it is gone. Team's rule applies: the session's explicit identity first, its folder only when it has none. A background delivery cannot read documents, so the confirmation comes from a read with a reader: the bridge's prompt section (in any session's turn) and each of its tool calls ask Team (`persona`) who the recorded session is. The answer is kept in memory only. Team tells the bridge each explicit identity change (`Symbol.for("pi-pocket-team.identity-changed")`), and the bridge then asks again; an answer from a read that started before the change counts for nothing. After a restart, the recorded session waits for a new confirmation, and its events wait with it (no try counted). When Team names another agent, or none, the next delivery makes a new session, with a new key. A session the bridge makes counts as confirmed only when its start began in this process: the bridge marks a start in the store (`starting`) before it begins, and a start after a restart that finds the mark gets back the session of the same key, which may be older, so it waits for a check. Each delivery checks the gates again right before it calls Pocket (the holds, the session's identity and folder, and a revoke or an unsubscribe of its events' subscriptions); one that fails after the try's store write puts the batch or the digest message back, with no try counted, and the next try leaves out the revoked events. A new session starts from the chat where Brian last signed the bridge in, as an ordinary session: its answers never go back to that chat.

## Holds

No event leaves the bridge (no batch, no digest, no `events_pending` answer) while:

- the bridge is paused (a refresh failed, or lodge refused a token);
- lodge has not confirmed the client in this process: at start and after a sign-in, the bridge lists its subscriptions at lodge first. A refused token pauses it (a `401` also deletes the undelivered events). A subscription that lodge no longer lists loses its undelivered events, and the bridge subscribes it again. So a client revoked while the bridge was down never delivers the events stored before;
- the events session waits for Team's confirmation (above). The pause notice waits for it too.

A held batch keeps its state: no try counts, and a batch that has not started takes no place in the hour. A held `events_pending` call takes no event and stores no answer; a hold that comes during the answer's own store write puts its events back (except those of a subscription that a revoke or an unsubscribe reached meanwhile), and a revoke or an unsubscribe during that write removes its events from the answer. A lodge check that a pause or a sign-in overtook changes nothing, also through the resubscriptions it started.

## What it keeps

`~/.config/pi-pocket-team/events-bridge/` (`PI_POCKET_TEAM_EVENTS_DIR` in tests), 0700:

- `<agent>.json`: the OAuth client and tokens (pi-mcp's format).
- `<agent>.events.json`: the subscriptions, the events not yet delivered (batched or in the digest), the ids of events seen in the last 8 days, the wakes of the last hour, the events session, the pause, and the digest's last day.

An event is in the store before its JetStream ack. A delivery's key is stable (`eb-<agent>-b-<first event id>` for a batch, `eb-<agent>-digest-<day>` for a digest), and Pocket delivers a key once in 1 session. The store marks a try before it starts: a try that ends with no answer (a crash) is tried again in the same session while that session is still in the agent's home, so Pocket sends nothing twice, and a crash before or after a delivery gives 1 delivery. Pocket has no receipt to ask, so when that session is gone or moved, or the tries run out, the events go again (to a new events session or the digest), each line marked `repeat=maybe` (in the inbox message and in `events_pending`): they are never lost, and the agent checks their ids. Such a try keeps its mark, and its wake stays counted in the hour, until its batch ends; its repeat to a new session takes 1 more place in the hour, or goes to the digest when the hour is full. A late wake counts in the hour from when it went. An event that comes again (a lost ack) is acked and dropped. `events_pending` keeps its newest 100 answers by tool call (older ones for 8 days), and the tool is replay-safe: a replay after a crash gets the same events, within that bound (Pocket does not tell the bridge when a tool result is recorded). A stopped bridge (a reload) waits for every pull and writes nothing after its stop.

## Drops and revokes

- An event whose `author` is the agent itself is dropped.
- A `401` from lodge (the client was revoked) deletes every undelivered event and pauses the bridge. A consumer that lodge removed (a grant change, a revoke) deletes that subscription's undelivered events; the bridge then subscribes again, and a refusal (`403`, `404`) ends the subscription (`events_list` shows it).

## The broker

The bridge connects with NATS over WebSocket at `wss://<lodge>/nats`, with the access token, and an inbox prefix of `_INBOX.<broker name>` (`o` and the client ID's bytes in lower-case base32). It pulls 1 message at a time from each consumer that lodge made (`$JS.API.CONSUMER.MSG.NEXT`), waits 30 s per pull, and acks with `+ACK`. Each pull has its own reply inbox (nats.js `noMux`): JetStream sends an event under the event's own subject, which nats.js's shared request inbox does not match, and the end of the connection ends a pull that waits. `events-bridge-nats.test.ts` checks this against a fake NATS server over WebSocket, and against a real nats-server with JetStream when `NATS_SERVER` names its binary. It reconnects with a fresh token, with a growing wait (up to 60 s) when connections keep failing. A refused token makes it ask lodge's HTTP side whether it was a revoke.

## The vendored client

`scripts/vendor-nats.mjs` downloads `@nats-io/nats-core` 3.4.0, `@nats-io/nkeys` 2.0.3, `@nats-io/nuid` 3.0.0 and `tweetnacl` 1.0.3 from npm, checks each tarball's sha512 integrity, and bundles them with esbuild 0.25.12 into `_events-bridge-nats.mjs`. The output is the same bytes each run. `events-bridge.test.ts` pins its SHA-256 (`NATS_SHA256`). To update it, change the versions and hashes in the script, run `node scripts/vendor-nats.mjs`, and change the pin in the same PR. The file is a helper: a change needs a server restart.

## Reloads and turning it off

A reload stops the old bridges and starts new ones from the stores; a new bridge waits until the old one's stop has ended, so 2 bridges never write 1 store. At load, and each 10 minutes, each agent with a store runs while its profile still names a gateway; one that lost it stops (its store stays). With the module off, nothing pulls: lodge's consumers keep the events (7 days), and the bridge takes them when it is on again.
