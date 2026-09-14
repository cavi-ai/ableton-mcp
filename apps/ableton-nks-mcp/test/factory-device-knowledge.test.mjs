import test from "node:test";
import assert from "node:assert/strict";
import { getFactoryDeviceProfile, listFactoryDeviceProfiles, groupDeviceParameters } from "../src/factory-device-knowledge.mjs";

test("factory-device catalog covers foundational instruments and effects", () => {
  assert.deepEqual(listFactoryDeviceProfiles().map(({ id }) => id), [
    "simpler", "sampler", "drum-rack", "analog", "drift", "operator", "wavetable",
    "eq-eight", "delay", "echo", "reverb", "hybrid-reverb", "auto-shift"
  ]);
});

test("Auto Shift separates correction, transposition and expression routing", () => {
  const profile = getFactoryDeviceProfile({ name: "Auto Shift" });
  assert.equal(profile?.family, "pitch-correction");
  const parameters = ["Root", "Scale", "Strength", "Smooth Time", "Pitch St.", "Formant Shift", "MIDI > Pitch Src", "MIDI > Form. Src", "LFO > Pitch", "Dry/Wet"].map((name, index) => ({ id: `parameter-${index}`, name }));
  const groups = groupDeviceParameters(profile, parameters);
  assert.deepEqual(groups.correction.map(p => p.id), ["parameter-0", "parameter-1", "parameter-2", "parameter-3"]);
  assert.deepEqual(groups.pitch.map(p => p.id), ["parameter-4"]);
  assert.deepEqual(groups.formant.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.expression.map(p => p.id), ["parameter-6", "parameter-7"]);
  assert.deepEqual(groups.modulation.map(p => p.id), ["parameter-8"]);
  assert.deepEqual(groups.mix.map(p => p.id), ["parameter-9"]);
});

test("factory-device lookup accepts Live display and class identities", () => {
  assert.equal(getFactoryDeviceProfile({ name: "EQ Eight" }).id, "eq-eight");
  assert.equal(getFactoryDeviceProfile({ className: "InstrumentGroupDevice", name: "Drum Rack" }).id, "drum-rack");
  assert.equal(getFactoryDeviceProfile({ className: "OriginalSimpler", name: "Kick" }).id, "simpler");
  assert.equal(getFactoryDeviceProfile({ className: "MultiSampler", name: "Strings" }).id, "sampler");
  assert.equal(getFactoryDeviceProfile({ className: "UltraAnalog", name: "Warm Pad" }).id, "analog");
  assert.equal(getFactoryDeviceProfile({ name: "Omnisphere" }), undefined);
});

test("parameter grouping preserves live IDs while assigning producer roles", () => {
  const grouped = groupDeviceParameters(getFactoryDeviceProfile({ name: "Delay" }), [
    { id: "parameter-1", name: "Dry/Wet", originalName: "Dry/Wet" },
    { id: "parameter-2", name: "Feedback", originalName: "Feedback" },
    { id: "parameter-3", name: "L Time", originalName: "L Sync Time" },
    { id: "parameter-4", name: "Device On", originalName: "Device On" }
  ]);
  assert.deepEqual(grouped.mix.map(({ id }) => id), ["parameter-1"]);
  assert.deepEqual(grouped.feedback.map(({ id }) => id), ["parameter-2"]);
  assert.deepEqual(grouped.time.map(({ id }) => id), ["parameter-3"]);
  assert.deepEqual(grouped.global.map(({ id }) => id), ["parameter-4"]);
});
