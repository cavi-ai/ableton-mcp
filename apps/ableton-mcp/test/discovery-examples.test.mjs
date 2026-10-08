import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { discoverExamples } from "../src/discovery-examples.mjs";

function service({ available = true, mismatched = false, serial = false,
  prefixEmpty = false, arrangementOnly = false, sourcePath = null, sourceVersion = 7 } = {}) {
  const tracks = [...(prefixEmpty ? [{ id: "track-0", type: "midi" }, { id: "track-1", type: "audio" }] : []),
    { id: "track-2", type: "midi" }, { id: "track-3", type: "audio" }];
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
          { id: `${args.trackId}:clip-3`, hasClip: !arrangementOnly && ["track-2", "track-3"].includes(args.trackId) }] };
      if (method === "list_arrangement_clips") return { stateVersion: 7, trackId: args.trackId,
        clips: arrangementOnly && ["track-2", "track-3"].includes(args.trackId)
          ? [{ id: `${args.trackId}:arrangement-clip-1`, type: tracks.find(track => track.id === args.trackId).type }] : [] };
      if (method === "get_audio_clip_state") return { stateVersion: sourceVersion, trackId: args.trackId,
        clipId: args.clipId, source: { path: sourcePath } };
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

test("discovery finds populated Session clips after empty tracks and exposes a verified source file", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ab-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.wav");
  await writeFile(sourcePath, "loaded source fixture");
  const tools = (await createRouter(service({ prefixEmpty: true, sourcePath }))({ id: 1, method: "tools/list" })).result.tools;
  const properties = name => tools.find(tool => tool.name === name).inputSchema.properties;
  assert.deepEqual(properties("get_midi_clip_notes_extended").trackId.examples, ["track-2"]);
  assert.deepEqual(properties("get_midi_clip_notes_extended").clipId.examples, ["track-2:clip-3"]);
  assert.deepEqual(properties("get_clip_timing").clipId.examples, ["track-2:clip-3"]);
  assert.deepEqual(properties("get_audio_clip_state").trackId.examples, ["track-3"]);
  assert.deepEqual(properties("analyze_audio_clip").clipId.examples, ["track-3:clip-3"]);
  assert.deepEqual(properties("analyze_audio_file").sourcePath.examples, [sourcePath]);
});

test("discovery falls back to typed Arrangement clips", async () => {
  const examples = await service({ prefixEmpty: true, arrangementOnly: true }).discoveryExamples();
  assert.deepEqual(examples.midiClip, { trackId: "track-2", clipId: "track-2:arrangement-clip-1" });
  assert.deepEqual(examples.audioClip, { trackId: "track-3", clipId: "track-3:arrangement-clip-1" });
});

test("discovery limits the number of inspected track owners", async () => {
  const inspected = new Set();
  await discoverExamples(async (name, args) => {
    if (name === "list_tracks") return { stateVersion: 7,
      tracks: Array.from({ length: 100 }, (_, index) => ({ id: `track-${index}`, type: index % 2 ? "audio" : "midi" })) };
    if (args.trackId) inspected.add(args.trackId);
    return { stateVersion: 7, trackId: args.trackId, clips: [], devices: [] };
  });
  assert.equal(inspected.size, 8);
});

test("discovery omits missing, relative, non-file and stale source examples", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ab-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.wav");
  await writeFile(sourcePath, "loaded source fixture");
  for (const options of [{ sourcePath: join(directory, "missing.wav") }, { sourcePath: directory },
    { sourcePath, sourceVersion: 8 }, { sourcePath: relative(process.cwd(), sourcePath) }]) {
    assert.equal((await service(options).discoveryExamples()).sourcePath, undefined);
  }
});

test("a failed batch falls back to independent reads without losing valid clip examples", async () => {
  const s = service({ prefixEmpty: true });
  s.bridge.requestMany = async () => { throw new Error("one native read failed"); };
  const examples = await s.discoveryExamples();
  assert.deepEqual(examples.midiClip, { trackId: "track-2", clipId: "track-2:clip-3" });
  assert.deepEqual(examples.audioClip, { trackId: "track-3", clipId: "track-3:clip-3" });
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
