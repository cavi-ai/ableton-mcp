import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { decodeBridgeLines, encodeBridgeMessage } from "./bridge-protocol.mjs";

export class UnixBridgeClient {
  constructor(socketPath, { timeoutMs = 5000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}) {
    return this.requestMany([{ method, params }]).then(results => results[0]);
  }

  requestMany(requests) {
    if (!Array.isArray(requests) || !requests.length) return Promise.reject(new Error("bridge batch must not be empty"));
    return new Promise((resolve, reject) => {
      const messages = requests.map(({ method, params = {} }) => ({ id: randomUUID(), method, params }));
      const pending = new Map(messages.map((message, index) => [message.id, index]));
      const results = new Array(messages.length);
      const socket = createConnection(this.socketPath);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (callback === resolve) socket.end();
        else socket.destroy();
        callback(value);
      };
      const timer = setTimeout(() => {
        finish(reject, new Error(`bridge request timed out: ${messages.map(message => message.method).join(", ")}`));
      }, messages.some(message => message.method === "set_group_system_snapshot")
        ? Math.max(this.timeoutMs, 60000) : this.timeoutMs);
      socket.once("error", (error) => finish(reject, error));
      socket.once("close", () => finish(reject, new Error("bridge connection closed before all replies")));
      socket.once("connect", () => socket.write(Buffer.concat(messages.map(encodeBridgeMessage))));
      socket.on("data", (chunk) => {
        try {
          const decoded = decodeBridgeLines(Buffer.concat([buffer, chunk]));
          buffer = decoded.remainder;
          for (const message of decoded.messages) {
            if (!pending.has(message.id)) continue;
            if (message.error) return finish(reject, new Error(message.error.message));
            results[pending.get(message.id)] = message.result;
            pending.delete(message.id);
          }
          if (!pending.size) finish(resolve, results);
        } catch (error) { finish(reject, error); }
      });
    });
  }
}
