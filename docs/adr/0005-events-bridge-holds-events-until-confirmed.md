# 0005 — The events bridge holds events until Team and lodge confirm them

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

[ADR-0004](0004-agents-follow-lodge-events-through-a-bridge.md) built the events
bridge. Two of its paths let stored events reach the wrong place:

- Before a delivery, the bridge checked the events session only by its folder
  (the agent's home). Team's rule is different: a session's explicit identity
  (the `x.team.identity` document) comes first, and the folder only when there is
  none. So a session in one agent's home, set by hand to another agent, still got
  the first agent's events. A private agent's events could reach a session that
  runs as another agent.
- A client that lodge revoked while the bridge was down looks, at the next
  start, like a refused refresh: the bridge pauses, and it deletes nothing. The
  batches, the digest and `events_pending` did not check the pause, and at start
  the timer delivered stored batches before any call to lodge.

A background delivery in Pi Pocket has no document reader: only a request (a
tool call, a prompt section, a route) can read Team's document.

## Decision

- The bridge delivers to its events session only after Team confirmed, in this
  process, that the session is the agent's (`TeamApi.persona`, the same rule as
  everywhere in Team). The confirmation comes from a read in the bridge's prompt
  section (any session's turn) or in its tool calls, and it stays in memory only.
  Team calls the listeners in `Symbol.for("pi-pocket-team.identity-changed")`
  after each explicit identity change; the bridge then asks again, and a read
  that started before the change counts for nothing. A session that the bridge
  makes counts as confirmed. When Team names another agent or none, the next
  delivery makes a new session.
- No event leaves the bridge (batch, digest, `events_pending`) while it is
  paused, or before lodge confirmed the client in this process: at start and
  after each sign-in, the bridge lists its subscriptions at lodge first. A
  refused token pauses it (a `401` deletes the undelivered events, as before); a
  subscription that lodge no longer lists loses its undelivered events and is
  made again.

This replaces ADR-0004's consequence "The identity check of the events session
is by its folder … A session moved to another agent by hand gets 1 more wake
before a new one". The rest of ADR-0004 stands.

## Consequences

- No wake goes to a session that runs as another agent, also after a restart.
- After a restart, events wait until some session takes a turn (its prompt
  section runs) or the agent calls an events tool. On a server where no session
  runs, a wake can come late; nothing is lost, and the digest waits too.
- After a restart, events also wait until lodge answers. While lodge is down,
  nothing new comes either.
- A held `events_pending` call gives no event and says why; a replay of an
  earlier answer still gives that answer.
- Team and the bridge share 1 global listener set: a change to Team's identity
  writes must keep calling it (`team-memory.test.ts` checks the 4 write paths).

## Alternatives considered

- **Read the identity at delivery with a reader kept from a request:** Pi
  Pocket gives a reader only for the time of a request; a kept one relies on an
  internal detail of Pi Durable.
- **A new events session after each restart:** it confirms nothing that the
  first one could not, and it leaves a trail of idle sessions.
- **Run each delivery in a durable task:** a task has a reader, but it starts
  only from a commit, and the bridge's pulls and timers would all move into it.
  Too large a change for 2 checks.
- **Treat every refused refresh as a revoke:** a refresh token that ran out
  (30 days) would then delete events that lodge never revoked.

## References

- Builds on: [ADR-0004](0004-agents-follow-lodge-events-through-a-bridge.md)
- Shapes: [modules/events-bridge.md](../modules/events-bridge.md) (sections "The
  events session" and "Holds"), [modules/team.md](../modules/team.md)
