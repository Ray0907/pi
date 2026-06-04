# App-server v2

`pi app-server` starts a headless JSON-RPC control plane for external UIs such as desktop apps.

Unlike `--mode rpc`, app-server v2 uses thread, turn, and item primitives designed for long-running UI clients. The existing RPC mode remains supported.

## Start

```bash
pi app-server
```

The current implementation uses JSONL over stdio. Send one JSON object per line and read one response or notification per line from stdout.

App-server can start before a model is selected. This lets a UI initialize, list sessions, inspect state, and show model/settings controls before sending a turn.

## Request format

Requests use JSON-RPC-style objects without a required `jsonrpc` field:

```json
{"id":"init","method":"initialize","params":{"clientInfo":{"name":"pi-desktop"}}}
```

Responses include the same `id`:

```json
{"id":"init","result":{"protocolVersion":2,"serverInfo":{"name":"pi-app-server","version":2},"capabilities":{"threads":true,"turns":true,"models":true,"tools":true,"diffs":true,"approvals":true,"methods":["initialize","server/capabilities","thread/list"],"notifications":["turn/started","item/agentMessage/delta"]}}}
```

Errors are structured:

```json
{"id":"turn","error":{"code":-32000,"message":"No model selected"}}
```

## Methods

### initialize

Initialize a client connection.

```json
{"id":"init","method":"initialize","params":{"clientInfo":{"name":"pi-desktop","version":"0.1.0"}}}
```

### server/capabilities

Return the same protocol version, server info, method list, and notification list exposed by `initialize`.

```json
{"id":"caps","method":"server/capabilities"}
```

### session/events

Replay notifications recorded by the current app-server process after a sequence number. This is intended for desktop reconnect flows.

```json
{"id":"events","method":"session/events","params":{"since":42}}
```

Example result:

```json
{"events":[{"sequence":43,"timestamp":"2026-01-01T00:00:00.000Z","method":"turn/completed","params":{"threadId":"..."}}],"nextSequence":43}
```

### workspace/status

Return workspace-level state for reconnecting clients.

```json
{"id":"workspace-status","method":"workspace/status"}
```

Example result:

```json
{"cwd":"/path/to/workspace","threadId":"...","sessionPath":"/path/to/session.jsonl","running":false,"pendingApprovalCount":0}
```

### thread/list

List project sessions. The active runtime thread is included even before its first message is persisted.

```json
{"id":"threads","method":"thread/list"}
```

Pass `pinnedOnly: true` to return only pinned threads.

```json
{"id":"pinned","method":"thread/list","params":{"pinnedOnly":true}}
```

### thread/search

Search project sessions by id, name, first user message, or cwd.

```json
{"id":"search","method":"thread/search","params":{"query":"roadmap"}}
```

### thread/read

Read the current active thread and messages.

```json
{"id":"read","method":"thread/read"}
```

### thread/start

Create a new thread in the current workspace.

```json
{"id":"new","method":"thread/start"}
```

### thread/resume

Resume a session by JSONL path.

```json
{"id":"resume","method":"thread/resume","params":{"sessionPath":"/path/to/session.jsonl"}}
```

### thread/name/set

Set the active thread display name.

```json
{"id":"name","method":"thread/name/set","params":{"name":"Desktop test"}}
```

### thread/archive

Archive a session by JSONL path. If the active session is archived, app-server starts a new current thread.

```json
{"id":"archive","method":"thread/archive","params":{"sessionPath":"/path/to/session.jsonl"}}
```

### thread/pin

Pin or unpin a session. If `sessionPath` is omitted, app-server updates the active thread.

```json
{"id":"pin","method":"thread/pin","params":{"sessionPath":"/path/to/session.jsonl","pinned":true}}
```

### turn/start

Send a user message to the active thread.

```json
{"id":"turn","method":"turn/start","params":{"message":"Inspect this repo"}}
```

The response is emitted after the accepted turn completes. Streaming progress arrives as notifications while the turn is running.

### turn/status

Return active turn state for reconnecting clients.

```json
{"id":"turn-status","method":"turn/status"}
```

### turn/interrupt

Abort the active turn.

```json
{"id":"interrupt","method":"turn/interrupt"}
```

### approval/respond

Respond to an approval request emitted by the app-server.

```json
{"id":"approve","method":"approval/respond","params":{"approvalId":"...","confirmed":true}}
```

### model/list

List available models.

```json
{"id":"models","method":"model/list"}
```

## Notifications

Notifications have a `method` and `params`, but no `id`.

```json
{"method":"turn/started","params":{"threadId":"..."}}
{"method":"item/started","params":{"threadId":"...","itemId":"item-1","role":"assistant"}}
{"method":"item/agentMessage/delta","params":{"threadId":"...","itemId":"item-1","delta":"hello"}}
{"method":"item/toolCall/started","params":{"threadId":"...","itemId":"tool-1","toolCallId":"tool-1","toolName":"bash","args":{"command":"pwd"}}}
{"method":"item/toolCall/updated","params":{"threadId":"...","itemId":"tool-1","toolCallId":"tool-1","toolName":"bash","args":{"command":"pwd"},"partialResult":{"stdout":"..."}}}
{"method":"item/toolCall/completed","params":{"threadId":"...","itemId":"tool-1","toolCallId":"tool-1","toolName":"bash","result":{"content":[{"type":"text","text":"..."}]},"isError":false}}
{"method":"item/diff/available","params":{"threadId":"...","itemId":"tool-1","toolCallId":"tool-1","toolName":"edit","diff":"- old\n+ new","patch":"@@ -1 +1 @@\n-old\n+new","firstChangedLine":1}}
{"method":"approval/requested","params":{"approvalId":"...","kind":"confirm","title":"Run command","message":"Allow bash?","timeout":30000}}
{"method":"thread/pinned","params":{"sessionPath":"/path/to/session.jsonl","threadId":"...","pinned":true}}
{"method":"item/completed","params":{"threadId":"...","itemId":"item-1","role":"assistant","text":"hello"}}
{"method":"turn/completed","params":{"threadId":"...","message":{...},"toolResults":[]}}
```

## Example

```bash
printf '%s\n' \
  '{"id":"init","method":"initialize","params":{"clientInfo":{"name":"pi-desktop"}}}' \
  '{"id":"threads","method":"thread/list"}' \
  | pi app-server
```
