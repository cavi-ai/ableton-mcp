import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";

function service({ available = true, mismatched = false, serial = false } = {}) {
  const tracks = [{ id: "track-2", type: "midi" }, { id: "track-3", type: "audio" }];
  let active = false;
  return new ToolService({ catalog: { search: () => [{ id: "catalog:observed" }] },
    bridge: { async request(method, args) {
      if (serial) {
        if (active) throw new Error("connection refused: native bridge backlog full");
        active = true;
        await new Promise(resolve => setImmediate(resolve));
        active = false;
      }
      if (!available) throw new Error("bridge unavailable");
      if (method === "list_tracks") return { stateVersion: 7, tracks };
      if (method === "list_browser_roots") return { stateVersion: 7, roots: [
        { root: "instruments", available: true }, { root: "splice", available: false }
      ] };
      if (method === "list_devices") return { stateVersion: 7, trackId: mismatched ? "track-9" : args.trackId,
        devices: args.trackId === "track-2" ? [{ id: "track-2:device-1" }] : [] };
      if (method === "list_clips") return { stateVersion: 7, trackId: args.trackId,
        clips: [{ id: `${args.trackId}:clip-0`, hasClip: false },
          { id: `${args.trackId}:clip-3`, hasClip: true }] };
      if (method === "get_audio_clip_state") return { stateVersion: 7, trackId: args.trackId,
        clipId: args.clipId, source: { path: null } };
      throw new Error(`unexpected discovery operation: ${method}`);
    } }
  });
}

test("discovery supplies observed, paired target examples without changing defaults", async () => {
  const tools = (await createRouter(service())({ id: 1, method: "tools/list" })).result.tools;
  const properties = name => tools.find(tool => tool.name === name).inputSchema.properties;
  assert.deepEqual(properties("get_track_mixer").trackId.examples, ["track-2"]);
  assert.deepEqual(properties("get_preset").presetId.examples, ["catalog:observed"]);
  assert.deepEqual(properties("list_device_parameters").deviceId.examples, ["track-2:device-1"]);
  assert.deepEqual(properties("get_midi_clip_notes_extended").clipId.examples, ["track-2:clip-3"]);
  assert.deepEqual(properties("get_audio_clip_state").trackId.examples, ["track-3"]);
  assert.deepEqual(properties("get_audio_clip_state").clipId.examples, ["track-3:clip-3"]);
  assert.deepEqual(properties("get_browser_items").root.examples, ["instruments"]);
  assert.equal(properties("analyze_audio_file").sourcePath.examples, undefined);
  assert.equal(properties("set_track_mixer").trackId.examples, undefined);
  assert.equal(properties("get_track_mixer").trackId.default, undefined);
});

test("unavailable Live does not block discovery or invent target examples", async () => {
  const tools = (await createRouter(service({ available: false }))({ id: 1, method: "tools/list" })).result.tools;
  assert.ok(tools.length > 0);
  const properties = tools.find(tool => tool.name === "get_track_mixer").inputSchema.properties;
  assert.equal(properties.trackId.examples, undefined);
  assert.deepEqual(tools.find(tool => tool.name === "get_preset").inputSchema.properties.presetId.examples,
    ["catalog:observed"]);
});

test("discovery rejects a device readback from a different owner", async () => {
  const tools = (await createRouter(service({ mismatched: true }))({ id: 1, method: "tools/list" })).result.tools;
  assert.equal(tools.find(tool => tool.name === "list_device_parameters").inputSchema.properties.deviceId.examples,
    undefined);
});

test("discovery respects a bridge that accepts one connection at a time", async () => {
  const tools = (await createRouter(service({ serial: true }))({ id: 1, method: "tools/list" })).result.tools;
  const properties = name => tools.find(tool => tool.name === name).inputSchema.properties;
  assert.deepEqual(properties("list_device_parameters").deviceId.examples, ["track-2:device-1"]);
  assert.deepEqual(properties("get_browser_items").root.examples, ["instruments"]);
  assert.deepEqual(properties("get_audio_clip_state").clipId.examples, ["track-3:clip-3"]);
});

test("invalid browser roots are rejected before service dispatch", async () => {
  const tools = (await createRouter(service())({ id: 1, method: "tools/list" })).result.tools;
  const root = tools.find(tool => tool.name === "get_browser_items").inputSchema.properties.root;
  assert.ok(root.enum.includes("instruments"));
  const route = createRouter(service());
  const invalid = await route({ id: 2, method: "tools/call", params: {
    name: "get_browser_items", arguments: { root: "not-a-root" }
  } });
  assert.equal(invalid.error?.code, -32602);
});
