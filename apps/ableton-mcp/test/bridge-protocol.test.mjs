import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExpectedState,
  decodeBridgeLines,
  encodeBridgeMessage
} from "../src/bridge-protocol.mjs";

test("bridge framing decodes partial and multiple messages", () => {
  const first = encodeBridgeMessage({ id: "1", method: "status" });
  const second = encodeBridgeMessage({ id: "2", method: "tracks" });
  const split = first.length - 2;
  const partial = decodeBridgeLines(first.subarray(0, split));
  assert.deepEqual(partial.messages, []);
  const completed = decodeBridgeLines(Buffer.concat([partial.remainder, first.subarray(split), second]));
  assert.deepEqual(completed.messages.map((message) => message.id), ["1", "2"]);
  assert.equal(completed.remainder.length, 0);
});

test("state guard accepts exact expected identities", () => {
  assert.doesNotThrow(() =>
    assertExpectedState(
      { expectedStateVersion: 7, trackId: "track-1", deviceId: "device-2" },
      { stateVersion: 7, trackId: "track-1", deviceId: "device-2" }
    )
  );
});

for (const [field, request, observed] of [
  ["stateVersion", { expectedStateVersion: 7 }, { stateVersion: 8 }],
  ["trackId", { trackId: "track-1" }, { trackId: "track-9" }],
  ["deviceId", { deviceId: "device-2" }, { deviceId: "device-8" }]
]) {
  test(`state guard rejects mismatched ${field}`, () => {
    assert.throws(() => assertExpectedState(request, observed), new RegExp(field));
  });
}
