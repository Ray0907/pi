# Pi App-Server v2 Protocol

Pi app-server v2 is a JSON Lines control protocol for desktop and other external clients. It exposes the same agent runtime used by the CLI while giving clients structured lifecycle, thread, turn, approval, usage, model, command, tool, and diff events.

The app-server is started with:

```bash
pi app-server
```

Each request and response is one JSON object followed by `\n` on stdio. Notifications are also JSON objects followed by `\n`.

## Compatibility Rules

- `protocolVersion` is `2`.
- Clients should call `initialize` first and inspect `capabilities.methods` and `capabilities.notifications`.
- Request `id` may be a string, number, `null`, or omitted. Responses echo the request `id`.
- Unknown fields must be ignored.
- Optional fields may be omitted or `undefined` in in-process tests, but serialized stdio responses omit `undefined`.
- New v2 methods and notification fields may be added without changing `protocolVersion`.
- A request error response has `error.code` and `error.message`; clients should not parse human text except for display.
- Stdout is reserved for JSONL protocol messages. Diagnostics belong on stderr.

## Envelopes

Request:

```json
{ "id": "request-id", "method": "turn/start", "params": { "message": "hello" } }
```

Response:

```json
{ "id": "request-id", "result": { "accepted": true, "threadId": "thread-id", "turnId": "turn-1" } }
```

Error:

```json
{ "id": "request-id", "error": { "code": -32601, "message": "Unknown method: missing/method" } }
```

Notification:

```json
{ "method": "turn/started", "params": { "threadId": "thread-id", "turnId": "turn-1", "startedAt": "2026-06-05T00:00:00.000Z" } }
```

## Error Codes

Clients should branch on `error.code`, not `error.message`.

- `-32601`: unknown method.
- `-32602`: invalid params.
- `-32000`: internal runtime error. The message is display-only and may vary.
- `-32001`: unknown approval id.
- `-32002`: requested model was not found.
- `-32003`: thread clone requested without a current leaf entry.

## Initialization

### `initialize`

Returns app-server metadata and capabilities. `params.clientInfo` is accepted for client identification but is not required.

Result:

```ts
{
  protocolVersion: 2;
  serverInfo: { name: "pi-app-server"; version: 2 };
  capabilities: {
    threads: true;
    turns: true;
    models: true;
    tools: true;
    diffs: true;
    approvals: true;
    methods: string[];
    notifications: string[];
  };
}
```

### `server/capabilities`

Returns the same payload as `initialize` without changing app state.

### `server/status`

Returns process and active workspace state.

Result:

```ts
{
  protocolVersion: 2;
  serverInfo: { name: "pi-app-server"; version: 2 };
  pid: number;
  cwd: string;
  connected: true;
  status: AppServerStatus;
}
```

### `server/shutdown`

Requests graceful shutdown. The stdio runner writes the acknowledgement, flushes stdout, disposes runtime state, and exits with code `0`.

Result:

```ts
{ shuttingDown: true }
```

## Status

`workspace/status`, `turn/status`, and `thread/status.result.status` use `AppServerStatus`.

```ts
interface AppServerStatus {
  cwd: string;
  threadId: string;
  sessionPath?: string;
  running: boolean;
  activeTurnId?: string;
  activeTurnStartedAt?: string;
  lastActivityAt?: string;
  pendingApprovalCount: number;
  eventSequence: number;
}
```

- `running` mirrors active agent streaming state.
- `activeTurnId` is set after `turn/start` is accepted and cleared on completion, interruption, or error.
- `eventSequence` is the latest recorded notification sequence.
- `lastActivityAt` is updated when a notification is emitted.

## Event Replay

### `session/events`

Params:

```ts
{ since?: number }
```

Returns recorded notifications after `since`. The app-server retains a bounded replay buffer.

Result:

```ts
{
  events: Array<AppServerNotification & { sequence: number; timestamp: string }>;
  nextSequence: number;
}
```

Clients should store `nextSequence` and request later events with `since: nextSequence`.
The current replay buffer keeps the latest 500 notifications.

## Threads

### `thread/list`

Params:

```ts
{ includeArchived?: boolean; pinnedOnly?: boolean }
```

Result:

```ts
{ threads: AppServerThreadSummary[] }
```

### `thread/search`

Params:

```ts
{ query: string; includeArchived?: boolean; pinnedOnly?: boolean }
```

Searches thread name, first message, id, and cwd.

### `thread/start`

Starts a new active thread.

Result:

```ts
{ cancelled: boolean; thread: AppServerThread }
```

### `thread/resume`

Params:

```ts
{ sessionPath: string }
```

Switches active runtime to an existing session.

### `thread/read`

Returns the active thread with messages.

### `thread/status`

Returns active thread summary plus `AppServerStatus`.

### `thread/name/set`

Params:

```ts
{ name: string }
```

Sets a non-empty display name and emits `thread/renamed`.

### `thread/archive`

Params:

```ts
{ sessionPath: string; archived?: boolean }
```

Defaults `archived` to `true`. Emits `thread/archived`.

### `thread/pin`

Params:

```ts
{ sessionPath?: string; pinned: boolean }
```

Pins the active thread when `sessionPath` is omitted. Emits `thread/pinned`.

### `thread/fork/messages`

Returns user messages that can be used as fork points.

Result:

```ts
{ messages: Array<{ entryId: string; text: string }> }
```

### `thread/fork`

Params:

```ts
{ entryId: string; position?: "before" | "at" }
```

Defaults `position` to `"before"`. Replaces the active runtime with the forked session and emits `thread/forked`.

Result:

```ts
{ cancelled: boolean; selectedText?: string; thread: AppServerThread }
```

### `thread/clone`

Clones the active branch from the current leaf and emits `thread/forked` with `position: "at"`.

## Turns

### `turn/start`

Params:

```ts
{ message: string }
```

Starts an agent turn asynchronously. The response is returned after preflight acceptance, before the assistant response finishes.

Result:

```ts
{ accepted: true; threadId: string; turnId: string }
```

### `turn/interrupt`

Requests cancellation of the active turn.

Result:

```ts
{ interrupted: true; threadId: string; turnId?: string; wasRunning: boolean }
```

Emits `turn/interrupted` when a turn was active or had an active turn id.

## Approvals

### `approval/respond`

Params:

```ts
{ approvalId: string; [responseField: string]: unknown }
```

Resolves a pending approval request. The remaining params are forwarded to the extension approval caller. Unknown approval ids return `-32001`.

## Usage

### `usage/session`

Returns cumulative usage for the active session.

### `usage/thread`

Alias for active thread usage. It currently returns the same shape as `usage/session`.

Result:

```ts
{
  usage: {
    sessionFile?: string;
    sessionId: string;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
    cost: number;
    contextUsage?: unknown;
  };
}
```

## Commands

### `command/list`

Returns extension commands, prompt templates, and skills for autocomplete.

```ts
{
  commands: Array<{
    name: string;
    description?: string;
    source: "extension" | "prompt" | "skill";
    sourceInfo?: unknown;
  }>;
}
```

## Models

### `model/list`

Returns available models and includes the current model if it is not in registry results.

### `model/current`

Returns the active model.

### `model/set`

Params:

```ts
{ provider: string; modelId: string }
```

Sets the active model when it can be found in available models or matches the current model.

## Notifications

Turn lifecycle:

- `turn/started`: `{ threadId, turnId?, startedAt? }`
- `turn/error`: `{ threadId, turnId?, message }`
- `turn/interrupted`: `{ threadId, turnId?, interruptedAt }`
- `turn/completed`: `{ threadId, turnId?, completedAt, message, toolResults }`

Message items:

- `item/started`: `{ threadId, turnId?, itemId, role }`
- `item/agentMessage/delta`: `{ threadId, turnId?, itemId, delta }`
- `item/completed`: `{ threadId, turnId?, itemId, role, text, usage? }`

Tool items:

- `item/toolCall/started`: `{ threadId, turnId?, itemId, toolCallId, toolName, args }`
- `item/toolCall/updated`: `{ threadId, turnId?, itemId, toolCallId, toolName, args, partialResult }`
- `item/toolCall/completed`: `{ threadId, turnId?, itemId, toolCallId, toolName, result, isError }`

Diffs:

- `item/diff/available`: `{ threadId, turnId?, itemId, toolCallId, toolName, diff, patch?, firstChangedLine? }`

Approvals:

- `approval/requested`: `{ threadId?, turnId?, approvalId, timeout?, kind, ...requestSpecificFields }`

Thread metadata:

- `thread/renamed`: `{ threadId, sessionPath?, name? }`
- `thread/forked`: `{ previousThreadId, previousSessionPath?, threadId, sessionPath?, entryId, position, selectedText?, cancelled }`
- `thread/archived`: `{ sessionPath, threadId, archived }`
- `thread/pinned`: `{ sessionPath?, threadId, pinned }`

Extension UI notifications:

- `notification/show`
- `status/set`
- `working/message/set`
- `working/visible/set`
- `working/indicator/set`
- `thinking/hiddenLabel/set`
- `widget/set`
- `theme/set`
- `tools/expanded/set`
- `window/title/set`
- `editor/paste`
- `editor/text/set`

## Desktop Client Notes

- Use `server/shutdown` before killing the child process.
- Treat `turnId` as the stable key for active turn UI and stale-event filtering.
- Use `session/events` replay after reconnect to fill gaps.
- Prefer `server/status` plus `thread/status` for lifecycle dashboards.
- Do not parse CLI/TUI output; all app-server stdout must be JSONL protocol output.
