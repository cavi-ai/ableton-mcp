import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";
import { getPrompt } from "../src/prompts.mjs";

function fixture() {
  const context = { stateVersion: 4, setFingerprint: "set", trackId: "track-0",
    sourceClipId: "track-0:clip-0", source: { name: "Original", notes: [{ noteId: 7, velocity: 90 }] },
    slots: [{ id: "track-0:clip-0", hasClip: true },
      { id: "track-0:clip-1", hasClip: false }, { id: "track-0:clip-2", hasClip: false }] };
  const writes = [];
  const service = new ToolService({ bridge: { request: async (method, args) => {
    if (method === "get_selection_context") return { stateVersion: 4, selectedTrack: { id: "track-0" } };
    if (method === "get_midi_clip_variation_context") return structuredClone(context);
    if (method === "duplicate_midi_clip_variations") {
      writes.push(args);
      return { stateVersion: 5, source: structuredClone(context.source), variants: args.variants };
    }
    throw new Error(`unexpected ${method}`);
  } } });
  const args = { expectedStateVersion: 4, trackId: "track-0", sourceClipId: "track-0:clip-0",
    variants: [{ clipId: "track-0:clip-1", name: "Sparse" }, { clipId: "track-0:clip-2", name: "Syncopated" }] };
  return { service, context, writes, args };
}

test("variation planning is read-only and confirmation binds the source and both empty slots", async () => {
  const { service, args, writes } = fixture();
  const planned = await service.call("duplicate_midi_clip_variations", args);
  assert.equal(planned.dryRun, true);
  assert.equal(writes.length, 0);
  assert.equal(planned.plan.before.source.notes[0].velocity, 90);
  const confirmed = { ...args, dryRun: false, confirmationToken: planned.confirmation.token,
    planHash: planned.confirmation.planHash };
  const applied = await service.call("duplicate_midi_clip_variations", confirmed);
  assert.equal(applied.observed.variants.length, 2);
  assert.equal(writes.length, 1);
  await assert.rejects(service.call("duplicate_midi_clip_variations", confirmed), /confirmation token/);
});

test("a manual source edit invalidates confirmation even without a state-version change", async () => {
  const { service, args, context, writes } = fixture();
  const planned = await service.call("duplicate_midi_clip_variations", args);
  context.source.notes[0].velocity = 105;
  await assert.rejects(service.call("duplicate_midi_clip_variations", { ...args, dryRun: false,
    confirmationToken: planned.confirmation.token, planHash: planned.confirmation.planHash }), /plan hash mismatch/);
  assert.equal(writes.length, 0);
});

test("occupied, repeated, source and unknown destinations are refused before any write", async () => {
  for (const variants of [
    [{ clipId: "track-0:clip-0", name: "Bad" }],
    [{ clipId: "track-0:clip-9", name: "Bad" }],
    [{ clipId: "track-0:clip-1", name: "A" }, { clipId: "track-0:clip-1", name: "B" }],
    [{ clipId: "track-0:clip-1", name: " " }], []
  ]) {
    const { service, args, writes } = fixture();
    await assert.rejects(service.call("duplicate_midi_clip_variations", { ...args, variants }));
    assert.equal(writes.length, 0);
  }
  const { service, args, context } = fixture();
  context.slots[1].hasClip = true;
  await assert.rejects(service.call("duplicate_midi_clip_variations", args), /empty/);
});

test("selection and variation tools are discoverable in core with correct mutation annotations", async () => {
  const { service } = fixture();
  const route = createRouter(service, { toolProfile: "core" });
  const tools = (await route({ id: 1, method: "tools/list" })).result.tools;
  assert.equal(tools.find(t => t.name === "get_selection_context")?.annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === "duplicate_midi_clip_variations")?.annotations.readOnlyHint, false);
  const selected = await route({ id: 2, method: "tools/call", params: { name: "get_selection_context", arguments: {} } });
  assert.equal(selected.result.structuredContent.selectedTrack.id, "track-0");
});

test("the collaborative prompt preserves originals and re-reads manual edits before refinement", () => {
  const text = getPrompt("develop-selected-midi-clip", { request: "two less busy versions" }).messages[0].content.text;
  for (const phrase of ["get_selection_context", "duplicate_midi_clip_variations", "set_midi_note_properties",
    "launch_clip", "re-read", "original", "manual", "stop_clip"]) assert.ok(text.includes(phrase), phrase);
});
