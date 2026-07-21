import { createServer } from "node:net";
import { decodeBridgeLines, encodeBridgeMessage } from "../../src/bridge-protocol.mjs";

export async function startMockBridge(socketPath) {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const decoded = decodeBridgeLines(Buffer.concat([buffer, chunk]));
      buffer = decoded.remainder;
      for (const request of decoded.messages) {
        let result;
        if (request.method === "list_device_parameters") result = { stateVersion: 4, trackId: "t1", deviceId: "d1", parameters: [{ id: "cutoff", min: 0, max: 1, value: 0.4 }] };
        else if (request.method === "set_device_parameters") result = { stateVersion: 5, trackId: "t1", deviceId: "d1", observedChanges: request.params.changes };
        else if (request.method === "get_live_state") result = { stateVersion: 4, setFingerprint: "mock:set" };
        else result = { stateVersion: 4 };
        socket.write(encodeBridgeMessage({ id: request.id, result }));
      }
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  return server;
}
