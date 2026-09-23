import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { decodeBridgeLines, encodeBridgeMessage } from "./bridge-protocol.mjs";

export class UnixBridgeClient {
  constructor(socketPath, { timeoutMs = 5000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = createConnection(this.socketPath);
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`bridge request timed out: ${method}`));
      }, this.timeoutMs);
      const finish = (callback, value) => {
        clearTimeout(timer);
        socket.end();
        callback(value);
      };
      socket.once("error", (error) => finish(reject, error));
      socket.once("connect", () => socket.write(encodeBridgeMessage({ id, method, params })));
      socket.on("data", (chunk) => {
        const decoded = decodeBridgeLines(Buffer.concat([buffer, chunk]));
        buffer = decoded.remainder;
        for (const message of decoded.messages) {
          if (message.id !== id) continue;
          if (message.error) finish(reject, new Error(message.error.message));
          else finish(resolve, message.result);
        }
      });
    });
  }
}
