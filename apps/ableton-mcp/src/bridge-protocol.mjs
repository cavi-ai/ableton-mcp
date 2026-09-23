export function encodeBridgeMessage(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export function decodeBridgeLines(buffer) {
  const messages = [];
  let offset = 0;
  while (true) {
    const newline = buffer.indexOf(10, offset);
    if (newline === -1) break;
    const line = buffer.subarray(offset, newline).toString("utf8").trim();
    if (line) messages.push(JSON.parse(line));
    offset = newline + 1;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

export function assertExpectedState(request, observed) {
  const checks = [
    ["stateVersion", request.expectedStateVersion, observed.stateVersion],
    ["trackId", request.trackId, observed.trackId],
    ["deviceId", request.deviceId, observed.deviceId]
  ];
  for (const [field, expected, actual] of checks) {
    if (expected !== undefined && expected !== actual) {
      throw new Error(`${field} mismatch: expected ${expected}, observed ${actual}`);
    }
  }
}
