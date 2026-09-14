import test from "node:test";
import assert from "node:assert/strict";
import { getFactoryDeviceProfile, listFactoryDeviceProfiles, groupDeviceParameters } from "../src/factory-device-knowledge.mjs";

test("EQ Three preserves native band gains, crossovers and band switches", () => {
  const profile = getFactoryDeviceProfile({ className: "FilterEQ3", name: "Renamed Crossover" });
  assert.equal(profile?.id, "eq-three");
  const names = ["Device On", "GainLo", "GainMid", "GainHi", "FreqLo", "FreqHi", "LowOn", "MidOn", "HighOn", "Slope", "Future Control"];
  const groups = groupDeviceParameters(profile, names.map((name, i) => ({ id: `parameter-${i}`, name })));
  for (const [role, indices] of Object.entries({ global: [0], gain: [1, 2, 3], crossover: [4, 5], bandEnabled: [6, 7, 8], slope: [9], other: [10] })) {
    assert.deepEqual(groups[role].map(p => p.id), indices.map(i => `parameter-${i}`), role);
  }
  assert.equal(Object.values(groups).flat().length, names.length);
});

test("Wavetable native identity separates envelope and filter destinations", () => {
  const profile = getFactoryDeviceProfile({ className: "InstrumentVector", name: "Renamed Bass" });
  assert.equal(profile?.id, "wavetable");
  const names = ["Device On", "Osc 1 Pos", "Osc 2 Gain", "Sub On", "Sub Tone", "Sub Transpose", "Flt 1 Freq", "Flt 1 Res", "Flt 2 Drive", "Amp Attack", "Amp A Slope", "Amp Loop Mode", "Env 2 Attack", "Env 2 Initial", "Env 3 Final", "Env 3 Loop Mode", "LFO 1 Attack Time", "LFO 2 S. Rate", "Global Mod Amount", "Transpose", "Glide", "Unison Amount", "Time", "Volume", "Future Control"];
  const parameters = names.map((name, i) => ({ id: `parameter-${i}`, name }));
  const groups = groupDeviceParameters(profile, parameters);
  const ids = role => (groups[role] || []).map(p => p.id);
  for (const [role, indices] of Object.entries({ global: [0], oscillator: [1, 2], subOscillator: [3, 4, 5], filter1: [6, 7], filter2: [8], amplitudeEnvelope: [9, 10, 11], modulationEnvelope2: [12, 13], modulationEnvelope3: [14, 15], lfo1: [16], lfo2: [17], modulation: [18], pitch: [19, 20], unison: [21], envelopeTiming: [22], amplitude: [23], other: [24] })) {
    assert.deepEqual(ids(role), indices.map(i => `parameter-${i}`), role);
  }
  assert.deepEqual(Object.values(groups).flat().map(p => p.id).sort(), parameters.map(p => p.id).sort());
});

test("Operator separates native oscillator, pitch, filter and LFO envelopes", () => {
  const profile = getFactoryDeviceProfile({ className: "Operator", name: "Bass Sub" });
  const names = ["Device On", "Algorithm", "A Fix Freq", "B Freq<Vel", "C Quantize", "D Fix On ", "Osc-A < LFO",
    "Ae Attack", "Ae Init", "Be Peak", "Ce Mode", "De R < Vel", "Pe Attack", "Pe Amount", "Le Release", "Le Loop",
    "Fe Attack", "Fe A Slope", "Filter Freq", "Filt < Vel", "LFO < Pe", "Transpose", "PB Range", "Glide Time", "Volume", "Panorama", "Time < Key", "Shaper Drive", "Unknown Future Control"];
  const parameters = names.map((name, i) => ({ id: `parameter-${i}`, name }));
  const groups = groupDeviceParameters(profile, parameters);
  const ids = role => (groups[role] || []).map(p => p.id);
  assert.deepEqual(ids("oscillator"), [2, 3, 4, 5, 6].map(i => `parameter-${i}`));
  assert.deepEqual(ids("oscillatorAEnvelope"), ["parameter-7", "parameter-8"]);
  assert.deepEqual(ids("oscillatorBEnvelope"), ["parameter-9"]);
  assert.deepEqual(ids("oscillatorCEnvelope"), ["parameter-10"]);
  assert.deepEqual(ids("oscillatorDEnvelope"), ["parameter-11"]);
  assert.deepEqual(ids("pitchEnvelope"), ["parameter-12", "parameter-13"]);
  assert.deepEqual(ids("lfoEnvelope"), ["parameter-14", "parameter-15"]);
  assert.deepEqual(ids("filterEnvelope"), ["parameter-16", "parameter-17"]);
  assert.deepEqual(ids("filter"), ["parameter-18", "parameter-19"]);
  assert.deepEqual(ids("modulation"), ["parameter-20"]);
  assert.deepEqual(ids("pitch"), ["parameter-21", "parameter-22", "parameter-23"]);
  assert.deepEqual(ids("amplitude"), ["parameter-24"]);
  assert.deepEqual(ids("stereo"), ["parameter-25"]);
  assert.deepEqual(ids("envelopeTiming"), ["parameter-26"]);
  assert.deepEqual(ids("shaper"), ["parameter-27"]);
  assert.deepEqual(ids("other"), ["parameter-28"]);
  assert.deepEqual(Object.values(groups).flat().map(p => p.id).sort(), parameters.map(p => p.id).sort());
});

test("factory-device catalog covers foundational instruments and effects", () => {
  assert.deepEqual(listFactoryDeviceProfiles().map(({ id }) => id), [
    "eq-three", "utility", "saturator", "simpler", "sampler", "drum-rack", "analog", "drift", "operator", "wavetable",
    "eq-eight", "delay", "echo", "reverb", "hybrid-reverb", "auto-shift", "glue-compressor", "limiter", "instrument-rack", "audio-effect-rack", "midi-effect-rack", "arpeggiator", "compressor", "gate"
  ]);
});

test("Compressor preserves native roles and distinguishes automatic release from device power", () => {
  const profile = getFactoryDeviceProfile({ className: "Compressor2", name: "Bass Dynamics" });
  assert.equal(profile?.id, "compressor");
  const names = ["Device On", "Threshold", "Ratio", "Expansion Ratio", "Attack", "Release",
    "Auto Release On/Off", "Output", "Makeup", "Dry/Wet", "Model", "Env Mode", "Knee", "LookAhead",
    "S/C Listen", "S/C EQ On", "S/C EQ Type", "S/C EQ Freq", "S/C EQ Q", "S/C EQ Gain",
    "S/C On", "S/C Gain", "S/C Mix", "Unknown Future Control"];
  const params = names.map((name, i) => ({ id: `parameter-${i}`, name, originalName: name }));
  const groups = groupDeviceParameters(profile, params);
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.dynamics.map(p => p.id), ["parameter-1", "parameter-2", "parameter-3", "parameter-12"]);
  assert.deepEqual(groups.timing.map(p => p.id), ["parameter-4", "parameter-5", "parameter-6", "parameter-13"]);
  assert.deepEqual(groups.gain.map(p => p.id), ["parameter-7", "parameter-8"]);
  assert.deepEqual(groups.mix.map(p => p.id), ["parameter-9"]);
  assert.deepEqual(groups.detector.map(p => p.id), ["parameter-10", "parameter-11"]);
  assert.deepEqual(groups.sidechain.map(p => p.id), ["parameter-14", "parameter-15", "parameter-16", "parameter-17",
    "parameter-18", "parameter-19", "parameter-20", "parameter-21", "parameter-22"]);
  assert.deepEqual(groups.other.map(p => p.id), ["parameter-23"]);
  assert.equal(groups.timing[2].name, "Auto Release On/Off");
});

test("Arpeggiator groups native timing, pitch and velocity controls without losing labels", () => {
  const profile = getFactoryDeviceProfile({ className: "MidiArpeggiator", name: "Bass Motion" });
  assert.equal(profile?.id, "arpeggiator");
  const names = ["Style", "Offset", "Repeats", "Sync On", "Synced Rate", "Groove", "Free Rate", "Gate", "Retrigger Mode", "Ret. Interval", "Hold On", "Tranpose Mode", "Tranpose Key", "Transp. Steps", "Transp. Dist.", "Velocity On", "Vel. Retrigger", "Velocity Decay", "Velocity Target", "Use Current Scale"];
  const parameters = names.map((name, i) => ({ id: `parameter-${i + 1}`, name, originalName: name }));
  const groups = groupDeviceParameters(profile, parameters);
  assert.deepEqual(groups.pattern.map(p => p.id), ["parameter-1", "parameter-2", "parameter-3"]);
  assert.deepEqual(groups.timing.map(p => p.id), ["parameter-4", "parameter-5", "parameter-6", "parameter-7", "parameter-8"]);
  assert.deepEqual(groups.velocity.map(p => p.id), ["parameter-16", "parameter-17", "parameter-18", "parameter-19"]);
  assert.deepEqual(groups.trigger.map(p => p.id), ["parameter-9", "parameter-10", "parameter-11"]);
  assert.deepEqual(groups.pitch.map(p => p.id), ["parameter-12", "parameter-13", "parameter-14", "parameter-15", "parameter-20"]);
  assert.equal(groups.pitch[0].name, "Tranpose Mode");
  assert.deepEqual(groups.other, []);
});

test("effect rack profiles preserve their native audio and MIDI signal domains", () => {
  for (const [className, id, type] of [["AudioEffectGroupDevice", "audio-effect-rack", "audio_effect"], ["MidiEffectGroupDevice", "midi-effect-rack", "midi_effect"]]) {
    const profile = getFactoryDeviceProfile({ className, name: "Custom Chain" });
    assert.equal(profile?.id, id);
    assert.equal(profile.type, type);
    const groups = groupDeviceParameters(profile, [{ id: "macro", name: "Macro 1" }, { id: "chain", name: "Chain Selector" }]);
    assert.deepEqual(groups.macro.map(p => p.id), ["macro"]);
    assert.deepEqual(groups.chain.map(p => p.id), ["chain"]);
  }
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

test("Gate native identity and producer groups preserve all observed controls", () => {
  const profile = getFactoryDeviceProfile({ className: "Gate", name: "Drum Cleanup" });
  assert.equal(profile?.id, "gate");
  const names = ["Device On", "Threshold", "Attack", "Hold", "Release", "Return", "Floor", "S/C Listen", "FlipMode", "LookAhead", "S/C On", "S/C Gain", "S/C Mix", "S/C EQ Type", "S/C EQ On", "S/C EQ Freq", "S/C EQ Gain", "S/C EQ Q"];
  const parameters = names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name }));
  const groups = groupDeviceParameters(profile, parameters);
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.dynamics.map(p => p.id), ["parameter-1", "parameter-5", "parameter-6"]);
  assert.deepEqual(groups.timing.map(p => p.id), ["parameter-2", "parameter-3", "parameter-4", "parameter-9"]);
  assert.deepEqual(groups.mode.map(p => p.id), ["parameter-8"]);
  assert.deepEqual(groups.sidechain.map(p => p.id), ["parameter-7", ...Array.from({ length: 8 }, (_, i) => `parameter-${i + 10}`)]);
  assert.equal(Object.values(groups).flat().length, 18);
});

test("factory-device lookup accepts Live display and class identities", () => {
  assert.equal(getFactoryDeviceProfile({ name: "EQ Eight" }).id, "eq-eight");
  assert.equal(getFactoryDeviceProfile({ className: "DrumGroupDevice", name: "Drum Rack" }).id, "drum-rack");
  assert.equal(getFactoryDeviceProfile({ className: "OriginalSimpler", name: "Kick" }).id, "simpler");
  assert.equal(getFactoryDeviceProfile({ className: "MultiSampler", name: "Strings" }).id, "sampler");
  assert.equal(getFactoryDeviceProfile({ className: "UltraAnalog", name: "Warm Pad" }).id, "analog");
  assert.equal(getFactoryDeviceProfile({ name: "Omnisphere" }), undefined);
});

test("Saturator distinguishes waveshaper drive from input gain and clipping mode", () => {
  const profile = getFactoryDeviceProfile({ className: "Saturator", name: "Bass Harmonics" });
  assert.equal(profile?.id, "saturator");
  const names = ["Device On", "Drive", "Pre Dc Filter", "Type", "Color On", "Color Amt Low", "Color Freq", "Color Width", "Color Amt Hi", "Post Clip Mode", "Output", "Dry/Wet", "Threshold", "WS Drive", "WS Linearity", "WS Curve", "WS Damp", "WS Period", "WS Depth"];
  const parameters = names.map((name, i) => ({ id: `parameter-${i}`, name }));
  const groups = groupDeviceParameters(profile, parameters);
  assert.deepEqual(groups.gain.map(p => p.id), ["parameter-1", "parameter-10"]);
  assert.deepEqual(groups.waveshaper.map(p => p.id), names.slice(13).map((_, i) => `parameter-${i + 13}`));
  assert.deepEqual(groups.clipping.map(p => p.id), ["parameter-9", "parameter-12"]);
  assert.equal(groups.other.length, 0);
  assert.equal(Object.values(groups).flat().length, names.length);
});

test("Utility preserves bass-mono controls separately from full-band mono", () => {
  const profile = getFactoryDeviceProfile({ className: "StereoGain", name: "Bass Bus" });
  assert.equal(profile?.id, "utility");
  const names = ["Device On", "Left Inv", "Right Inv", "Channel Mode", "Stereo Width", "Mono", "Bass Mono", "Bass Freq", "Balance", "Output", "Mute", "DC Filter"];
  const groups = groupDeviceParameters(profile, names.map((name, i) => ({ id: `parameter-${i}`, name })));
  assert.deepEqual(groups.bass.map(p => p.id), ["parameter-6", "parameter-7"]);
  assert.deepEqual(groups.stereo.map(p => p.id), ["parameter-3", "parameter-4", "parameter-5", "parameter-8"]);
  assert.deepEqual(groups.phase.map(p => p.id), ["parameter-1", "parameter-2"]);
  assert.equal(groups.other.length, 0);
  assert.equal(Object.values(groups).flat().length, names.length);
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
