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
    "eq-eight", "delay", "echo", "reverb", "hybrid-reverb", "auto-shift", "glue-compressor", "limiter", "instrument-rack", "audio-effect-rack", "midi-effect-rack", "arpeggiator", "compressor", "gate", "auto-filter", "channel-eq", "multiband-dynamics", "drum-buss", "roar", "meld", "drum-sampler", "collision", "tension", "electric", "impulse", "ds-kick", "ds-snare", "ds-clap", "ds-tom", "ds-hh", "ds-cymbal", "ds-fm", "ds-clang", "external-instrument", "amp", "cabinet", "beat-repeat", "chorus-ensemble", "phaser-flanger", "align-delay", "auto-pan-tremolo", "corpus", "dynamic-tube", "envelope-follower", "erosion", "external-audio-effect", "filter-delay", "grain-delay"
  ]);
});

test("Auto Filter preserves filter, modulation, envelope, sidechain and output controls", () => {
  const profile = getFactoryDeviceProfile({ className: "AutoFilter2", name: "Renamed Sweep" });
  assert.equal(profile?.id, "auto-filter");
  const names = ["Device On", "Frequency", "Resonance", "Filter Morph", "Filter Type", "Filter Slope", "Morph Slope",
    "Circuit", "Drive", "Control", "Pitch", "Formant", "LFO Amount", "LFO Wave", "LFO T Mode", "LFO Freq",
    "LFO Time", "LFO Rate", "LFO 16th", "LFO Phase", "LFO Offset", "LFO S Mode", "LFO Spin", "LFO Morph",
    "LFO Smoothing", "LFO Q Mode", "LFO Steps", "LFO S&H", "Env Amount", "Env Attack", "Env Hold On",
    "Env Release", "Env S&H On", "Env S&H", "Output", "Soft Clip On", "Dry/Wet", "S/C EQ On", "S/C EQ Type",
    "S/C EQ Freq", "S/C EQ Q", "S/C EQ Gain", "S/C On", "S/C Gain", "S/C Mix"];
  const parameters = names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name }));
  const groups = groupDeviceParameters(profile, parameters);
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.filter.map(p => p.id), Array.from({ length: 7 }, (_, i) => `parameter-${i + 1}`));
  assert.deepEqual(groups.character.map(p => p.id), ["parameter-8", "parameter-9", "parameter-10", "parameter-11"]);
  assert.deepEqual(groups.lfo.map(p => p.id), Array.from({ length: 16 }, (_, i) => `parameter-${i + 12}`));
  assert.deepEqual(groups.envelope.map(p => p.id), Array.from({ length: 6 }, (_, i) => `parameter-${i + 28}`));
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-34", "parameter-35"]);
  assert.deepEqual(groups.mix.map(p => p.id), ["parameter-36"]);
  assert.deepEqual(groups.sidechain.map(p => p.id), Array.from({ length: 8 }, (_, i) => `parameter-${i + 37}`));
  assert.deepEqual(groups.other, []);
  assert.equal(Object.values(groups).flat().length, names.length);
});

test("Channel EQ preserves its high-pass, three bands and output gain", () => {
  const profile = getFactoryDeviceProfile({ className: "ChannelEq", name: "Renamed Tone" });
  assert.equal(profile?.id, "channel-eq");
  const names = ["Device On", "Highpass On", "Low Gain", "Mid Gain", "Mid Freq", "High Gain", "Output"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.highpass.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.lowBand.map(p => p.id), ["parameter-2"]);
  assert.deepEqual(groups.midBand.map(p => p.id), ["parameter-3", "parameter-4"]);
  assert.deepEqual(groups.highBand.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-6"]);
  assert.deepEqual(groups.other, []);
});

test("Multiband Dynamics separates crossovers and each three-band dynamics stage", () => {
  const profile = getFactoryDeviceProfile({ className: "MultibandDynamics", name: "Renamed Master Dynamics" });
  assert.equal(profile?.id, "multiband-dynamics");
  const names = ["Device On", "Low-Mid Crossover", "Mid-High Crossover", "Soft Knee On/Off", "Peak/RMS Mode", "Output",
    "Amount", "Time Scaling", "Output Gain (Low)", "Output Gain (Mid)", "Output Gain (High)", "Input Gain (Low)",
    "Input Gain (Mid)", "Input Gain (High)", "Band Activator (Low)", "Band Activator (Mid)", "Band Activator (High)",
    "Above Threshold (Low)", "Above Threshold (Mid)", "Above Threshold (High)", "Below Threshold (Low)",
    "Below Threshold (Mid)", "Below Threshold (High)", "Above Ratio (Low)", "Above Ratio (Mid)", "Above Ratio (High)",
    "Below Ratio (Low)", "Below Ratio (Mid)", "Below Ratio (High)", "Attack Time (Low)", "Attack Time (Mid)",
    "Attack Time (High)", "Release Time (Low)", "Release Time (Mid)", "Release Time (High)", "S/C On", "S/C Gain", "S/C Mix"];
  const parameters = names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name }));
  const groups = groupDeviceParameters(profile, parameters);
  const ids = role => groups[role].map(p => p.id);
  assert.deepEqual(ids("global"), ["parameter-0"]);
  assert.deepEqual(ids("crossover"), ["parameter-1", "parameter-2"]);
  assert.deepEqual(ids("detector"), ["parameter-3", "parameter-4"]);
  assert.deepEqual(ids("output"), ["parameter-5"]);
  assert.deepEqual(ids("globalControl"), ["parameter-6", "parameter-7"]);
  assert.deepEqual(ids("bandOutput"), ["parameter-8", "parameter-9", "parameter-10"]);
  assert.deepEqual(ids("bandInput"), ["parameter-11", "parameter-12", "parameter-13"]);
  assert.deepEqual(ids("bandEnabled"), ["parameter-14", "parameter-15", "parameter-16"]);
  assert.deepEqual(ids("aboveThreshold"), ["parameter-17", "parameter-18", "parameter-19"]);
  assert.deepEqual(ids("belowThreshold"), ["parameter-20", "parameter-21", "parameter-22"]);
  assert.deepEqual(ids("aboveRatio"), ["parameter-23", "parameter-24", "parameter-25"]);
  assert.deepEqual(ids("belowRatio"), ["parameter-26", "parameter-27", "parameter-28"]);
  assert.deepEqual(ids("timing"), Array.from({ length: 6 }, (_, i) => `parameter-${i + 29}`));
  assert.deepEqual(ids("sidechain"), ["parameter-35", "parameter-36", "parameter-37"]);
  assert.deepEqual(groups.other, []);
  assert.equal(Object.values(groups).flat().length, names.length);
});

test("Drum Buss separates compression, drive, transients, boom and gain staging", () => {
  const profile = getFactoryDeviceProfile({ className: "DrumBuss", name: "Renamed Drum Weight" });
  assert.equal(profile?.id, "drum-buss");
  const names = ["Device On", "Compressor On", "Drive", "Drive Type", "Crunch", "Damping Freq", "Transients",
    "Boom Freq", "Boom Amt", "Boom Decay", "Boom Audition", "Trim", "Output", "Dry/Wet"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.compression.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.drive.map(p => p.id), ["parameter-2", "parameter-3"]);
  assert.deepEqual(groups.crunch.map(p => p.id), ["parameter-4"]);
  assert.deepEqual(groups.damping.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.transient.map(p => p.id), ["parameter-6"]);
  assert.deepEqual(groups.boom.map(p => p.id), ["parameter-7", "parameter-8", "parameter-9", "parameter-10"]);
  assert.deepEqual(groups.trim.map(p => p.id), ["parameter-11"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-12"]);
  assert.deepEqual(groups.mix.map(p => p.id), ["parameter-13"]);
  assert.deepEqual(groups.other, []);
});

test("Roar preserves three shaper/filter stages and every modulation subsystem", () => {
  const profile = getFactoryDeviceProfile({ className: "Roar", name: "Renamed Parallel Color" });
  assert.equal(profile?.id, "roar");
  const names = ["Device On", "Drive", "Tone Amt", "Tone Freq", "Color On", "Blend", "Low Mid X-Over", "Mid High X-Over",
    "Stage 1 On", "Shaper 1 On", "Shaper 1 Type", "Shaper 1 Amt", "Shaper 1 Bias", "Shaper 1 Level", "Flt 1 On", "Flt 1 Type", "Flt 1 Freq", "Flt 1 Res", "Flt 1 Morph", "Flt 1 Peak", "Flt 1 Pre On",
    "Stage 2 On", "Shaper 2 On", "Shaper 2 Type", "Shaper 2 Amt", "Shaper 2 Bias", "Shaper 2 Level", "Flt 2 On", "Flt 2 Type", "Flt 2 Freq", "Flt 2 Res", "Flt 2 Morph", "Flt 2 Peak", "Flt 2 Pre On",
    "Stage 3 On", "Shaper 3 On", "Shaper 3 Type", "Shaper 3 Amt", "Shaper 3 Bias", "Shaper 3 Level", "Flt 3 On", "Flt 3 Type", "Flt 3 Freq", "Flt 3 Res", "Flt 3 Morph", "Flt 3 Peak", "Flt 3 Pre On",
    "Feedback", "FB Time Mode", "FB Time", "FB Synced", "FB Note", "FB Freq", "FB Width", "FB Invert", "Fb Gate On",
    "LFO 1 Rate Mode", "LFO 1 Rate", "LFO 1 Synced Rate", "LFO 1 16th", "LFO 1 Wave", "LFO 1 Morph", "LFO 1 Smooth",
    "LFO 2 Rate Mode", "LFO 2 Rate", "LFO 2 Synced Rate", "LFO 2 16th", "LFO 2 Wave", "LFO 2 Morph", "LFO 2 Smooth",
    "Env Gain", "Env Attack", "Env Hold On", "Env Release", "Env Thresh", "Env Freq", "Env Width",
    "Noise Rate Mode", "Noise Rate", "Noise Synced Rate", "Noise 16th", "Noise Type", "Noise Smooth", "Global Mod Amt",
    "Comp Amt", "Comp Hp On", "Output", "Dry/Wet", "S/C On", "S/C Gain", "S/C Mix"];
  const parameters = names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name }));
  const groups = groupDeviceParameters(profile, parameters);
  const ids = role => groups[role].map(p => p.id);
  const range = (start, count) => Array.from({ length: count }, (_, i) => `parameter-${start + i}`);
  assert.deepEqual(ids("global"), ["parameter-0"]);
  assert.deepEqual(ids("drive"), ["parameter-1"]);
  assert.deepEqual(ids("tone"), range(2, 3));
  assert.deepEqual(ids("routing"), range(5, 3));
  assert.deepEqual(ids("stageEnabled"), ["parameter-8", "parameter-21", "parameter-34"]);
  assert.deepEqual(ids("shaper1"), range(9, 5));
  assert.deepEqual(ids("filter1"), range(14, 7));
  assert.deepEqual(ids("shaper2"), range(22, 5));
  assert.deepEqual(ids("filter2"), range(27, 7));
  assert.deepEqual(ids("shaper3"), range(35, 5));
  assert.deepEqual(ids("filter3"), range(40, 7));
  assert.deepEqual(ids("feedback"), range(47, 9));
  assert.deepEqual(ids("lfo1"), range(56, 7));
  assert.deepEqual(ids("lfo2"), range(63, 7));
  assert.deepEqual(ids("envelope"), range(70, 7));
  assert.deepEqual(ids("noise"), range(77, 6));
  assert.deepEqual(ids("modulation"), ["parameter-83"]);
  assert.deepEqual(ids("compression"), range(84, 2));
  assert.deepEqual(ids("output"), ["parameter-86"]);
  assert.deepEqual(ids("mix"), ["parameter-87"]);
  assert.deepEqual(ids("sidechain"), range(88, 3));
  assert.deepEqual(groups.other, []);
  assert.equal(Object.values(groups).flat().length, 91);
});

test("Meld keeps both synthesis engines and their envelopes and modulators independent", () => {
  const profile = getFactoryDeviceProfile({ className: "InstrumentMeld", name: "Renamed Dual Texture" });
  assert.equal(profile?.id, "meld");
  const names = ["On", "MeldVoice_EngineA_On", "MeldVoice_EngineA_Oscillator_OscillatorType", "MeldVoice_EngineA_Filter_FilterType",
    "MeldVoice_EngineA_Lfo1_GeneratorType", "MeldVoice_EngineA_Lfo2_Waveform", "MeldVoice_EngineA_AmpEnvelope_Times_Attack",
    "MeldVoice_EngineA_FilterEnvelope_Values_Peak", "MeldVoice_EngineA_ToneFilter", "MeldVoice_EngineA_GlideTime",
    "MeldVoice_EngineB_On", "MeldVoice_EngineB_Oscillator_Macro1", "MeldVoice_EngineB_Filter_Frequency",
    "MeldVoice_EngineB_Lfo1_Transformer1Type", "MeldVoice_EngineB_Lfo2_Rate", "MeldVoice_EngineB_AmpEnvelope_Sustain",
    "MeldVoice_EngineB_FilterEnvelope_LoopMode", "MeldVoice_EngineB_Volume", "MeldVoice_EngineBDelay", "MeldVoice_Drive",
    "MeldVoice_LimiterOn", "MeldVoice_LinkAmpEnvelopes", "MeldVoice_UseScale", "MeldVoice_VoiceSpreadAmount", "Volume", "MonoLegato"];
  const groups = groupDeviceParameters(profile, names.map((originalName, index) => ({ id: `parameter-${index}`, originalName })));
  const ids = role => groups[role].map(p => p.id);
  assert.deepEqual(ids("global"), ["parameter-0"]);
  assert.deepEqual(ids("engineAState"), ["parameter-1"]);
  assert.deepEqual(ids("engineAOscillator"), ["parameter-2"]);
  assert.deepEqual(ids("engineAFilter"), ["parameter-3"]);
  assert.deepEqual(ids("engineALfo1"), ["parameter-4"]);
  assert.deepEqual(ids("engineALfo2"), ["parameter-5"]);
  assert.deepEqual(ids("engineAAmpEnvelope"), ["parameter-6"]);
  assert.deepEqual(ids("engineAFilterEnvelope"), ["parameter-7"]);
  assert.deepEqual(ids("engineAMix"), ["parameter-8", "parameter-9"]);
  assert.deepEqual(ids("engineBState"), ["parameter-10"]);
  assert.deepEqual(ids("engineBOscillator"), ["parameter-11"]);
  assert.deepEqual(ids("engineBFilter"), ["parameter-12"]);
  assert.deepEqual(ids("engineBLfo1"), ["parameter-13"]);
  assert.deepEqual(ids("engineBLfo2"), ["parameter-14"]);
  assert.deepEqual(ids("engineBAmpEnvelope"), ["parameter-15"]);
  assert.deepEqual(ids("engineBFilterEnvelope"), ["parameter-16"]);
  assert.deepEqual(ids("engineBMix"), ["parameter-17", "parameter-18"]);
  assert.deepEqual(ids("sharedVoice"), ["parameter-19", "parameter-20", "parameter-21", "parameter-22", "parameter-23"]);
  assert.deepEqual(ids("output"), ["parameter-24"]);
  assert.deepEqual(ids("monoMode"), ["parameter-25"]);
  assert.deepEqual(groups.other, []);
});

test("Drum Sampler preserves sample, envelope, filter and algorithm-specific controls", () => {
  const profile = getFactoryDeviceProfile({ className: "DrumCell", name: "Renamed One Shot" });
  assert.equal(profile?.id, "drum-sampler");
  const names = ["Device On", "Transpose", "Detune", "Vel > Vol", "Mod Src", "Mod Dest", "Mod Amt", "Filter On",
    "Filter Freq", "Filter Res", "Filter Type", "Filter Gain", "Attack", "Hold", "Decay", "Env Mode", "Start", "Length",
    "Volume", "Pan", "FX On", "FX Type", "Pitch Env Amt", "Pitch Env Decay", "Sub Amt", "Sub Freq", "Noise Amt",
    "Noise Color", "Loop Offset", "Loop Length", "Stretch Factor", "Grain Size", "Punch Amt", "Punch Release",
    "8-Bit Rate", "8-Bit Flt Decay", "FM Amt", "FM Freq", "RM Amt", "RM Freq"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  const ids = role => groups[role].map(p => p.id);
  const range = (start, count) => Array.from({ length: count }, (_, i) => `parameter-${start + i}`);
  assert.deepEqual(ids("global"), ["parameter-0"]);
  assert.deepEqual(ids("pitch"), range(1, 2));
  assert.deepEqual(ids("velocity"), ["parameter-3"]);
  assert.deepEqual(ids("modulation"), range(4, 3));
  assert.deepEqual(ids("filter"), range(7, 5));
  assert.deepEqual(ids("envelope"), range(12, 4));
  assert.deepEqual(ids("sample"), range(16, 2));
  assert.deepEqual(ids("mixer"), range(18, 2));
  assert.deepEqual(ids("fxMode"), range(20, 2));
  assert.deepEqual(ids("pitchEnvelope"), range(22, 2));
  assert.deepEqual(ids("sub"), range(24, 2));
  assert.deepEqual(ids("noise"), range(26, 2));
  assert.deepEqual(ids("loop"), range(28, 2));
  assert.deepEqual(ids("stretch"), range(30, 2));
  assert.deepEqual(ids("punch"), range(32, 2));
  assert.deepEqual(ids("bitReduction"), range(34, 2));
  assert.deepEqual(ids("fm"), range(36, 2));
  assert.deepEqual(ids("ringMod"), range(38, 2));
  assert.deepEqual(groups.other, []);
  assert.equal(Object.values(groups).flat().length, 40);
});

test("Collision separates exciters, resonators, LFOs and performance expression", () => {
  const profile = getFactoryDeviceProfile({ className: "Collision", name: "Renamed Physical Bell" });
  assert.equal(profile?.id, "collision");
  const names = ["Device On", "Structure", "PB Range", "Voices", "Retrigger", "Volume", "Note PB Range",
    "Mallet On/Off", "Mallet Stiffness", "Mallet Noise Color", "Noise On/Off", "Noise Filter Type", "Noise Attack",
    "Res 1 On/Off", "Res 1 Type", "Res 1 Pitch Env. Time", "Res 1 Material", "Res 1 Listening L",
    "Res 2 On/Off", "Res 2 Type", "Res 2 Decay", "Res 2 Inharmonics", "Res 2 Pan",
    "LFO 1 On/Off", "LFO 1 Shape", "LFO 1 Dest A", "LFO 1 Amt B", "LFO 2 On/Off", "LFO 2 Rate", "LFO 2 Dest B",
    "PB Dest A", "PB Amt A", "MW Dest B", "MW Amt B", "Press Dest A", "Press Amt B", "Slide Dest A", "Slide Amt B"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  const ids = role => groups[role].map(p => p.id);
  assert.deepEqual(ids("global"), Array.from({ length: 7 }, (_, i) => `parameter-${i}`));
  assert.deepEqual(ids("malletExciter"), ["parameter-7", "parameter-8", "parameter-9"]);
  assert.deepEqual(ids("noiseExciter"), ["parameter-10", "parameter-11", "parameter-12"]);
  assert.deepEqual(ids("resonator1"), Array.from({ length: 5 }, (_, i) => `parameter-${i + 13}`));
  assert.deepEqual(ids("resonator2"), Array.from({ length: 5 }, (_, i) => `parameter-${i + 18}`));
  assert.deepEqual(ids("lfo1"), Array.from({ length: 4 }, (_, i) => `parameter-${i + 23}`));
  assert.deepEqual(ids("lfo2"), Array.from({ length: 3 }, (_, i) => `parameter-${i + 27}`));
  assert.deepEqual(ids("expression"), Array.from({ length: 8 }, (_, i) => `parameter-${i + 30}`));
  assert.deepEqual(groups.other, []);
});

test("Tension separates physical string stages, filter envelope and expression", () => {
  const profile = getFactoryDeviceProfile({ className: "StringStudio", name: "Renamed Bowed String" });
  assert.equal(profile?.id, "tension");
  const names = ["Device On", "Voices", "PB Range", "Octave", "Semitone", "Fine Tune", "Key Priority", "Unison On/Off",
    "Uni Detune", "Uni Delay", "Stretch", "Error", "Vibrato On/Off", "Vib Speed", "Vib < ModWh", "Porta On/Off",
    "Porta Time", "Porta Legato", "E Pos", "E Pos < Vel", "Damp Pos", "D Pos < Key", "Exc On/Off", "Exciter Type",
    "Exc ForceMassProt", "Exc Damping", "Pickup On/Off", "Pickup Pos", "Damper On", "Damper Mass", "Damper Gated",
    "Str Damping", "String Decay", "Str Inharmon", "Term On/Off", "Term Mass", "Term Fret Stiff", "LFO On/Off",
    "LFO Shape", "LFO Fade In", "Filter On/Off", "Filter Type", "Freq < Env", "Filter Reso", "FEG On/Off", "FEG Attack",
    "FEG Sustain", "Body On/Off", "Body Type", "Body Low-Cut", "Body Mix", "Volume", "Note PB Range", "Press Dest A",
    "Press Amt B", "Slide Dest A", "Slide Amt B"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  const ids = role => groups[role].map(p => p.id);
  assert.deepEqual(ids("global"), Array.from({ length: 12 }, (_, i) => `parameter-${i}`));
  assert.deepEqual(ids("vibrato"), ["parameter-12", "parameter-13", "parameter-14"]);
  assert.deepEqual(ids("portamento"), ["parameter-15", "parameter-16", "parameter-17"]);
  assert.deepEqual(ids("position"), ["parameter-18", "parameter-19", "parameter-20", "parameter-21"]);
  assert.deepEqual(ids("exciter"), ["parameter-22", "parameter-23", "parameter-24", "parameter-25"]);
  assert.deepEqual(ids("pickup"), ["parameter-26", "parameter-27"]);
  assert.deepEqual(ids("damper"), ["parameter-28", "parameter-29", "parameter-30"]);
  assert.deepEqual(ids("string"), ["parameter-31", "parameter-32", "parameter-33"]);
  assert.deepEqual(ids("termination"), ["parameter-34", "parameter-35", "parameter-36"]);
  assert.deepEqual(ids("lfo"), ["parameter-37", "parameter-38", "parameter-39"]);
  assert.deepEqual(ids("filter"), ["parameter-40", "parameter-41", "parameter-42", "parameter-43"]);
  assert.deepEqual(ids("filterEnvelope"), ["parameter-44", "parameter-45", "parameter-46"]);
  assert.deepEqual(ids("body"), ["parameter-47", "parameter-48", "parameter-49", "parameter-50"]);
  assert.deepEqual(ids("output"), ["parameter-51"]);
  assert.deepEqual(ids("expression"), ["parameter-52", "parameter-53", "parameter-54", "parameter-55", "parameter-56"]);
  assert.deepEqual(groups.other, []);
});

test("Electric separates mallet, noise, fork, pickup and damper mechanics", () => {
  const profile = getFactoryDeviceProfile({ className: "LoungeLizard", name: "Renamed Electric Piano" });
  assert.equal(profile?.id, "electric");
  const names = ["Device On", "Voices", "PB Range", "Note PB Range", "Volume", "Semitone", "Detune", "KB Stretch",
    "M Stiffness", "M Stiff < Key", "M Stiff < Vel", "M Force", "M Force < Key", "M Force < Vel",
    "Noise Pitch", "Noise Decay", "Noise Amount", "Noise < Key", "F Release", "F Tine Decay", "F Tine Vol",
    "F Tine < Key", "F Tine Color", "F Tone Decay", "F Tone Vol", "P Symmetry", "P Distance", "Pickup Model",
    "P Amp In", "P Amp Out", "P Amp < Key", "Damp Tone", "Damp Amount", "Damp Balance"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  const ids = role => groups[role].map(p => p.id);
  assert.deepEqual(ids("global"), Array.from({ length: 8 }, (_, i) => `parameter-${i}`));
  assert.deepEqual(ids("mallet"), Array.from({ length: 6 }, (_, i) => `parameter-${i + 8}`));
  assert.deepEqual(ids("noise"), Array.from({ length: 4 }, (_, i) => `parameter-${i + 14}`));
  assert.deepEqual(ids("fork"), Array.from({ length: 7 }, (_, i) => `parameter-${i + 18}`));
  assert.deepEqual(ids("pickup"), Array.from({ length: 6 }, (_, i) => `parameter-${i + 25}`));
  assert.deepEqual(ids("damper"), Array.from({ length: 3 }, (_, i) => `parameter-${i + 31}`));
  assert.deepEqual(groups.other, []);
});

test("Impulse preserves all eight complete sample-slot control strips", () => {
  const profile = getFactoryDeviceProfile({ className: "InstrumentImpulse", name: "Renamed Drum Slots" });
  assert.equal(profile?.id, "impulse");
  const slotControls = ["Start", "Transpose", "Transpose <- Vel", "Transpose <- Random", "Stretch Mode", "Stretch Factor",
    "Stretch <- Vel", "Saturator Drive", "Filter Type", "Filter Freq", "Filter Res", "Filter <- Vel", "Filter <- Random",
    "Envelope Type", "Envelope Decay", "Pan", "Pan <- Vel", "Pan <- Random", "Volume", "Volume <- Vel"];
  const names = ["Device On", "Global Volume", "Global Time", "Global Transpose",
    ...Array.from({ length: 8 }, (_, slot) => slotControls.map(control => `${slot + 1} ${control}`)).flat()];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), Array.from({ length: 4 }, (_, i) => `parameter-${i}`));
  for (let slot = 1; slot <= 8; slot += 1) {
    assert.deepEqual(groups[`slot${slot}`].map(p => p.id), Array.from({ length: 20 }, (_, i) => `parameter-${4 + ((slot - 1) * 20) + i}`));
  }
  assert.deepEqual(groups.other, []);
  assert.equal(Object.values(groups).flat().length, 164);
});

test("DS Kick separates amplitude, pitch sweep, tone, click and drive", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceInstrument", classDisplayName: "Max Instrument", name: "DS Kick" });
  assert.equal(profile?.id, "ds-kick");
  const names = ["Device On", "Attack", "Decay", "Env", "overdrive", "Overtone", "PhaseReset", "Pitch", "Volume", "Click"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.amplitudeEnvelope.map(p => p.id), ["parameter-1", "parameter-2"]);
  assert.deepEqual(groups.pitchEnvelope.map(p => p.id), ["parameter-3"]);
  assert.deepEqual(groups.drive.map(p => p.id), ["parameter-4"]);
  assert.deepEqual(groups.oscillator.map(p => p.id), ["parameter-5", "parameter-6", "parameter-7"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-8"]);
  assert.deepEqual(groups.transient.map(p => p.id), ["parameter-9"]);
  assert.deepEqual(groups.other, []);
});

test("DS Snare separates noise color, filter, decay, tone and tuning", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceInstrument", classDisplayName: "Max Instrument", name: "DS Snare" });
  assert.equal(profile?.id, "ds-snare");
  const names = ["Device On", "Color", "Decay", "Filter", "Tone", "Tune", "Volume"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.noise.map(p => p.id), ["parameter-1", "parameter-3"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-2"]);
  assert.deepEqual(groups.oscillator.map(p => p.id), ["parameter-4", "parameter-5"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-6"]);
  assert.deepEqual(groups.other, []);
});

test("DS Clap separates burst timing, envelope and spectral controls", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceInstrument", classDisplayName: "Max Instrument", name: "DS Clap" });
  assert.equal(profile?.id, "ds-clap");
  const names = ["Device On", "Decay", "Sloppy", "Spread", "Tail", "Tone", "Tune", "Volume"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-1", "parameter-4"]);
  assert.deepEqual(groups.burst.map(p => p.id), ["parameter-2", "parameter-3"]);
  assert.deepEqual(groups.spectrum.map(p => p.id), ["parameter-5", "parameter-6"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-7"]);
  assert.deepEqual(groups.other, []);
});

test("DS Tom separates body pitch, bend, decay and noise color", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceInstrument", classDisplayName: "Max Instrument", name: "DS Tom" });
  assert.equal(profile?.id, "ds-tom");
  const names = ["Device On", "Color", "Decay", "Pitch", "Bend", "Tone", "Volume"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.noise.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-2"]);
  assert.deepEqual(groups.oscillator.map(p => p.id), ["parameter-3", "parameter-5"]);
  assert.deepEqual(groups.pitchEnvelope.map(p => p.id), ["parameter-4"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-6"]);
  assert.deepEqual(groups.other, []);
});

test("DS HH separates envelope, noise source, filter and pitch", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceInstrument", classDisplayName: "Max Instrument", name: "DS HH" });
  assert.equal(profile?.id, "ds-hh");
  const names = ["Device On", "Attack", "Decay", "Slope", "Noise", "Pitch", "Tone", "Volume"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-1", "parameter-2"]);
  assert.deepEqual(groups.filter.map(p => p.id), ["parameter-3", "parameter-6"]);
  assert.deepEqual(groups.noise.map(p => p.id), ["parameter-4"]);
  assert.deepEqual(groups.oscillator.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-7"]);
  assert.deepEqual(groups.other, []);
});

test("DS Cymbal preserves the complete exposed decay, pitch and tone surface", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceInstrument", classDisplayName: "Max Instrument", name: "DS Cymbal" });
  assert.equal(profile?.id, "ds-cymbal");
  const names = ["Device On", "Decay", "Pitch", "Tone", "Volume"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.oscillator.map(p => p.id), ["parameter-2", "parameter-3"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-4"]);
  assert.deepEqual(groups.other, []);
});

test("DS FM separates decay, modulation and oscillator tone", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceInstrument", classDisplayName: "Max Instrument", name: "DS FM" });
  assert.equal(profile?.id, "ds-fm");
  const names = ["Device On", "Amount", "Decay", "Feedb.", "Mod", "Pitch", "Tone", "Volume"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.modulation.map(p => p.id), ["parameter-1", "parameter-3", "parameter-4"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-2"]);
  assert.deepEqual(groups.oscillator.map(p => p.id), ["parameter-5", "parameter-6"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-7"]);
  assert.deepEqual(groups.other, []);
});

test("DS Clang separates dual tones, clave articulation, noise and filter", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceInstrument", classDisplayName: "Max Instrument", name: "DS Clang" });
  assert.equal(profile?.id, "ds-clang");
  const names = ["Device On", "1st Tone", "2nd Tone", "ClaveRepeat", "Decay", "Filter", "Noise", "Pitch", "Volume", "Clave"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.resonator.map(p => p.id), ["parameter-1", "parameter-2", "parameter-7"]);
  assert.deepEqual(groups.articulation.map(p => p.id), ["parameter-3", "parameter-9"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-4"]);
  assert.deepEqual(groups.filter.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.noise.map(p => p.id), ["parameter-6"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-8"]);
  assert.deepEqual(groups.other, []);
});

test("External Instrument preserves its complete exposed audio-return surface", () => {
  const profile = getFactoryDeviceProfile({ className: "ProxyInstrumentDevice", classDisplayName: "External Instrument", name: "Ext. Instrument" });
  assert.equal(profile?.id, "external-instrument");
  const names = ["Device On", "Input Gain"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.audioReturn.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.other, []);
});

test("Amp separates model, tone stack, gain staging, channel mode and mix", () => {
  const profile = getFactoryDeviceProfile({ className: "Amp", name: "Renamed Amp" });
  assert.equal(profile?.id, "amp");
  const names = ["Device On", "Amp Type", "Bass", "Middle", "Treble", "Presence", "Input Gain", "Volume", "Dual Mono", "Dry/Wet"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.model.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.toneStack.map(p => p.id), ["parameter-2", "parameter-3", "parameter-4", "parameter-5"]);
  assert.deepEqual(groups.gain.map(p => p.id), ["parameter-6", "parameter-7"]);
  assert.deepEqual(groups.channelMode.map(p => p.id), ["parameter-8"]);
  assert.deepEqual(groups.mix.map(p => p.id), ["parameter-9"]);
  assert.deepEqual(groups.other, []);
});

test("Cabinet separates speaker, microphone, channel mode and mix", () => {
  const profile = getFactoryDeviceProfile({ className: "Cabinet", name: "Renamed Speaker" });
  assert.equal(profile?.id, "cabinet");
  const names = ["Device On", "Cabinet Type", "Microphone Type", "Microphone Position", "Dual Mono", "Dry/Wet"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.speaker.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.microphone.map(p => p.id), ["parameter-2", "parameter-3"]);
  assert.deepEqual(groups.channelMode.map(p => p.id), ["parameter-4"]);
  assert.deepEqual(groups.mix.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.other, []);
});

test("Beat Repeat separates timing, triplets, variation, gate, pitch, filter and output", () => {
  const profile = getFactoryDeviceProfile({ className: "BeatRepeat", name: "Renamed Repeater" });
  assert.equal(profile?.id, "beat-repeat");
  const names = ["Device On", "Chance", "Interval", "Offset", "Grid", "Block Triplets", "Variation", "Variation Type",
    "Gate", "Decay", "Pitch Decay", "Pitch", "Mix Type", "Volume", "Filter On", "Filter Freq", "Filter Width", "Repeat"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.timing.map(p => p.id), ["parameter-1", "parameter-2", "parameter-3", "parameter-4", "parameter-5"]);
  assert.deepEqual(groups.variation.map(p => p.id), ["parameter-6", "parameter-7"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-8", "parameter-9"]);
  assert.deepEqual(groups.pitch.map(p => p.id), ["parameter-10", "parameter-11"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-12", "parameter-13"]);
  assert.deepEqual(groups.filter.map(p => p.id), ["parameter-14", "parameter-15", "parameter-16"]);
  assert.deepEqual(groups.performance.map(p => p.id), ["parameter-17"]);
  assert.deepEqual(groups.other, []);
});

test("Chorus-Ensemble separates modulation, delay, feedback, width, color and output", () => {
  const profile = getFactoryDeviceProfile({ className: "Chorus2", name: "Renamed Modulator" });
  assert.equal(profile?.id, "chorus-ensemble");
  const names = ["Device On", "Mode", "Shape", "Rate", "Amount", "Feedback", "FB Invert", "Offset", "Delay Time",
    "Delay Taps", "HP On", "HP Freq", "Width", "Warmth", "Output", "Dry/Wet"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.mode.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.modulation.map(p => p.id), ["parameter-2", "parameter-3", "parameter-4", "parameter-7"]);
  assert.deepEqual(groups.feedback.map(p => p.id), ["parameter-5", "parameter-6"]);
  assert.deepEqual(groups.delay.map(p => p.id), ["parameter-8", "parameter-9"]);
  assert.deepEqual(groups.filter.map(p => p.id), ["parameter-10", "parameter-11"]);
  assert.deepEqual(groups.stereo.map(p => p.id), ["parameter-12"]);
  assert.deepEqual(groups.color.map(p => p.id), ["parameter-13"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-14", "parameter-15"]);
  assert.deepEqual(groups.other, []);
});

test("Phaser-Flanger preserves dual modulation, envelope, topology and feedback safety", () => {
  const profile = getFactoryDeviceProfile({ className: "PhaserNew", name: "Renamed Modulator" });
  assert.equal(profile?.id, "phaser-flanger");
  const names = ["Device On", "Amount", "Mod Wave", "Mod Freq", "Mod Freq 2", "Mod Sync", "Mod Sync 2", "Mod Rate", "Mod Rate 2", "Mod Phase", "Spin Enabled", "Spin", "Duty Cycle", "Lfo Blend", "Env Enabled", "Env Amount", "Env Attack", "Env Release", "Mode", "Notches", "Flanger Time", "Doubler Time", "Mod Blend", "Center Freq", "Spread", "Feedback", "Warmth", "Safe Freq", "FB Invert", "Output", "Dry/Wet"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.modulation.map(p => p.id), names.slice(1, 14).map((_, index) => `parameter-${index + 1}`));
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-14", "parameter-15", "parameter-16", "parameter-17"]);
  assert.deepEqual(groups.mode.map(p => p.id), ["parameter-18"]);
  assert.deepEqual(groups.topology.map(p => p.id), ["parameter-19", "parameter-20", "parameter-21", "parameter-22", "parameter-23", "parameter-24"]);
  assert.deepEqual(groups.feedback.map(p => p.id), ["parameter-25", "parameter-27", "parameter-28"]);
  assert.deepEqual(groups.color.map(p => p.id), ["parameter-26"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-29", "parameter-30"]);
  assert.deepEqual(groups.other, []);
});

test("Align Delay preserves physical units and independent channel alignment", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceAudioEffect", name: "Align Delay" });
  assert.equal(profile?.id, "align-delay");
  assert.equal(getFactoryDeviceProfile({ className: "MxDeviceAudioEffect", name: "Renamed Max Device" }), undefined);
  const names = ["Device On", "Celsius", "DistUnit", "Fahrenheit", "Left Feet", "Left meter", "Left ms", "Delay L Smp", "Link L/R", "Right Feet", "Right meter", "Right ms", "Delay R smp", "TempUnit", "Mode"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.environment.map(p => p.id), ["parameter-1", "parameter-2", "parameter-3", "parameter-13"]);
  assert.deepEqual(groups.left.map(p => p.id), ["parameter-4", "parameter-5", "parameter-6", "parameter-7"]);
  assert.deepEqual(groups.stereo.map(p => p.id), ["parameter-8"]);
  assert.deepEqual(groups.right.map(p => p.id), ["parameter-9", "parameter-10", "parameter-11", "parameter-12"]);
  assert.deepEqual(groups.mode.map(p => p.id), ["parameter-14"]);
  assert.deepEqual(groups.other, []);
});

test("Auto Pan-Tremolo separates mode, clocking, stereo motion, shaping and dynamics", () => {
  const profile = getFactoryDeviceProfile({ className: "AutoPan2", name: "Renamed Motion" });
  assert.equal(profile?.id, "auto-pan-tremolo");
  const names = ["Device On", "Mode", "Amount", "Waveform", "Invert", "Time Mode", "Frequency", "Time", "Rate", "16th", "Phase", "Offset", "Stereo Mode", "Spin", "Panning Shape", "Tremolo Shape", "Attack Time", "Dyn Mod", "Harmonic", "Vintage"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.mode.map(p => p.id), ["parameter-1"]);
  assert.deepEqual(groups.modulation.map(p => p.id), ["parameter-2", "parameter-3", "parameter-4"]);
  assert.deepEqual(groups.timing.map(p => p.id), ["parameter-5", "parameter-6", "parameter-7", "parameter-8", "parameter-9"]);
  assert.deepEqual(groups.stereo.map(p => p.id), ["parameter-10", "parameter-11", "parameter-12", "parameter-13"]);
  assert.deepEqual(groups.shape.map(p => p.id), ["parameter-14", "parameter-15"]);
  assert.deepEqual(groups.dynamics.map(p => p.id), ["parameter-16", "parameter-17"]);
  assert.deepEqual(groups.color.map(p => p.id), ["parameter-18", "parameter-19"]);
  assert.deepEqual(groups.other, []);
});

test("Corpus preserves resonator, modulation, MIDI follow and ambiguous width controls", () => {
  const profile = getFactoryDeviceProfile({ className: "Corpus", name: "Renamed Resonator" });
  assert.equal(profile?.id, "corpus");
  const names = ["Device On", "Resonance Type", "Resonator Quality", "Tune", "Transpose", "Fine", "Spread", "Decay", "Material", "Radius", "Brightness", "Inharmonics", "Opening", "Ratio", "Hit", "Listening L", "Listening R", "LFO On/Off", "LFO Shape", "LFO Sync", "LFO Rate", "LFO Sync Rate", "LFO Stereo Mode", "Spin", "Phase", "Offset", "LFO Amount", "Filter On/Off", "Mid Freq", "Width", "MIDI Frequency", "MIDI Mode", "PB Range", "Note Off", "Off Decay", "Gain", "Width", "Bleed", "Dry Wet"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.model.map(p => p.id), ["parameter-1", "parameter-2"]);
  assert.deepEqual(groups.tuning.map(p => p.id), ["parameter-3", "parameter-4", "parameter-5", "parameter-6"]);
  assert.deepEqual(groups.resonator.map(p => p.id), names.slice(7, 17).map((_, index) => `parameter-${index + 7}`));
  assert.deepEqual(groups.lfo.map(p => p.id), names.slice(17, 27).map((_, index) => `parameter-${index + 17}`));
  assert.deepEqual(groups.filter.map(p => p.id), ["parameter-27", "parameter-28"]);
  assert.deepEqual(groups.width.map(p => p.id), ["parameter-29", "parameter-36"]);
  assert.deepEqual(groups.midi.map(p => p.id), names.slice(30, 35).map((_, index) => `parameter-${index + 30}`));
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-35", "parameter-37", "parameter-38"]);
  assert.deepEqual(groups.other, []);
});

test("Dynamic Tube separates tube drive, envelope response, tone and output", () => {
  const profile = getFactoryDeviceProfile({ className: "Tube", name: "Renamed Saturator" });
  assert.equal(profile?.id, "dynamic-tube");
  const names = ["Device On", "Dry/Wet", "Drive", "Output", "Bias", "Envelope", "Attack", "Release", "Tone", "Tube Type"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.tube.map(p => p.id), ["parameter-2", "parameter-4", "parameter-9"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-5", "parameter-6", "parameter-7"]);
  assert.deepEqual(groups.tone.map(p => p.id), ["parameter-8"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-1", "parameter-3"]);
  assert.deepEqual(groups.other, []);
});

test("Envelope Follower preserves duplicate delay modes, detector and sidechain controls", () => {
  const profile = getFactoryDeviceProfile({ className: "MxDeviceAudioEffect", name: "Envelope Follower" });
  assert.equal(profile?.id, "envelope-follower");
  const names = ["Device On", "Delay", "Delay", "Fall", "Gain", "Mix", "Rise", "External SC", "Delay Mode"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.timing.map(p => p.id), ["parameter-1", "parameter-2", "parameter-8"]);
  assert.deepEqual(groups.envelope.map(p => p.id), ["parameter-3", "parameter-4", "parameter-6"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.sidechain.map(p => p.id), ["parameter-7"]);
  assert.deepEqual(groups.other, []);
});

test("Erosion separates noise excitation, spectral focus and stereo width", () => {
  const profile = getFactoryDeviceProfile({ className: "Erosion2", name: "Renamed Texture" });
  assert.equal(profile?.id, "erosion");
  const names = ["Device On", "Amount", "Frequency", "Filter Width", "Noise Blend", "Stereo Width"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.texture.map(p => p.id), ["parameter-1", "parameter-4"]);
  assert.deepEqual(groups.filter.map(p => p.id), ["parameter-2", "parameter-3"]);
  assert.deepEqual(groups.stereo.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.other, []);
});

test("External Audio Effect preserves its complete exposed gain and blend surface", () => {
  const profile = getFactoryDeviceProfile({ className: "ProxyAudioEffectDevice", name: "Renamed Hardware Loop" });
  assert.equal(profile?.id, "external-audio-effect");
  const names = ["Device On", "Dry/Wet", "Output Gain", "Input Gain"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.input.map(p => p.id), ["parameter-3"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-1", "parameter-2"]);
  assert.deepEqual(groups.other, []);
});

test("Filter Delay preserves three complete independent tap strips", () => {
  const profile = getFactoryDeviceProfile({ className: "FilterDelay", name: "Renamed Multi Tap" });
  assert.equal(profile?.id, "filter-delay");
  const strip = (n) => [`${n} Input On`, `${n} Filter On`, `${n} Filter Freq`, `${n} Filter Width`, `${n} Delay Mode`, `${n} Beat Delay`, `${n} Beat Swing`, `${n} Time Delay`, `${n} Feedback`, `${n} Pan`, `${n} Volume`];
  const names = ["Device On", ...strip(1), ...strip(2), ...strip(3), "Dry"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.tap1.map(p => p.id), names.slice(1, 12).map((_, index) => `parameter-${index + 1}`));
  assert.deepEqual(groups.tap2.map(p => p.id), names.slice(12, 23).map((_, index) => `parameter-${index + 12}`));
  assert.deepEqual(groups.tap3.map(p => p.id), names.slice(23, 34).map((_, index) => `parameter-${index + 23}`));
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-34"]);
  assert.deepEqual(groups.other, []);
});

test("Grain Delay separates grain generation, pitch, feedback, timing and blend", () => {
  const profile = getFactoryDeviceProfile({ className: "GrainDelay", name: "Renamed Granulator" });
  assert.equal(profile?.id, "grain-delay");
  const names = ["Device On", "Spray", "Frequency", "Pitch", "Random", "Feedback", "DryWet", "Delay Mode", "Beat Delay", "Beat Swing", "Time Delay"];
  const groups = groupDeviceParameters(profile, names.map((name, index) => ({ id: `parameter-${index}`, name, originalName: name })));
  assert.deepEqual(groups.global.map(p => p.id), ["parameter-0"]);
  assert.deepEqual(groups.grain.map(p => p.id), ["parameter-1", "parameter-2", "parameter-4"]);
  assert.deepEqual(groups.pitch.map(p => p.id), ["parameter-3"]);
  assert.deepEqual(groups.feedback.map(p => p.id), ["parameter-5"]);
  assert.deepEqual(groups.output.map(p => p.id), ["parameter-6"]);
  assert.deepEqual(groups.timing.map(p => p.id), ["parameter-7", "parameter-8", "parameter-9", "parameter-10"]);
  assert.deepEqual(groups.other, []);
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
