import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { performance } from 'node:perf_hooks';
import { decodeBridgeLines, encodeBridgeMessage } from "./bridge-protocol.mjs";
import { requestSignal } from "./request-context.mjs";

function failure(code, message, outcome, requestIds = []) {
  return Object.assign(new Error(`${message}${outcome === "unknown" ? "; re-read Live state before retrying" : ""}`),
    { code, outcome, requestIds });
}

export function bridgeFailureDetails(error) {
  if (!error?.outcome) return undefined;
  return { code: error.code, message: error.message, outcome: error.outcome,
    requestIds: error.requestIds ?? [], ...(error.bridgeProgress ? { bridgeProgress: error.bridgeProgress } : {}) };
}

export class UnixBridgeClient {
  constructor(socketPath, { timeoutMs = 5000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}, options = {}) {
    return this.requestMany([{ method, params }], options).then(results => results[0]);
  }

  requestMany(requests, { signal = requestSignal() } = {}) {
    if (!Array.isArray(requests) || !requests.length) return Promise.reject(new Error("bridge batch must not be empty"));
    if (signal?.aborted) return Promise.reject(failure("BRIDGE_CANCELLED", "bridge request cancelled before transmission", "not_executed"));
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const progress = { phase: 'connect', socketConnected: false, protocolValidated: false,
        requestTransmitted: false, requestCount: requests.length, repliesReceived: 0 };
      const timeoutMs = requests.some(request => request.method === "set_group_system_snapshot")
        ? Math.max(this.timeoutMs, 60000) : this.timeoutMs;
      const deadlineUnixMs = Date.now() + timeoutMs;
      const messages = requests.map(({ method, params = {} }) => ({ id: randomUUID(), method, params, deadlineUnixMs }));
      const handshakeId = randomUUID();
      const pending = new Map(messages.map((message, index) => [message.id, index]));
      const results = new Array(messages.length);
      const socket = createConnection(this.socketPath);
      let buffer = Buffer.alloc(0);
      let settled = false;
      let transmitted = false;
      const outcome = () => transmitted ? "unknown" : "not_executed";
      const requestIds = messages.map(message => message.id);
      const finish = (callback, value, flush = false) => {
        if (settled) return;
        settled = true;
        if (callback === reject) value.bridgeProgress = { ...progress, elapsedMs: performance.now() - startedAt };
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (callback === resolve) socket.end();
        else if (flush) socket.destroySoon();
        else socket.destroy();
        callback(value);
      };
      const cancel = (code, message) => {
        if (settled) return;
        if (transmitted && !socket.destroyed) {
          // Flush cancellation before closing; disconnect also invalidates queued work.
          socket.end(encodeBridgeMessage({ cancelRequestIds: [...pending.keys()] }));
        }
        finish(reject, failure(code, message, outcome(), requestIds), transmitted);
      };
      const abort = () => cancel("BRIDGE_CANCELLED", "bridge request cancelled");
      const timer = setTimeout(() => {
        cancel("BRIDGE_TIMEOUT", `bridge request timed out: ${messages.map(message => message.method).join(", ")}`);
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("error", (error) => finish(reject, failure("BRIDGE_TRANSPORT", error.message, outcome(), requestIds)));
      socket.once("close", () => finish(reject, failure("BRIDGE_TRANSPORT", "bridge connection closed before all replies", outcome(), requestIds)));
      socket.once("connect", () => {
        if (settled) return;
        progress.socketConnected = true;
        progress.phase = 'handshake';
        socket.write(encodeBridgeMessage({ id: handshakeId, method: "get_bridge_protocol", params: {} }));
      });
      socket.on("data", (chunk) => {
        if (settled) return;
        try {
          const decoded = decodeBridgeLines(Buffer.concat([buffer, chunk]));
          buffer = decoded.remainder;
          for (const message of decoded.messages) {
            if (message.id === handshakeId && !transmitted) {
              if (message.error || message.result?.version !== 2 || !message.result?.requestDeadlines ||
                  !message.result?.requestCancellation) return finish(reject, failure("BRIDGE_UPGRADE_REQUIRED",
                "reinstall the packaged bridge and reload CaviMcpBridge in Live to enable request cancellation", "not_executed"));
              progress.protocolValidated = true;
              if (Date.now() >= deadlineUnixMs || signal?.aborted) return cancel("BRIDGE_CANCELLED", "bridge request cancelled before transmission");
              transmitted = true;
              progress.phase = 'response';
              progress.requestTransmitted = true;
              socket.write(Buffer.concat(messages.map(encodeBridgeMessage)));
              continue;
            }
            if (!pending.has(message.id)) continue;
            progress.repliesReceived++;
            if (message.error) return finish(reject, failure(message.error.code ?? "BRIDGE_REQUEST_FAILED",
              message.error.message, messages.length === 1 && message.error.outcome === "not_executed"
                ? "not_executed" : "unknown", requestIds));
            results[pending.get(message.id)] = message.result;
            pending.delete(message.id);
          }
          if (!pending.size) finish(resolve, results);
        } catch (error) { finish(reject, failure("BRIDGE_PROTOCOL", error.message, outcome(), requestIds)); }
      });
    });
  }
}
