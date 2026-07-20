# Magi Headless Agent Service

Magi can run as a local, persistent agent service for desktop, mobile, and
automation clients. The service owns provider credentials, sessions, tools,
permissions, and the agent loop. Clients communicate through a versioned HTTP
API and a resumable Server-Sent Events (SSE) stream.

## Start the service

Foreground, useful during development:

```bash
magi serve
```

Background daemon:

```bash
magi daemon start
magi daemon status
```

The default address is `127.0.0.1:8765`. Override it with
`MAGI_CONTROL_BIND` and `MAGI_CONTROL_PORT`. Binding to a non-loopback address
is an explicit opt-in and should only be used on a trusted network.

## Discover and pair

The stable API base is `/v1`. Discovery endpoints do not require a device
credential:

```text
GET /v1/health
GET /v1/capabilities
GET /openapi.json
```

Create a device credential from the same machine:

```bash
curl -X POST http://127.0.0.1:8765/v1/pairing \
  -H 'content-type: application/json' \
  -d '{"name":"desktop"}'
```

Authenticated requests send both returned values:

```text
Authorization: Bearer <token>
x-magi-device-id: <deviceId>
```

Provider API keys stay in the service process. A desktop renderer should not
receive provider keys or Magi device tokens; keep the client in the desktop
main process and expose a narrow IPC bridge to the renderer.

## Core desktop flow

1. Call `GET /v1/health` and verify `protocolVersion`.
2. Call `GET /v1/capabilities` and gate optional UI features.
3. Pair once and store the device token in the operating-system credential
   store.
4. Create or open a session.
5. Start a background job with `POST /v1/jobs` and `background: true`.
6. Subscribe to `/v1/events?jobId=<id>`.
7. Resolve approvals or questions through their job interaction endpoints.
8. Fetch the final transcript and job status after a terminal event.

Example background job:

```json
{
  "prompt": "run the tests and fix the failing unit test",
  "model": "main",
  "background": true,
  "interactionMode": "client",
  "permissionMode": "default"
}
```

## Durable event stream

`GET /v1/events` streams durable audit events. Filter with `sessionId` or
`jobId`. Every audit frame has a numeric SSE `id`.

On reconnect, send either:

```text
Last-Event-ID: 123
```

or:

```text
GET /v1/events?after=123
```

The service replays events after that cursor before publishing live events.
`GET /v1/events.json?after=123` provides the same cursor semantics for polling
clients. The service emits a `shutdown` event during graceful shutdown.

Important event names include:

- `agent.text.delta`
- `agent.tool.use`
- `agent.tool.completed`
- `agent.approval.pending`
- `agent.user_question.pending`
- `agent.query.completed`
- `agent.query.failed`
- `agent.query.cancelled`

## Lifecycle guarantees

- Request bodies are limited to 1 MiB.
- Session, job, and audit state is stored in SQLite.
- Background jobs can be cancelled with `POST /v1/jobs/{id}/cancel`.
- On startup, jobs left in `running` state by a terminated process are marked
  `cancelled` and receive a `control.job.recovered` audit event.
- Closing the service stops accepting connections, ends active SSE streams,
  cancels in-process jobs, and waits for their promises to settle.
- Unversioned endpoints remain available for the existing mobile panel, but
  new clients should use `/v1`.

## TypeScript client

The package exports `MagiHeadlessClient`:

```ts
import { MagiHeadlessClient } from "@edwardlee5423/magi";

const client = new MagiHeadlessClient({
  baseUrl: "http://127.0.0.1:8765"
});

const credentials = await client.pair("desktop");
// Persist credentials in the OS credential store.

const started = await client.startJob({
  prompt: "explain this repository",
  background: true,
  interactionMode: "client"
});

for await (const event of client.streamEvents({
  jobId: String(started.jobId)
})) {
  // Save event.id as the reconnect cursor.
  console.log(event.event, event.data);
}
```

## Compatibility

The versioned service is additive. Existing `/sessions`, `/jobs`, `/events`,
and panel routes continue to work. New desktop clients should treat the
capability document as the feature contract instead of inferring support from
the Magi package version.
