# Cancel agent work

Use your MCP client's cancel control to stop its current request. Clients send the standard `notifications/cancelled` notification with the request ID. The server keeps receiving cancellation while a tool is waiting and skips cancelled requests that have not started.

Inside Live, queued bridge requests have deadlines. Cancellation, expiry or a disconnected client prevents an unclaimed request from executing. The bridge also checks cancellation and expiry before the second stage of a deferred cue-point edit. The native queue holds at most 256 requests; excess requests are refused without execution.

An operation already executing inside Live cannot be forcibly interrupted. Cancelling does not undo edits or stop playback. Use `transport_stop` or `stop_clip` when you want music to stop. A save or open action already sent to Live's UI can also finish after cancellation.

## Resume after cancellation or timeout

Use [resume-session-work](resume-session-work.md) to reconcile the current Set, retained comparisons and captures before continuing a task.

1. Read the affected objects and current `stateVersion` again.
2. Compare the observed state with the requested change. A timeout is not evidence that nothing happened.
3. Make a new plan for any remaining work and confirm it through the usual [mutation contract](guarded-mutations.md). Do not automatically replay a transmitted write.

A cancelled confirmed request may have consumed its single-use token even if its queued write never ran. Get a new plan rather than reusing that token. Cancelled MCP requests produce no response; treat their mutation outcome as uncertain until readback establishes it.

## Error outcomes

Tool failures from the bridge include `structuredContent.error` with `code`, `message`, `outcome` and native `requestIds`. Resource failures carry the same details in the JSON-RPC error's `data`.

Available `bridgeProgress` describes the client's connection, protocol validation, transmission and received replies. It does not establish native execution or override `outcome`; a transmitted request can still be explicitly refused before execution. See [bridge diagnostics](troubleshooting.md#distinguish-connection-from-a-live-response).

| Outcome | Meaning |
|---|---|
| `not_executed` | The requested operation was not transmitted, or the bridge explicitly refused it before execution. |
| `unknown` | An operation may have started or completed. Read back before retrying. A partially completed batch also has an uncertain outcome. |

`BRIDGE_TIMEOUT` and `BRIDGE_CANCELLED` report local timeout or cancellation. `BRIDGE_EXPIRED` and `BRIDGE_DISCONNECTED` identify refused native queue entries. `BRIDGE_BUSY` means the native queue is full. These are request outcomes, not permission to bypass confirmation.

## Update the bridge with the server

The server checks bridge cancellation support before transmitting each request batch. An older loaded bridge is refused with `BRIDGE_UPGRADE_REQUIRED`, so it cannot silently ignore deadlines. Run `ableton-mcp install`, reload CaviMcpBridge in Live, and check `ableton-mcp doctor --json`. If multiple script copies are installed, update the copy Live actually loads; see [troubleshooting](troubleshooting.md).
