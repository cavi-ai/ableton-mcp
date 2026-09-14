import test from "node:test";
import assert from "node:assert/strict";
import { getFactoryDeviceProfile, listFactoryDeviceProfiles, groupDeviceParameters } from "../src/factory-device-knowledge.mjs";

test("factory-device catalog covers foundational instruments and effects", () => {
  assert.deepEqual(listFactoryDeviceProfiles().map(({ id }) => id), [
    "simpler", "sampler", "drum-rack", "analog", "drift", "operator", "wavetable",
    "eq-eight", "delay", "echo", "reverb", "hybrid-reverb", "auto-shift", "glue-compressor", "limiter", "instrument-rack"
  ]);
});

test("renamed instrument racks are not mistaken for drum racks", () => {
  assert.equal(getFactoryDeviceProfile({ name: "Layered Bass", className: "InstrumentGroupDevice" })?.id, "instrument-rack");
  assert.equal(getFactoryDeviceProfile({ name: "Custom Kit", className: "DrumGroupDevice" })?.id, "drum-rack");
  assert.equal(getFactoryDeviceProfile({ name: "Instrument Rack" })?.id, "instrument-rack");
  const groups = groupDeviceParameters(getFactoryDeviceProfile({ name: "Layered Bass", className: "InstrumentGroupDevice" }), [{ id: "macro", name: "Macro 1" }, { id: "selector", name: "Chain Selector" }]);
  assert.deepEqual(groups.macro.map(p => p.id), ["macro"]);
  assert.deepEqual(groups.chain.map(p => p.id), ["selector"]);
});

test("native class identity takes precedence over conflicting editable names", () => {
  assert.equal(getFactoryDeviceProfile({ name: "Drum Rack", className: "InstrumentGroupDevice" }).id, "instrument-rack");
  assert.equal(getFactoryDeviceProfile({ name: "EQ Eight", className: "Delay" }).id, "delay");
  assert.equal(getFactoryDeviceProfile({ name: "Drum Rack", classDisplayName: "Instrument Rack" }).id, "instrument-rack");
});

test("bus dynamics profiles retain sidechain and limiting control identities", () => {
  const glue = getFactoryDeviceProfile({ className: "GlueCompressor", name: "Bus Glue" });
  assert.equal(glue?.id, "glue-compressor");
  const grouped = groupDeviceParameters(glue, [{ id: "sc", name: "S/C EQ Gain" }, { id: "out", name: "Output" }, { id: "attack", name: "Attack" }, { id: "ratio", name: "Ratio" }]);
  assert.deepEqual(grouped.sidechain.map(p => p.id), ["sc"]);
  assert.deepEqual(grouped.gain.map(p => p.id), ["out"]);
  assert.deepEqual(grouped.timing.map(p => p.id), ["attack"]);
  assert.deepEqual(grouped.dynamics.map(p => p.id), ["ratio"]);
  const limiter = getFactoryDeviceProfile({ className: "Limiter", name: "Final Peaks" });
  assert.equal(limiter?.id, "limiter");
  const limiting = groupDeviceParameters(limiter, [{ id: "mode", name: "Mode" }, { id: "link", name: "M/S Link" }, { id: "ceiling", name: "Ceiling" }, { id: "look", name: "Lookahead" }]);
  assert.deepEqual(limiting.mode.map(p => p.id), ["mode"]);
  assert.deepEqual(limiting.stereo.map(p => p.id), ["link"]);
  assert.deepEqual(limiting.dynamics.map(p => p.id), ["ceiling"]);
  assert.deepEqual(limiting.timing.map(p => p.id), ["look"]);
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
  assert.equal(getFactoryDeviceProfile({ className: "DrumGroupDevice", name: "Drum Rack" }).id, "drum-rack");
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
