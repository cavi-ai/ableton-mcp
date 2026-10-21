import { ClaudeApiClient } from "@cavi-ai/api-client/providers/claude/messages";
import { CodexApiClient } from "@cavi-ai/api-client/providers/codex/runtime";
import { OpenCodeApiClient } from "@cavi-ai/api-client/providers/opencode";
import { AgyApiClient } from "@cavi-ai/api-client/providers/agy";
import { requireRunText, requireStreamText } from "@cavi-ai/api-client";
import { setTimeout as delay } from "node:timers/promises";
import { generateGatewayResponse } from "./producer-gateway-client.mjs";

const keyNames = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY", openclaw: "OPENCLAW_GATEWAY_TOKEN",
  hermes: "HERMES_API_KEY", opencode: "OPENCODE_SERVER_PASSWORD", agy: "AGY_API_KEY" };

async function runCodex(options, body, signal, onEvent) {
  const client = new CodexApiClient({ ...options, fetchImpl: (url, init) => options.fetchImpl(url, {
    ...init, signal: AbortSignal.any([signal, init.signal])
  }) });
  let run;
  let ownedRunId;
  let completed = false;
  try {
    run = await client.startRun(body);
    ownedRunId = run.run_id;
    if (typeof ownedRunId !== "string" || !ownedRunId.trim()) throw new Error("specialist run identity is missing");
    while (["started", "running", "queued", "in_progress"].includes(run.status)) {
      signal.throwIfAborted();
      run = await client.getRun(ownedRunId);
      if (run.run_id !== ownedRunId) throw new Error("specialist run identity mismatch");
      if (["started", "running", "queued", "in_progress"].includes(run.status)) await delay(1000, undefined, { signal });
    }
    signal.throwIfAborted();
    const output = requireRunText(run);
    completed = true;
    onEvent({ event: "run.completed", runId: run.run_id, output });
  } finally {
    if (ownedRunId && !completed) {
      const cleanup = new CodexApiClient({ ...options, defaultTimeoutMs: 1000 });
      await cleanup.cancelRun(ownedRunId).catch(() => undefined);
    }
  }
}

export async function generateApiClientResponse(config, messages, { signal, fetch, env, cwd }) {
  signal.throwIfAborted();
  const keyName = config.apiKeyEnv || keyNames[config.provider];
  const apiKey = env[keyName]?.trim();
  const optionalPassword = config.provider === "opencode" && !config.apiKeyEnv &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.endpoint).hostname);
  if (!apiKey && !optionalPassword) throw new Error(`specialist API key is missing from ${keyName}`);
  let failure;
  const boundedFetch = async (url, init) => {
    const response = await fetch(url, { ...init, redirect: "error" });
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 128000) {
          failure = new Error("specialist response byte limit exceeded");
          throw failure;
        }
        controller.enqueue(chunk);
      }
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const options = { apiKey, defaultModel: config.model, defaultTimeoutMs: config.timeoutMs || 60000, fetchImpl: boundedFetch };
  let output;
  let outcome = null;
  let runId = null;
  const handlers = {
      onEvent(event) {
        runId = event.runId || runId;
        if (event.event === "message.delta") output = (output ?? "") + event.delta;
        if (event.event === "run.completed") {
          outcome = "completed";
          if (typeof event.output === "string") output = event.output;
        }
        if (event.event === "run.failed" || event.event === "run.cancelled") {
          failure = new Error("specialist API run did not complete");
          throw failure;
        }
        if (event.event === "approval.request" || event.event.startsWith("tool.call.")) {
          failure = new Error("specialist native tools and approvals are not permitted");
          throw failure;
        }
        if (output !== undefined && Buffer.byteLength(output) > 16000) {
          failure = new Error("specialist output limit exceeded");
          throw failure;
        }
      },
      onError(error) { throw error; }
  };
  try {
    const body = { instructions: messages[0].content, input: messages.slice(1) };
    if (["openclaw", "hermes"].includes(config.provider)) {
      await generateGatewayResponse(config, messages, { apiKey, fetch: boundedFetch, signal, handlers });
    } else if (config.provider === "codex") {
      await runCodex(options, body, signal, handlers.onEvent);
    } else {
      let client;
      if (config.provider === "claude") client = new ClaudeApiClient({ ...options, defaultMaxTokens: 2048 });
      else if (config.provider === "agy") client = new AgyApiClient({ ...options, baseUrl: config.endpoint });
      else {
        const directory = config.directory || cwd;
        if (!directory) throw new Error("OpenCode requires a scoped working directory");
        client = new OpenCodeApiClient({ ...options, baseUrl: config.endpoint,
          scope: { directory }, username: config.username, password: apiKey });
        body.input = JSON.stringify(messages.slice(1));
      }
      await client.streamRun(body, handlers, { signal });
    }
  } catch {
    signal.throwIfAborted();
    // Provider error bodies can contain request data; keep them out of artifacts.
    throw failure || new Error("specialist API request failed");
  }
  signal.throwIfAborted();
  return requireStreamText({ runId, outcome, output });
}
