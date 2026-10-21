import { ClaudeApiClient } from "@cavi-ai/api-client/providers/claude/messages";
import { requireStreamText } from "@cavi-ai/api-client";

export async function generateApiClientResponse(config, messages, { signal, fetch, env }) {
  const keyName = config.apiKeyEnv || "ANTHROPIC_API_KEY";
  const apiKey = env[keyName]?.trim();
  if (!apiKey) throw new Error(`specialist API key is missing from ${keyName}`);
  let failure;
  const client = new ClaudeApiClient({
    apiKey, defaultModel: config.model, defaultMaxTokens: 2048,
    defaultTimeoutMs: config.timeoutMs || 60000,
    fetchImpl: async (url, init) => {
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
    }
  });
  let output;
  let outcome = null;
  let runId = null;
  try {
    await client.streamRun({ instructions: messages[0].content, input: messages.slice(1) }, {
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
        if (output !== undefined && Buffer.byteLength(output) > 16000) {
          failure = new Error("specialist output limit exceeded");
          throw failure;
        }
      }
    }, { signal });
  } catch {
    signal.throwIfAborted();
    // Provider error bodies can contain request data; keep them out of artifacts.
    throw failure || new Error("specialist API request failed");
  }
  signal.throwIfAborted();
  return requireStreamText({ runId, outcome, output });
}
