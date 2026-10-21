import { randomUUID } from "node:crypto";
import { GatewayApiClient } from "@cavi-ai/api-client";
import { startHermesChatRun, HermesSseRunEventProvider } from "@cavi-ai/api-client/providers/hermes/runtime";
import { OpenClawApiClient, OpenClawWebSocketClient } from "@cavi-ai/api-client/providers/openclaw";

async function consumeHermes(provider, runId, signal, handlers) {
  const { promise, resolve, reject } = Promise.withResolvers();
  void promise.catch(() => undefined);
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let subscription;
  try {
    signal.throwIfAborted();
    subscription = await provider.subscribe({ runId, signal }, {
      onEvent(event) {
        try {
          if (event.runId !== runId) throw new Error("specialist run identity mismatch");
          handlers.onEvent(event);
          if (["run.completed", "run.failed", "run.cancelled"].includes(event.event)) resolve();
        } catch (error) { reject(error); }
      },
      onError: reject, onComplete: resolve
    });
    await promise;
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
    await subscription?.dispose();
  }
}

async function generateHermes(config, messages, { apiKey, fetch, signal, handlers }) {
  const sessionKey = `ableton-specialist-${randomUUID()}`;
  const options = { httpBase: config.endpoint.replace(/\/$/, ""), authToken: apiKey, clientId: "ableton-mcp",
    sessionKey, fetchImpl: fetch };
  let runId;
  let completed = false;
  try {
    ({ runId } = await startHermesChatRun({ ...options, sessionId: sessionKey, targetAgent: config.agentId,
      input: JSON.stringify(messages), signal }));
    await consumeHermes(new HermesSseRunEventProvider({ ...options, fallbackToPoll: false }), runId, signal, {
      onEvent(event) { handlers.onEvent(event); if (event.event === "run.completed") completed = true; }
    });
  } finally {
    if (runId && !completed) {
      const cleanup = new GatewayApiClient({ baseUrl: options.httpBase, auth: { bearerToken: apiKey, clientId: "ableton-mcp" },
        defaultHeaders: { "X-Hermes-Session-Key": sessionKey },
        defaultTimeoutMs: 1000, fetchImpl: fetch });
      await cleanup.cancelRun(runId).catch(() => undefined);
    }
  }
}

async function generateOpenClaw(config, messages, { apiKey, signal, handlers }) {
  const url = new URL(config.endpoint);
  url.protocol = ["http:", "ws:"].includes(url.protocol) ? "ws:" : "wss:";
  const rpc = new OpenClawWebSocketClient(url.href, apiKey, { clientId: "cli", clientMode: "backend",
    requestedScopes: ["operator.read", "operator.write"], maxFrameBytes: 128000,
    requestTimeoutMs: config.timeoutMs || 60000 });
  const client = new OpenClawApiClient({ baseUrl: config.endpoint.replace(/^ws/, "http"), normalizeRunStatus: true,
    rpcClient: { request: (method, params) => rpc.request(method, params, { signal }) } });
  const sessionKey = `agent:${config.agentId}:ableton-specialist-${randomUUID()}`;
  const { promise, resolve, reject } = Promise.withResolvers();
  void promise.catch(() => undefined);
  let runId;
  let completed = false;
  let snapshot;
  let bytes = 0;
  const pending = [];
  const accept = payload => {
    if (completed || payload.runId !== runId) return;
    if (payload.state === "error" || payload.state === "aborted") throw new Error("specialist API run did not complete");
    if (!["delta", "final"].includes(payload.state)) return;
    if (payload.message !== undefined) {
      if (payload.message?.role !== "assistant") throw new Error("specialist requires an assistant reply");
      const content = payload.message.content;
      snapshot = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter(block => block.type === "text").map(block => block.text).join("") : undefined;
      if (snapshot !== undefined && Buffer.byteLength(snapshot) > 16000) throw new Error("specialist output limit exceeded");
    }
    if (payload.state !== "final") return;
    handlers.onEvent({ event: "run.completed", runId, ...(snapshot === undefined ? {} : { output: snapshot }) });
    completed = true;
    resolve();
  };
  const unsubscribe = rpc.subscribe(event => {
    const payload = event.payload;
    if (event.event !== "chat" || payload?.sessionKey !== sessionKey) return;
    try {
      bytes += Buffer.byteLength(JSON.stringify(payload));
      if (bytes > 128000) throw new Error("specialist response byte limit exceeded");
      if (!runId) pending.push(payload);
      else accept(payload);
    } catch (error) { reject(error); }
  });
  const unsubscribeState = rpc.onConnectionState((state, error) => { if (state === "error") reject(error || new Error("gateway disconnected")); });
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const run = await client.startRun({ input: JSON.stringify(messages), sessionKey,
      metadata: { deliver: false, timeoutMs: config.timeoutMs || 60000 } });
    runId = run.run_id;
    for (const payload of pending) accept(payload);
    pending.length = 0;
    await promise;
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
    if (runId && !completed) await rpc.request("sessions.abort", { runId }, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    unsubscribe(); unsubscribeState();
    await rpc.dispose();
  }
}

export async function generateGatewayResponse(config, messages, options) {
  return config.provider === "openclaw" ? generateOpenClaw(config, messages, options) : generateHermes(config, messages, options);
}
