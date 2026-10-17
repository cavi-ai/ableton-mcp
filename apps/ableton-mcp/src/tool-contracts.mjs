import { listLiveScaleReferences } from "./live-scale-reference.mjs";
import { extensibleToolResult, toolOutputContracts } from "./tool-output-contracts.mjs";
import { LIVE_BROWSER_ROOTS } from "./browser-roots.mjs";
import { listPrompts } from "./prompts.mjs";
import { producerToolContracts } from "./producer-contracts.mjs";

const string = (description) => ({ type: "string", description });
const number = (description, extra = {}) => ({ type: "number", description, ...extra });
const boolean = (description) => ({ type: "boolean", description });
const array = (items, description) => ({ type: "array", items, description });
const object = (properties = {}, required = []) => ({ type: "object", properties,
  ...(required.length ? { required } : {}), additionalProperties: false });

const ids = {
  trackId: string("ID from list_tracks."),
  deviceOwnerId: string("track-N from list_tracks, return-N from get_set_mixer, or master."),
  sceneId: string("ID from list_scenes."),
  clipId: string("Session ID from list_clips; Arrangement ID from list_arrangement_clips where supported."),
  deviceId: string("ID from list_devices."),
  parameterId: string("ID from list_device_parameters."),
  presetId: string("NKS catalog preset ID."),
};
const confirmation = {
  expectedStateVersion: { type: "integer", minimum: 1, description: "Observed stateVersion." },
  dryRun: boolean("False executes with token and hash."),
  confirmationToken: string("Single-use plan token."),
  planHash: string("Plan hash."),
};
const guarded = (properties = {}, required = []) => object(
  { ...properties, ...confirmation }, ["expectedStateVersion", ...required]
);
const metadataGuarded = (properties = {}, required = []) => object({
  ...properties,
  expectedMetadataRevision: { type: "integer", minimum: 0, description: "Exact preset metadata revision observed immediately before planning." },
  dryRun: confirmation.dryRun, confirmationToken: confirmation.confirmationToken, planHash: confirmation.planHash,
}, ["expectedMetadataRevision", ...required]);
const choice = (description) => ({ oneOf: [{ type: "integer" }, { type: "string" }], description });
const empty = object();
const track = object({ trackId: ids.trackId }, ["trackId"]);
const clip = object({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]);
const feelOrigin = number("Clip-beat cycle origin; defaults to zero. Use an observed loop start when intended.", {minimum: 0});
const feelSourceNoteIds = {...array({type: "integer"}, "Exact source note IDs; omitted means all stored notes."), minItems: 1, maxItems: 4096, uniqueItems: true};
const midiFeelTemplate = object({
  format: { const: "cavi-midi-feel-v1" },
  grid: { type: "string", enum: ["straight16", "eighthTriplet", "sixteenthTriplet"] },
  bars: { type: "integer", minimum: 1, maximum: 8 },
  barBeats: number("Quarter-note beats per source bar.", { exclusiveMinimum: 0 }),
  nativeGrooveId: { type: "null", description: "Only stored-note templates without an assigned native groove are transferable." },
  source: object({ trackId: ids.trackId, clipId: ids.clipId,
    stateVersion: { type: "integer", minimum: 1 }, originBeats: feelOrigin, noteIds: feelSourceNoteIds }, ["trackId", "clipId", "stateVersion"]),
  slots: { ...array(object({ slot: { type: "integer", minimum: 0 }, hitCount: { type: "integer", minimum: 1 },
    meanOffsetBeats: number("Mean stored-note deviation from this grid slot."),
    meanVelocity: number("Mean stored-note velocity.", { minimum: 1, maximum: 127 }) },
  ["slot", "hitCount", "meanOffsetBeats", "meanVelocity"]), "Nonempty measured slots from analyze_midi_feel."),
    minItems: 1, maxItems: 4096 }
}, ["format", "grid", "bars", "barBeats", "nativeGrooveId", "source", "slots"]);
const audioFeelTemplate = object({
  format: { const: "cavi-audio-feel-v1" },
  gridBeats: number("Measured source-audio grid spacing in quarter-note beats.", { exclusiveMinimum: 0, maximum: 16 }),
  bars: { type: "integer", minimum: 1, maximum: 8 },
  barBeats: number("Quarter-note beats per source bar.", { exclusiveMinimum: 0 }),
  cycleBeats: number("Measured cycle length in quarter-note beats.", { exclusiveMinimum: 0 }),
  slotCount: { type: "integer", minimum: 1, maximum: 4096 },
  nativeGrooveId: { type: "null" },
  source: object({ trackId: ids.trackId, clipId: ids.clipId,
    stateVersion: { type: "integer", minimum: 1 }, sourcePath: string("Measured local audio source path.") },
  ["trackId", "clipId", "stateVersion", "sourcePath"]),
  slots: { ...array(object({ slot: { type: "integer", minimum: 0 },
    hitCount: { type: "integer", minimum: 1 }, reliableTimingHits: { type: "integer", minimum: 0 },
    meanOffsetBeats: { type: ["number", "null"] },
    meanStrength: number("Measured source onset strength; not MIDI velocity.", { minimum: 0, maximum: 1 }) },
  ["slot", "hitCount", "reliableTimingHits", "meanOffsetBeats", "meanStrength"]),
  "Nonempty measured source-audio feel slots."), minItems: 1, maxItems: 4096 },
  limitation: string("Measurement boundary and source-audio limitations.")
}, ["format", "gridBeats", "bars", "barBeats", "nativeGrooveId", "source", "slots"]);
const device = object({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId }, ["trackId", "deviceId"]);
const snapshotParameter = object({ originalName: string("Native parameter identity in index order."),
  min: number("Native minimum."), max: number("Native maximum."), quantized: boolean("Native quantization."),
  valueItems: array(string("Native value label."), "Exact ordered choice labels."), value: number("Captured native value.")
}, ["originalName", "min", "max", "quantized", "valueItems", "value"]);
const parameterSnapshot = object({
  format: { const: "cavi-device-parameters-v1" }, deviceClass: string("Exact native device class."),
  parameters: array(snapshotParameter, "Complete ordered parameter layout and values.")
}, ["format", "deviceClass", "parameters"]);
const legacyDeviceChainSnapshot = object({
  format: { const: "cavi-device-chain-v1" },
  devices: array(object({ name: string("Captured device name."), className: string("Exact native device class."), type: string("Native device type."),
    parameters: array(snapshotParameter, "Complete ordered exposed parameter layout and values.")
  }, ["name", "className", "type", "parameters"]), "Ordered top-level device topology.")
}, ["format", "devices"]);
const nestedDeviceChainSnapshot = {
  ...object({ format: { const: "cavi-device-chain-v2" },
    devices: array({ $ref: "#/properties/snapshot/oneOf/1/$defs/device" }, "Ordered devices including nested rack chains.") }, ["format", "devices"]),
  $defs: {
    device: object({ name: string("Captured device name."), className: string("Exact native device class."),
      type: string("Native device type."), parameters: array(snapshotParameter, "Complete exposed parameter layout and values."),
      chains: array({ $ref: "#/properties/snapshot/oneOf/1/$defs/chain" }, "Rack chains in native order."),
      returnChains: array({ $ref: "#/properties/snapshot/oneOf/1/$defs/chain" }, "Rack return chains in native order.") },
    ["name", "className", "type", "parameters"]),
    chain: object({ name: string("Captured chain name."),
      devices: array({ $ref: "#/properties/snapshot/oneOf/1/$defs/device" }, "Nested devices in native order.") }, ["name", "devices"]),
  },
};
function rackControlSnapshot(version, index, includePads = false) {
  const ref = `#/properties/snapshot/oneOf/${index}/$defs`;
  return {
  ...object({ format: { const: `cavi-device-chain-v${version}` },
    devices: array({ $ref: `${ref}/device` }, "Ordered devices including rack controls.") }, ["format", "devices"]),
  $defs: {
    device: object({ name: string("Captured device name."), className: string("Exact native device class."),
      type: string("Native device type."), parameters: array(snapshotParameter, "Complete exposed parameter layout and values."),
      chains: array({ $ref: `${ref}/chain` }, "Rack chains in native order."),
      returnChains: array({ $ref: `${ref}/chain` }, "Rack return chains in native order."),
      ...(includePads ? { drumPads: array(object({ note: { type: "integer", minimum: 0, maximum: 127 },
        mute: boolean("Captured pad mute."), solo: boolean("Captured pad solo.") }, ["note", "mute", "solo"]),
      "Populated Drum Rack pads in native order.") } : {}) },
    ["name", "className", "type", "parameters"]),
    chain: object({ name: string("Captured chain name."),
      mixer: object({ volume: { type: ["number", "null"] }, pan: { type: ["number", "null"] },
        sends: array(number("Ordered native send level."), "Ordered rack-chain sends."),
        mute: { type: ["boolean", "null"] }, solo: { type: ["boolean", "null"] } },
      ["volume", "pan", "sends", "mute", "solo"]),
      noteRouting: object({ inputNote: { type: ["integer", "null"], minimum: 0, maximum: 127 },
        outputNote: { type: ["integer", "null"], minimum: 0, maximum: 127 } }, ["inputNote", "outputNote"]),
      devices: array({ $ref: `${ref}/device` }, "Nested devices in native order.") },
    ["name", "mixer", "noteRouting", "devices"]),
  },
  };
}
const controlledDeviceChainSnapshot = rackControlSnapshot(3, 2);
const padDeviceChainSnapshot = rackControlSnapshot(4, 3, true);
const returnDeviceChainSnapshot = rackControlSnapshot(5, 4, true);
returnDeviceChainSnapshot.properties.ownerMixer = object({ volume: number("Return bus volume."), pan: number("Return bus pan."),
  mute: boolean("Return bus mute."), solo: boolean("Return bus solo.") }, ["volume", "pan", "mute", "solo"]);
returnDeviceChainSnapshot.required.push("ownerMixer");
const masterDeviceChainSnapshot = rackControlSnapshot(6, 5, true);
masterDeviceChainSnapshot.properties.ownerMixer = object({ volume: number("Master volume."), pan: number("Master pan."),
  cueVolume: number("Cue volume."), crossfader: number("Crossfader."),
  outputChannelId: { type: ["string", "null"], description: "Exact available master hardware output channel ID, or null if unsupported." }
}, ["volume", "pan", "cueVolume", "crossfader", "outputChannelId"]);
masterDeviceChainSnapshot.required.push("ownerMixer");
const deviceChainSnapshot = { oneOf: [legacyDeviceChainSnapshot, nestedDeviceChainSnapshot, controlledDeviceChainSnapshot, padDeviceChainSnapshot, returnDeviceChainSnapshot, masterDeviceChainSnapshot] };
const drumLane = object({
  role: string("Producer-facing lane role such as kick, snare, closed_hat, or percussion."),
  note: { type: "integer", minimum: 0, maximum: 127, description: "Exact MIDI note for this drum lane." },
  activeSteps: { ...array({ type: "integer", minimum: 1, maximum: 4096 }, "Unique one-based active steps within each bar."), minItems: 1, maxItems: 4096 },
  velocity: { type: "integer", minimum: 1, maximum: 127 },
  accentSteps: { ...array({ type: "integer", minimum: 1, maximum: 4096 }, "Optional active steps played at accentVelocity."), maxItems: 4096 },
  accentVelocity: { type: "integer", minimum: 1, maximum: 127 },
  gate: number("Note duration as a fraction of one selected grid step.", { exclusiveMinimum: 0, maximum: 1 })
}, ["role", "note", "activeSteps", "velocity", "gate"]);
const drumEditLane = object({ ...drumLane.properties,
  activeSteps: { ...drumLane.properties.activeSteps, minItems: 0 }
}, drumLane.required);
const drumPatternProperties = {
  grid: { type: "string", enum: ["straight16", "eighthTriplet", "sixteenthTriplet"] },
  bars: { type: "integer", minimum: 1, maximum: 16 },
  startBeat: number("Absolute clip beat offset; defaults to zero.", { minimum: 0 }),
  lanes: { ...array(drumLane, "Explicit drum lanes and their per-bar steps."), minItems: 1, maxItems: 128 }
};
const drumVariationProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  grid: drumPatternProperties.grid,
  startBar: { type: "integer", minimum: 0, maximum: 4095 },
  bars: drumPatternProperties.bars,
  laneNotes: { ...array({ type: "integer", minimum: 0, maximum: 127 }, "Unique drum pitches to humanize."), minItems: 1, maxItems: 128 },
  seed: { type: "integer", minimum: 0, maximum: 4294967295, description: "Deterministic variation seed." },
  timingAmount: number("Maximum timing movement as a fraction of the selected grid step.", { minimum: 0, maximum: 0.49 }),
  velocityAmount: { type: "integer", minimum: 0, maximum: 32, description: "Maximum velocity movement." },
  preserveAccentsAbove: { type: "integer", minimum: 1, maximum: 127, description: "Required threshold; do not alter velocity at or above it." },
  fill: object({ note: { type: "integer", minimum: 0, maximum: 127 },
    grid: drumPatternProperties.grid,
    activeSteps: { ...array({ type: "integer", minimum: 1, maximum: 4096 }, "Unique fill steps in the final selected bar."), minItems: 1, maxItems: 4096 },
    velocity: { type: "integer", minimum: 1, maximum: 127 },
    gate: number("Fill duration as a fraction of its grid step.", { exclusiveMinimum: 0, maximum: 1 })
  }, ["note", "grid", "activeSteps", "velocity", "gate"])
};
const midiHumanizationProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs to humanize."), minItems: 1, maxItems: 4096 },
  seed: { type: "integer", minimum: 0, maximum: 4294967295, description: "Deterministic humanization seed." },
  gridBeats: number("Reference grid step in beats, including fractional triplet values.", { exclusiveMinimum: 0, maximum: 128 }),
  maxTimingOffsetBeats: number("Maximum absolute timing movement in beats; must not exceed half gridBeats.", { minimum: 0, maximum: 64 }),
  maxVelocityOffset: { type: "integer", minimum: 0, maximum: 126, description: "Maximum absolute velocity movement." },
};
const midiVelocityCurveProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete selected onsets."), minItems: 1, maxItems: 4096 },
  curve: { oneOf: [
    object({ type: { const: "crescendo" }, startVelocity: { type: "integer", minimum: 1, maximum: 127 }, endVelocity: { type: "integer", minimum: 1, maximum: 127 } }, ["type", "startVelocity", "endVelocity"]),
    object({ type: { const: "decrescendo" }, startVelocity: { type: "integer", minimum: 1, maximum: 127 }, endVelocity: { type: "integer", minimum: 1, maximum: 127 } }, ["type", "startVelocity", "endVelocity"]),
    object({ type: { const: "fixed" }, velocity: { type: "integer", minimum: 1, maximum: 127 } }, ["type", "velocity"]),
    object({ type: { const: "accent" }, velocities: { ...array({ type: "integer", minimum: 1, maximum: 127 }, "Repeating target velocities by ordered onset."), minItems: 1, maxItems: 128 } }, ["type", "velocities"]),
  ], description: "Exact crescendo, decrescendo, fixed, or repeating accent target." },
};
const midiGatePatternProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete selected onsets."), minItems: 1, maxItems: 4096 },
  gridBeats: number("Reference grid step in beats, including fractional triplet values.", { exclusiveMinimum: 0, maximum: 128 }),
  gateRatios: { ...array(number("Repeating note duration ratio relative to gridBeats.", { exclusiveMinimum: 0, maximum: 1 }), "Explicit repeating gate ratios by ordered onset."), minItems: 1, maxItems: 128 },
};
const midiProbabilityPatternProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete selected onsets."), minItems: 1, maxItems: 4096 },
  probabilities: { ...array(number("Repeating playback probability by ordered onset.", { minimum: 0, maximum: 1 }), "Explicit repeating probabilities from 0 to 1."), minItems: 1, maxItems: 128 },
};
const midiRatchetPatternProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete selected onsets."), minItems: 1, maxItems: 4096 },
  spanBeats: number("Total beat span occupied by every selected onset's repeats.", { exclusiveMinimum: 0, maximum: 128 }),
  repeatCounts: { ...array({ type: "integer", minimum: 1, maximum: 64 }, "Repeating ratchet count by ordered onset; 3 creates an exact triplet inside spanBeats."), minItems: 1, maxItems: 128 },
  gate: number("Each repeated note's duration as a fraction of its subdivision.", { exclusiveMinimum: 0, maximum: 1 }),
};
const midiStrumPatternProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete chord onsets."), minItems: 1, maxItems: 4096 },
  direction: { type: "string", enum: ["up", "down", "alternating"], description: "Pitch order for each chord; alternating starts upward and reverses on each following onset." },
  spreadBeats: number("Total beat distance from the first to last attack in each chord.", { exclusiveMinimum: 0, maximum: 4 }),
};
const midiChordInversionProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete chord onsets."), minItems: 1, maxItems: 4096 },
  direction: { type: "string", enum: ["up", "down"], description: "Rotate the lowest notes upward or highest notes downward by one octave." },
  steps: { type: "integer", minimum: 1, maximum: 127, description: "Number of chord tones to rotate at each selected onset." },
};
const midiDropVoicingProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete chord onsets."), minItems: 1, maxItems: 4096 },
  mode: { type: "string", enum: ["drop_2", "drop_3", "drop_2_and_4"], description: "Traditional upper-voice octave drop applied independently at each onset." },
};
const midiChordVoiceLeadingProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs across complete ordered chord onsets."), minItems: 1, maxItems: 4096 },
  mode: { type: "string", enum: ["all_voices", "preserve_bass"], description: "Lead every voice by octave or keep each chord's current bass fixed." },
  minPitch: { type: "integer", minimum: 0, maximum: 127 },
  maxPitch: { type: "integer", minimum: 0, maximum: 127 },
};
const midiChordDoublingProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete chord onsets."), minItems: 1, maxItems: 4096 },
  mode: { type: "string", enum: ["bass_octave_down", "top_octave_up", "outer_octaves"], description: "Add the lowest voice down an octave, highest voice up an octave, or both outer voices." },
};
const midiChordArpeggiationProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete chord onsets."), minItems: 1, maxItems: 4096 },
  mode: { type: "string", enum: ["up", "down", "up_down", "random"], description: "Pitch traversal order for each complete chord onset." },
  stepBeats: number("Spacing between arpeggiated notes in beats.", { exclusiveMinimum: 0 }),
  gate: number("Note duration as a fraction of stepBeats.", { exclusiveMinimum: 0, maximum: 1 }),
  seed: { type: "integer", minimum: 0, maximum: 2147483647, description: "Deterministic seed used by random mode." },
};
const midiTranspositionProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs to transpose."), minItems: 1, maxItems: 4096, uniqueItems: true },
  semitones: { type: "integer", minimum: -127, maximum: 127, not: { const: 0 }, description: "Signed non-zero chromatic transposition in semitones." },
};
const midiDiatonicTranspositionProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable in-scale note IDs to transpose."), minItems: 1, maxItems: 4096, uniqueItems: true },
  scaleSteps: { type: "integer", minimum: -127, maximum: 127, not: { const: 0 }, description: "Signed non-zero movement in degrees of Live's current scale." },
};
const midiDiatonicHarmonyProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable in-scale source note IDs."), minItems: 1, maxItems: 4096, uniqueItems: true },
  degreeOffsets: { ...array({ type: "integer", minimum: -127, maximum: 127, not: { const: 0 } }, "Unique signed non-zero scale-degree offsets for added harmony voices."), minItems: 1, maxItems: 16, uniqueItems: true },
};
const midiScaleChordRemappingProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete chord onsets."), minItems: 1, maxItems: 4096, uniqueItems: true },
  targetDegrees: { ...array({ type: "integer", minimum: 1, maximum: 12 }, "One target Live scale degree for each ordered chord onset."), minItems: 1, maxItems: 4096 },
  mode: { type: "string", enum: ["preserve_register", "voice_leading"], description: "Anchor each chord near its source register or each later chord near the previous remapped bass." },
};
const chordRecipe = { type: "string", description: "Exact voicing recipe. Triad, seventh, and ninth stack thirds from Live's scale; suspended, added-tone, and dominant recipes use their named literal intervals, with tensions voiced above the chord.",
  enum: ["triad", "seventh", "ninth", "sus2", "sus4", "add6", "add9", "dominant7", "dominant9",
    "dominant7_b9", "dominant7_sharp9", "dominant7_sharp11", "dominant7_b13", "dominant13"] };
const progressionChordRecipe = { type: "string", enum: ["triad", "seventh", "ninth", "dominant7", "dominant9",
  "dominant7_b9", "dominant7_sharp9", "dominant7_sharp11", "dominant7_b13", "dominant13"] };
const functionalProgressionProperties = {
  chordRecipes: { ...array(progressionChordRecipe, "Optional exact recipe for each ordered degree."), minItems: 1, maxItems: 64 },
  harmonicFunctions: { ...array({ type: "string", enum: ["diatonic", "secondary_dominant", "borrowed_parallel_minor"] },
    "Optional harmonic function for each ordered degree; secondary-dominant degrees name tonicized targets."), minItems: 1, maxItems: 64 },
  bassDegrees: { ...array({ type: ["integer", "null"], minimum: 1, maximum: 12 },
    "Optional Live scale degree for an added bass voice below each ordered chord; null leaves that chord unchanged."), minItems: 1, maxItems: 64 }
};
const midiDiatonicChordQualityProperties = {
  trackId: ids.trackId, clipId: ids.clipId,
  noteIds: { ...array({ type: "integer", minimum: 0 }, "Unique stable note IDs at complete chord onsets."), minItems: 1, maxItems: 4096, uniqueItems: true },
  rootDegrees: { ...array({ type: "integer", minimum: 1, maximum: 12 }, "One root degree from Live's current scale for each ordered onset."), minItems: 1, maxItems: 4096 },
  chordSize: chordRecipe,
  chordSizes: { ...array(chordRecipe, "One exact voicing recipe for each ordered onset."), minItems: 1, maxItems: 4096 },
  inversions: { ...array({ type: "integer", minimum: 0, maximum: 12 }, "Optional inversion steps for each ordered onset; zero keeps root position."), minItems: 1, maxItems: 4096 },
  voicingModes: { ...array({ type: "string", enum: ["close", "open", "drop2", "drop3"] }, "Optional deterministic voicing mode for each ordered onset."), minItems: 1, maxItems: 4096 },
  bassDegrees: { ...array({ type: "integer", minimum: 1, maximum: 12 }, "Optional Live scale degree for one added slash-bass voice below each ordered onset."), minItems: 1, maxItems: 4096 },
  harmonicFunctions: { ...array({ type: "string", enum: ["diatonic", "secondary_dominant", "borrowed_parallel_minor"] }, "Optional harmonic function for each ordered onset; secondary-dominant root degrees name tonicized targets."), minItems: 1, maxItems: 4096 },
  mode: { type: "string", enum: ["preserve_register", "voice_leading"] },
};
const midiDiatonicChordQualityInput = (guardedMutation = false) => {
  const required = ["trackId", "clipId", "noteIds", "rootDegrees", "mode"];
  const schema = guardedMutation ? guarded(midiDiatonicChordQualityProperties, required) :
    object(midiDiatonicChordQualityProperties, required);
  schema.oneOf = [
    { properties: { chordSize: {}, chordSizes: false }, required: ["chordSize"] },
    { properties: { chordSize: false, chordSizes: {} }, required: ["chordSizes"] },
  ];
  return schema;
};
const melodyEvent = object({
  step: { type: "integer", minimum: 0, maximum: 4095, description: "Unique zero-based grid step within the motif." },
  degree: { type: "integer", minimum: 1, maximum: 9, description: "One-based Live scale degree." },
  octaveOffset: { type: "integer", minimum: -4, maximum: 4, description: "Optional octave displacement from basePitch." },
  velocity: { type: "integer", minimum: 1, maximum: 127, description: "Optional event accent velocity." }
}, ["step", "degree"]);
const scaleMelodyProperties = {
  grid: drumPatternProperties.grid,
  motifBars: { type: "integer", minimum: 1, maximum: 16 },
  repeats: { type: "integer", minimum: 1, maximum: 16 },
  events: { ...array(melodyEvent, "Explicit scale-degree events; omitted grid steps are rests."), minItems: 1, maxItems: 4096 },
  gate: number("Note duration as a fraction of one selected grid step.", { exclusiveMinimum: 0, maximum: 1 }),
  velocity: { type: "integer", minimum: 1, maximum: 127, description: "Default note velocity." },
  basePitch: { type: "integer", minimum: 0, maximum: 127, description: "MIDI pitch for scale degree one." },
  minPitch: { type: "integer", minimum: 0, maximum: 127 },
  maxPitch: { type: "integer", minimum: 0, maximum: 127 }
};
const legacyTrackStateSnapshot = object({
  format: { const: "cavi-track-state-v1" },
  track: object({ name: string("Captured track name."), type: { type: "string", enum: ["midi", "audio", "group", "unknown"] }, isGroup: boolean("Captured Group Track state."),
    isGrouped: boolean("Captured child-group membership; absent in older snapshots."),
    groupTrackId: { type: ["string", "null"], description: "Captured parent Group Track ID; absent in older snapshots." } }, ["name", "type", "isGroup"]),
  mixer: object({ volume: number("Captured volume."), pan: number("Captured pan."), mute: boolean("Captured mute."), solo: boolean("Captured solo."),
    sends: array(object({ id: string("Stable return ID."), name: string("Captured return name."), value: number("Captured send value.") }, ["id", "name", "value"]), "Ordered named sends.")
  }, ["volume", "pan", "mute", "solo", "sends"]),
  routing: object({ inputTypeId: { type: ["string", "null"] }, inputChannelId: { type: ["string", "null"] },
    outputTypeId: { type: ["string", "null"] }, outputChannelId: { type: ["string", "null"] }, monitoring: { type: ["integer", "null"] }
  }, ["inputTypeId", "inputChannelId", "outputTypeId", "outputChannelId", "monitoring"]),
  devices: array(object({ name: string("Captured device name."), className: string("Exact native device class."), type: string("Native device type."),
    parameters: array(snapshotParameter, "Complete ordered exposed parameter layout and values.")
  }, ["name", "className", "type", "parameters"]), "Ordered top-level device topology.")
}, ["format", "track", "mixer", "routing", "devices"]);
const nestedTrackStateSnapshot = {
  ...legacyTrackStateSnapshot,
  properties: { ...legacyTrackStateSnapshot.properties,
    format: { const: "cavi-track-state-v2" },
    devices: array({ $ref: "#/properties/snapshot/oneOf/1/$defs/device" }, "Ordered devices including nested rack chains.") },
  $defs: {
    device: object({ name: string("Captured device name."), className: string("Exact native device class."),
      type: string("Native device type."), parameters: array(snapshotParameter, "Complete exposed parameter layout and values."),
      chains: array({ $ref: "#/properties/snapshot/oneOf/1/$defs/chain" }, "Rack chains in native order."),
      returnChains: array({ $ref: "#/properties/snapshot/oneOf/1/$defs/chain" }, "Rack return chains in native order.") },
    ["name", "className", "type", "parameters"]),
    chain: object({ name: string("Captured chain name."),
      devices: array({ $ref: "#/properties/snapshot/oneOf/1/$defs/device" }, "Nested devices in native order.") }, ["name", "devices"]),
  },
};
const controlledTrackStateSnapshot = {
  ...legacyTrackStateSnapshot,
  properties: { ...legacyTrackStateSnapshot.properties,
    format: { const: "cavi-track-state-v3" },
    devices: array({ $ref: "#/properties/snapshot/oneOf/2/$defs/device" }, "Ordered devices including rack controls.") },
  $defs: controlledDeviceChainSnapshot.$defs,
};
const padTrackStateSnapshot = {
  ...legacyTrackStateSnapshot,
  properties: { ...legacyTrackStateSnapshot.properties,
    format: { const: "cavi-track-state-v4" },
    devices: array({ $ref: "#/properties/snapshot/oneOf/3/$defs/device" }, "Ordered devices including Drum Rack pad state.") },
  $defs: padDeviceChainSnapshot.$defs,
};
const trackStateSnapshot = { oneOf: [legacyTrackStateSnapshot, nestedTrackStateSnapshot, controlledTrackStateSnapshot, padTrackStateSnapshot] };

const note = object({
  pitch: { type: "integer", minimum: 0, maximum: 127 }, start: number("Start in beats.", { minimum: 0 }),
  duration: number("Duration in beats.", { exclusiveMinimum: 0 }), velocity: { type: "integer", minimum: 1, maximum: 127 },
  mute: boolean("Whether the note is muted."),
}, ["pitch", "start", "duration", "velocity"]);
const envelopePoint = object({
  time: number("Step start in beats.", { minimum: 0 }), duration: number("Step duration in beats.", { exclusiveMinimum: 0 }),
  value: number("Requested parameter value; the service clamps to live bounds."),
}, ["time", "duration", "value"]);
const creationEnvelopePoint = {oneOf:[
  object({time:number("Absolute clip beat position.",{minimum:0}),duration:number("Step duration in beats.",{exclusiveMinimum:0}),value:number("Exact native value within observed bounds; quantized controls require an integer choice. No clamping.")},["time","duration","value"]),
  object({time:number("Absolute clip beat position.",{minimum:0}),duration:number("Step duration in beats.",{exclusiveMinimum:0}),targetDisplay:string("Continuous control target in Hz/kHz, ms/s, dB or %, such as 2 kHz. Decimal point only.")},["time","duration","targetDisplay"])
]};
const mixerEnvelopeTarget={trackId:ids.trackId,clipId:ids.clipId,
  mixerControl:{type:'string',enum:['volume','pan','send'],description:'Track fader, Stereo pan or exact track-to-Return send. Pan refuses Split Stereo or unknown modes.'},
  sendId:string('Required for send; exact ID from get_track_mixer. Omit for volume or pan.'),
  returnTrackId:string('Required for send; matching Return ID from get_track_mixer. Omit for volume or pan.')};
const mixerEnvelopePoint={oneOf:creationEnvelopePoint.oneOf.map(schema=>({...schema,properties:{...schema.properties,
  ...('value' in schema.properties?{value:number('Exact raw native value within observed bounds; no clamping. Stereo pan: -1 left, 0 center, +1 right.')}:
    {targetDisplay:string('Volume/send only: finite native dB target, such as -24 dB or -6 dB. Pan requires value. Decimal point only; -inf is not accepted.')})}}))};

const contracts = {
  get_selected_parameter_context: {description:'Resolve Live’s selected native device or track/Return/Main mixer parameter without changing focus. Includes exact target IDs, control bounds/display/automation and selection token. None, unavailable and unresolved are distinct; chain mixers and hidden controls are unresolved. All profile.',inputSchema:empty},
  set_selected_parameter: {description:'Edit the exact currently selected native control at one absolute value or finite unit display. Requires fresh selection token and unchanged identity/value/context; rejects active/unknown automation, recording/count-in and unsafe owners. Preserves focus/playback; partial work retained without rollback/replay. All profile.',inputSchema:{...guarded({expectedSelectionToken:{type:'string',minLength:1,maxLength:128},value:number('Exact native absolute value within observed bounds; quantized controls require an integer.'),targetDisplay:string('Continuous control target in finite Hz/kHz, ms/s, dB or %; decimal point only.')},['expectedSelectionToken']),oneOf:[{required:['value'],properties:{value:{}}},{required:['targetDisplay'],properties:{targetDisplay:{}}}]}},
  get_browser_preview_context: {description:'Read native browser preview/stop availability and optional exact item with document/selection guards. Does not observe active preview, route, duration or audible output. No input or loading; all profile.',inputSchema:{...object({root:string('Observed Live browser root.'),path:{type:'array',minItems:1,maxItems:32,items:{type:'string',minLength:1,maxLength:256}}}),dependencies:{root:['path'],path:['root']}}},
  set_browser_preview: {description:'Request start for an exact native browser item, or global stop. Can replace or stop a user preview. Guarded single native call; no loading, transport edits, ownership, active-state or audible verification. Start requires recording/count-in off. No automatic cleanup or replay. Updated bridge; all profile.',inputSchema:{...guarded({action:{type:'string',enum:['start','stop']},root:string('Exact browser root for start only.'),path:{type:'array',minItems:1,maxItems:32,items:{type:'string',minLength:1,maxLength:256}}},['action']),oneOf:[{properties:{action:{const:'start'},root:{},path:{}},required:['root','path']},{properties:{action:{const:'stop'},root:false,path:false}}]}},
  override_parameter_automation: {description:'Explicitly take one exact active or overridden device/mixer automation control into manual control at one absolute native value or finite unit display. Keeps the envelope and playback. Active automation may advance before confirmation; manual values and native ancestry remain bound. Recording/count-in and unsafe targets refuse. One write with bounded readback; partial work remains without rollback/replay. All profile.',inputSchema:{...guarded({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,parameterId:string('Exact ID from get_parameter_automation_context; omit deviceId for mixer controls.'),value:number('Absolute raw native target within observed bounds; quantized controls require an integer. No clamping.'),targetDisplay:string('Continuous controls only: finite native display in Hz/kHz, ms/s, dB or %. Choose value for other native display formats.')},['trackId','parameterId']),oneOf:[{required:['value'],properties:{value:{}}},{required:['targetDisplay'],properties:{targetDisplay:{}}}]}},
  get_parameter_automation_context: {description:'Read discoverable device parameters or mixer controls and native automation handoff support on an exact track, Group, Return or Main. Omit parameterId to list, supply one observed ID for a target read. Unsupported controls remain explicit. Read-only; all profile.',inputSchema:object({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,parameterId:string('Observed parameter-N for a device, or a mixer control ID from this read. Omit deviceId for mixer controls.')},['trackId'])},
  re_enable_parameter_automation: {description:'Hand one exact overridden device or mixer control back to native automation. Binds native owner/device/control identities and current manual value. Requires supported enabled control, unfrozen target and recording/count-in off; preserves playback. Values may jump. Reports active automation separately from requested handoff. Partial work remains; no rollback or replay. All profile.',inputSchema:guarded({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,parameterId:string('Exact control ID returned by get_parameter_automation_context; omit deviceId for mixer controls.')},['trackId','parameterId'])},
  get_mixer_panning_context: {description:'Read exact track, Group, Return or Main panning mode and Stereo/left/right native values, displays, bounds, enablement and automation. Binds native owner/mixer/parameter identities. Read-only; unsupported fields explicit. All profile.',inputSchema:object({trackId:ids.deviceOwnerId},['trackId'])},
  set_mixer_panning: {description:'Change one mixer panning mode or its active Stereo balance / Split Stereo channel positions in separate confirmations. Recording/count-in off, unfrozen target, known inactive affected automation and native identities required. Immediate edits; partial work retained without rollback/replay. No timed sweep or audible image claim. Updated bridge; all profile.',inputSchema:{...guarded({trackId:ids.deviceOwnerId,mode:{type:'string',enum:['stereo','splitStereo']},pan:number('Native Stereo balance; -1 left, 0 center, +1 right. No clamping.',{minimum:-1,maximum:1}),left:number('Split Stereo left input channel position.',{minimum:-1,maximum:1}),right:number('Split Stereo right input channel position.',{minimum:-1,maximum:1})},['trackId']),oneOf:[{required:['mode'],properties:{mode:{},pan:false,left:false,right:false}},{required:['pan'],properties:{pan:{},mode:false,left:false,right:false}},{properties:{mode:false,pan:false},anyOf:[{required:['left'],properties:{left:{}}},{required:['right'],properties:{right:{}}}]}]}},
  get_crossfader_context: {description:'Read Main crossfader value, native bounds, availability and automation plus every ordinary/Group/Return A/B assignment and Group relationship. Unsupported fields remain explicit. No playback, selection or mixer changes; all profile.',inputSchema:empty},
  set_crossfader_state: {description:'Change either 1-64 exact track/Group/Return A/B assignments or the Main crossfader position in separate confirmations. Binds all native mixer identities and bus membership; requires recording/count-in off and known inactive Main automation. Position affects all assigned members. Immediate requests, not a timed fade or atomic audio transition. Partial work retained; no rollback/replay. Updated bridge; all profile.',inputSchema:{...guarded({assignments:{type:'array',minItems:1,maxItems:64,items:object({trackId:ids.deviceOwnerId,side:{type:'string',enum:['A','none','B']}},['trackId','side'])},position:number('Native Main crossfader position; -1 left, 0 center, +1 right. No clamping.',{minimum:-1,maximum:1})}),oneOf:[{required:['assignments'],properties:{assignments:{}}},{required:['position'],properties:{position:{}}}]}},
  return_tracks_to_arrangement: {description:'Return explicit ordinary tracks from Session override while preserving global playback and loop settings, without seeking. May stop their Session clips and reveal Arrangement material or silence. Refuses Groups, recording, armed/frozen targets, pending target launches and unresolved holds. Native identity guards; partial results retained. Immediate, not beat-scheduled or audible proof. Updated bridge; all profile.', inputSchema:guarded({trackIds:{...array(ids.trackId,'Exact ordinary tracks to return; other overrides remain.'),minItems:1,maxItems:64,uniqueItems:true}},['trackIds'])},
  hold_session_clip: {description:'Hold one existing Gate/Repeat Session clip for 0.25–8 wall-clock seconds, then request native release without this client. Requires global playback, recording off, an unarmed/unfrozen target and no pending launches or other playing Session clip on its track. Honors quantization; may override target Arrangement. Gate may stop on release; Repeat may continue. Concurrent controller input cannot be distinguished. Command receipts are not button-state or audible proof. All profile.',inputSchema:guarded({trackId:ids.trackId,clipId:ids.clipId,durationSeconds:number('Wall-clock hold duration checked on Live display ticks; not beat scheduling.',{minimum:.25,maximum:8}),allowPlaying:boolean('Explicitly allow the exact target to be already playing; defaults to false.')},['trackId','clipId','durationSeconds'])},
  get_session_clip_hold: {description:'Read one retained Session clip hold, or list holds after a lost response. Reports press/release command receipts, current native clip IDs, playback snapshots and cleanup errors. No input or playback changes. Runtime state may disappear after reload; missing handles do not prove release. All profile.',inputSchema:object({holdId:string('Retained hold ID; omit to list.')})},
  finish_session_clip_hold: {description:'Release a terminal Session hold handle, or cancel:true to request early release of its retained native clip. Does not globally stop playback or stop a continuing Repeat clip. A failed release retains its handle and track reservation until an explicit cancel retry succeeds. Updated bridge; all profile.',inputSchema:guarded({holdId:string('Exact retained hold ID.'),cancel:boolean('Request early release, or retry a failed release; defaults to false.')},['holdId'])},
  ungroup_tracks:{description:'Remove one native Group through macOS English Live UI, promoting its children to the enclosing Group or root. Removes its processing/mixer stage, shifts IDs and numbered labels, and can change sound/routing. Saved Set, stopped transport/recording, unarmed/unfrozen descendants and visible Group required. Refuses exposed external dependencies. Group devices require allowContent. Verifies retained descendants and exposed controls. No automatic undo/regrouping. Retain ungroupingId before execution. All profile.',inputSchema:guarded({groupTrackId:ids.trackId,allowContent:boolean('Allow discarding the Group device chain; does not preserve hidden plug-in state.'),expectedSetFingerprint:string('Current Set fingerprint.')},['groupTrackId','expectedSetFingerprint'])},
  get_track_ungrouping_status:{description:'Inspect actual removal, retained descendants, membership, exposed material and routing for a retained ungroupingId, including after a lost reply. Read-only; never repeats removal or regroups. Runtime handles can expire or disappear after bridge reload. Missing handles require current-track inspection. All profile.',inputSchema:object({ungroupingId:string('Retained ungroupingId from the plan or result.')},['ungroupingId'])},
  group_tracks:{description:'Create a native Group through macOS English Live UI from two to 64 consecutive ungrouped ordinary audio-producing tracks feeding Main. Saved Set, stopped playback/recording, unarmed/unfrozen sources and no pending launches required. Changes focus, hierarchy, routing and track IDs. Verifies retained objects and exposed material/controls. Partial results remain; no automatic undo. Retain groupingId for lost-response inspection. All profile.',inputSchema:guarded({trackIds:{...array(ids.trackId,'Consecutive exact track IDs in Live order.'),minItems:2,maxItems:64,uniqueItems:true},expectedSetFingerprint:string('Current Set fingerprint from get_live_state.')},['trackIds','expectedSetFingerprint'])},
  get_track_grouping_status:{description:'Inspect a retained native grouping handle from a group_tracks plan, including after a lost reply. Resolves actual Group/member IDs, hierarchy, exposed material and controls. Read-only; does not repeat grouping or restore anything. Runtime handles can expire or disappear after bridge reload; missing handles require current-track inspection. All profile.',inputSchema:object({groupingId:string('Retained groupingId from the plan or result.')},['groupingId'])},
  get_live_object_colors: {description:'Read native RGB colors and palette indices for one to 64 explicit tracks, Returns, Main, scenes or existing Session/Arrangement clips. Preserves focus. All profile.',inputSchema:object({objectIds:{...array(string('Canonical ID: track-N, return-N, master, scene-N, track-N:clip-M or track-N:arrangement-clip-M.'),'Exact objects to inspect.'),minItems:1,maxItems:64,uniqueItems:true}},['objectIds'])},
  set_live_object_colors: {description:'Set colors for one to 64 exact tracks, Returns, Main, scenes or existing Session/Arrangement clips in one undo step. Binds native identity and current color/name/selection. Live may choose a nearby palette color; reports actual RGB and exactMatch. Track color inheritance can affect Rack-chain appearance. No automatic clip recoloring or musical writes. Partial changes remain. All profile.',inputSchema:guarded({changes:{...array(object({objectId:string('Canonical ID from get_live_object_colors.'),color:{type:'string',pattern:'^#[0-9A-Fa-f]{6}$',description:'Explicit RGB hex, such as #FF0000. Native palette may adjust it.'}},['objectId','color']),'Explicit unique object/color pairs.'),minItems:1,maxItems:64},expectedSetFingerprint:string('Current Set fingerprint from get_live_state.')},['changes','expectedSetFingerprint'])},
  show_live_object: {description: 'Select and show an exact track, Session slot/clip, Arrangement clip or device in native Live views. Omit clipId/deviceId for the track. Plans preserve focus; confirmation changes selection and control-surface focus and may unfold Group ancestors, expand devices and reveal Rack chains. No playback or musical writes requested. Recording must be off. Native view readback does not prove desktop activation, timeline scrolling or plug-in editor visibility. All profile.',
    inputSchema: {...guarded({trackId:ids.deviceOwnerId,view:{type:'string',enum:['Session','Arranger'],description:'Requested main view; Session slots require Session and Arrangement clips require Arranger.'},clipId:ids.clipId,deviceId:ids.deviceId,expectedSetFingerprint:string('Current Set fingerprint from get_live_state.')},['trackId','view','expectedSetFingerprint']),not:{type:'object',properties:{clipId:{},deviceId:{}},required:['clipId','deviceId']}}},
  export_midi_clip: {description:'Export one exact Session or Arrangement MIDI clip through native macOS English Live to a new .mid file. Changes selection/focus; requires stopped recording/playback. Refuses overwrites. Verifies SMF0, source preservation and unmuted note pitch/timing/velocity within file resolution. Includes stored notes outside loop markers; no Live playback, MPE/controller or audible equivalence claim.',inputSchema:guarded({trackId:ids.trackId,clipId:ids.clipId,path:string('Absolute new .mid destination in an existing directory. Native export may include notes outside playback/loop markers and omit muted notes.')},['trackId','clipId','path'])},
  bounce_track_in_place: {description:"Destructively commit one whole ordinary track to audio, removing its devices in Session and Arrangement. Duplicate first to keep an editable source. Requires saved Set, stopped transport, unarmed visible target and macOS English Live. Rechecks native identity/selection and verifies audio layout, controls and file coverage; no audible-equivalence claim.",inputSchema:guarded({trackId:ids.trackId},["trackId"])},
  record_arrangement_take:{description:"Record one armed unfrozen ordinary track into an empty Arrangement beat range. Requires stopped playback/recording, no other arms, Session playback/overrides or pending launches. Uses native punch-in/out, disables loop/overdub/Automation Arm, changes loop bounds/playhead, and stops owned record/playback at the end without a client. Leaves target armed and setup controls in place. Partial material retained; all profile.",inputSchema:guarded({trackId:ids.trackId,startBeats:number("Inclusive quarter-note song beat.",{minimum:0}),endBeats:number("Exclusive song beat; at most 512 beats and 300 seconds from start.",{exclusiveMinimum:0})},["trackId","startBeats","endBeats"])},
  get_arrangement_take:{description:"Read one Arrangement recording handle, new clip spans, range coverage and control ownership, or list handles after a lost reply. Start acceptance and range coverage do not prove recorded performance, audio-file finalization or sound. Handles last until release or bridge restart; all profile.",inputSchema:object({takeId:string("Runtime take ID; omit to list retained handles.")})},
  finish_arrangement_take:{description:"Release a stopped Arrangement take handle and retain its material. Cancel true stops only owned global record/playback early; partial material retained. Ownership loss leaves transport untouched and retains the handle until stopped. Does not disarm, restore setup, save or delete; all profile.",inputSchema:guarded({takeId:string("Runtime take ID from record/read."),cancel:boolean("Explicit early-stop request; defaults to false.")},["takeId"])},
  get_device_ab_context: {description:"Read one device's native A/B capability, active slot, exposed parameters, identity and recording context without changing focus. Other-slot contents and hidden state are unavailable. Updated bridge; all profile.",inputSchema:object({trackId:ids.deviceOwnerId,deviceId:ids.deviceId},['trackId','deviceId'])},
  copy_device_ab_slot: {description:"Request native copying of current device state over the other A/B slot. Requires explicit overwriteOtherSlot true; previous other-slot contents are not backed up. Binds native identity/current controls and refuses recording, frozen owner or active/unknown automation. Copy request is not hidden-state verification. No automatic rollback.",inputSchema:guarded({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,overwriteOtherSlot:boolean('Explicit authority to discard the other native A/B slot; must be true.')},['trackId','deviceId','overwriteOtherSlot'])},
  select_device_ab_slot: {description:"Load exact native device A/B slot A or B while preserving transport. Binds current device identity/parameters and refuses recording, frozen owner or active/unknown automation. Switching can disable automation without re-enabling it on return. Reports observed slot/controls; no hidden preset, automation-preservation, phase or audible proof.",inputSchema:guarded({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,targetSlot:{type:'string',enum:['A','B'],description:'Exact native comparison slot.'}},['trackId','deviceId','targetSlot'])},
  compare_audio_reference: {description:'Compare equal 3–60-second local mono/stereo mix and reference windows for LUFS, true peak and loudness range. Binds both files with identity and SHA-256 before/after measurement; maximum 512 MiB each. Returns mix-minus-reference differences and attenuation-only level-match proposals. Read-only: no playback, normalization, mix edits, tonal or quality judgment. All profile; ffmpeg/ffprobe required.',inputSchema:object({mixPath:string('Absolute local rendered mix or verified capture file.'),referencePath:string('Absolute local reference audio file.'),mixStartSeconds:number('Mix window start in source-file seconds; default zero.',{minimum:0}),referenceStartSeconds:number('Reference window start in source-file seconds; default zero.',{minimum:0}),durationSeconds:number('Shared window duration, 3–60 seconds; defaults to 10. Both sources must contain the full window.',{minimum:3,maximum:60})},['mixPath','referencePath'])},
  import_midi_file:{description:'Import a local MIDI file through macOS English Live into an entirely empty final Session MIDI staging track. Requires muted, unarmed, monitoring off, No Output and stopped recording/playback. Verifies exact file selection and observed clip/object structure; multitrack files may add tracks. No complete event or audible equivalence claim. All profile.',inputSchema:guarded({trackId:ids.trackId,clipId:ids.clipId,sourcePath:string('Existing absolute regular .mid/.smf file, at most 8 MiB and 256 declared MIDI tracks.'),expectedSetFingerprint:string('Current Set fingerprint from get_live_state.')},['trackId','clipId','sourcePath','expectedSetFingerprint'])},
  save_native_device_preset: {description:'Save an exact device or rack as a new native User Library preset through macOS English Live. Sets intended preset naming and changes focus; may rename the source. Requires saved Set and stopped transport. Refuses existing names; verifies Live XML/VST3 artifacts and exposed source state. Audio Unit artifact verification is unavailable. No recall, audible-equivalence or sample-portability claim.',inputSchema:guarded({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,name:string('New visible filename stem, without extension; at most 80 characters. Existing native User Library preset names refuse.')},['trackId','deviceId','name'])},
  get_project_media: {description:'Inspect saved Live 12 sample references and file contents in the current Project. Reports missing, ambiguous and external samples; distinguishes the saved snapshot from unsaved Live edits. Does not certify plug-in libraries, licenses, Max dependencies or other Sets. Requires macOS English Live for native clean-state observation.',inputSchema:object()},
  collect_project_media: {description:'Collect all four native media categories into the current Project and save its clean named Live 12 Set. Requires stopped transport and macOS English Live. Binds saved references and source bytes; verifies Project-relative sample copies. Can copy large libraries. No automatic replay or complete-portability claim.',inputSchema:guarded({expectedSetFingerprint:string('Current Set fingerprint from get_live_state.')},['expectedSetFingerprint'])},
  export_audio_mix: {description:"Export Main as stereo WAV through the macOS English Live dialog. Requires stopped transport, recording off, unarmed tracks and an absent destination. Rechecks document/mix controls and verifies native settings and file format. Full-range render completion remains unconfirmed. Current Session overrides are included. Updates export preferences; no overwrite or musical-quality claim.",inputSchema:guarded({path:string("Absolute new .wav path; parent directory must exist."),start:string("Native render start as bars.beats.sixteenths, e.g. 1.1.1."),length:string("Native render length, e.g. 4.0.0 for four bars; include intended tails."),sampleRate:{type:"integer",enum:[44100,48000,88200,96000],description:"Defaults to 48000 Hz."},bitDepth:{type:"integer",enum:[16,24,32],description:"Defaults to 24; 32 uses floating point."},expectedSetFingerprint:string("Current Set fingerprint from get_live_state.")},["path","start","length","expectedSetFingerprint"])},
  audition_arrangement_passage: { description: "Plan/start a looping Arrangement passage from stopped transport with recording off and no pending launches. Return only explicit ordinary tracks from Session override; reject Groups. Changes global loop/playhead and starts global playback until stopped. Other tracks may sound. Partial failure reports observed controls; earlier Session phase is not restored. Requires all profile.", inputSchema: guarded({
    trackIds: { ...array(ids.trackId,"Ordinary tracks to return to Arrangement; other overrides stay in place."),minItems:1,maxItems:64,uniqueItems:true },
    startBeats: number("Inclusive song-time start in quarter-note beats.",{minimum:0}),
    endBeats: number("Exclusive end; increasing range of at most 512 beats.",{exclusiveMinimum:0})
  },["trackIds","startBeats","endBeats"]) },
  capture_device_chain_snapshot: { description: "Capture ordered devices, nested rack topology, exposed parameters, Return or master mixer, available master output channel, chain mixer, Drum Rack note routing and populated pad mute/solo as persistable JSON. Not a native rack or preset; excludes hidden plugin state, samples, automation, and mappings.", inputSchema: object({ trackId: ids.deviceOwnerId }, ["trackId"]) },
  list_saved_snapshots: { description: "List names of regular local capture files in the private track, device-chain, group-system, or MIDI-feel library. Does not validate capture contents or change Live; load a name to inspect its format and contents.", inputSchema: object({ kind: { type: "string", enum: ["track", "device-chain", "group-system", "midi-feel"] } }, ["kind"]) },
  save_device_chain_snapshot: { description: "Capture a device chain including Return or master mixer, available master output channel, exposed rack-chain controls and populated Drum Rack pad mute/solo into the private named local chain library. Never overwrites. Does not save hidden plugin state, samples, automation, or mappings.", inputSchema: object({ trackId: ids.deviceOwnerId, name: string("New local chain snapshot name; letters, numbers, dot, underscore and hyphen only.") }, ["trackId", "name"]) },
  load_device_chain_snapshot: { description: "Read a named local device-chain snapshot for review and guarded recall onto an already compatible track, Return, or Main device owner. Does not mutate Live.", inputSchema: object({ name: string("Exact saved chain snapshot name.") }, ["name"]) },
  recall_device_chain_snapshot: { description: "Plan or recall Return or master mixer, available master output channel, exposed device parameters, rack-chain mixer, Drum Rack note routing and populated pad mute/solo onto exactly compatible topology in one guarded Live undo step. Legacy v1-v5 captures remain supported. Does not create, delete, or load devices or restore hidden plugin state.", inputSchema: guarded({ trackId: ids.deviceOwnerId, snapshot: deviceChainSnapshot }, ["trackId", "snapshot"]) },
  capture_device_parameter_snapshot: { description: "Capture exposed device parameters as persistable JSON, with a consistent live identity check. Not a native preset: excludes hidden plugin state, samples, automation and mappings.", inputSchema: device },
  capture_track_state_snapshot: { description: "Capture one consistent, persistable JSON snapshot of group membership, track mixer, routing, ordered devices, nested rack parameters, chain mixer, Drum Rack note routing and populated pad mute/solo. Not a native track preset; excludes clips, hidden state, samples, automation and mappings.", inputSchema: track },
  capture_group_system_snapshot: { description: "Capture an existing Group Track, nested groups and all descendant tracks in Live order as persistable JSON. Every track snapshot and the final hierarchy must match one state version. Read-only; does not save clips, samples, hidden plug-in state, automation or mappings, or create/recall tracks.", inputSchema: object({ busTrackId: ids.trackId }, ["busTrackId"]) },
  save_group_system_snapshot: { description: "Capture an existing Group Track and descendants into a private named local JSON file. Never overwrites; preserves exposed mixer, routing, device and rack state but not clips, samples, hidden plug-in state, automation or mappings.", inputSchema: object({ busTrackId: ids.trackId, name: string("New local group-system snapshot name; letters, numbers, dot, underscore and hyphen only.") }, ["busTrackId", "name"]) },
  load_group_system_snapshot: { description: "Read one saved group-system JSON capture for review or guarded recall onto compatible existing topology. Loading the JSON does not mutate Live or recreate tracks.", inputSchema: object({ name: string("Exact saved group-system snapshot name.") }, ["name"]) },
  plan_group_system_recall: { description: "Read a saved group-system capture and check a one-to-one mapping onto existing tracks in matching Live order and group hierarchy. Validates each exposed track state for individual guarded recall; does not mutate Live or perform a multi-track transaction.", inputSchema: object({ name: string("Exact saved group-system snapshot name."), busTrackId: ids.trackId,
    mapping: array(object({ sourceTrackId: ids.trackId, targetTrackId: ids.trackId }, ["sourceTrackId", "targetTrackId"]), "One explicit source-to-target entry for every saved track.") }, ["name", "busTrackId", "mapping"]) },
  recall_group_system_snapshot: { description: "Plan or apply a saved group-system capture onto one-to-one mapped compatible existing Group Track and descendants. One guarded native callback and Live undo step restore exposed track mixer, routing, device and rack state; on failure the bridge attempts rollback across every changed track. Does not recreate tracks/devices/clips or hidden plugin state.", inputSchema: guarded({ name: string("Exact saved group-system snapshot name."), busTrackId: ids.trackId,
    mapping: array(object({ sourceTrackId: ids.trackId, targetTrackId: ids.trackId }, ["sourceTrackId", "targetTrackId"]), "One explicit source-to-target entry for every saved track.") }, ["name", "busTrackId", "mapping"]) },
  save_track_state_snapshot: { description: "Capture one exact track state and save its JSON to the private named local snapshot library. Never overwrites; excludes clips, hidden plugin state, samples, automation and mappings.", inputSchema: object({ trackId: ids.trackId, name: string("New local snapshot name; letters, numbers, dot, underscore and hyphen only.") }, ["trackId", "name"]) },
  load_track_state_snapshot: { description: "Read a previously saved local track-state JSON capture for review and explicit guarded recall onto an already compatible track. Does not mutate Live.", inputSchema: object({ name: string("Exact saved snapshot name.") }, ["name"]) },
  recall_track_state_snapshot: { description: "Plan or recall captured track-state JSON onto exactly compatible topology and group membership (when captured). Restores track and rack-chain mixer, sends, routing, Drum Rack note routing, populated pad mute/solo and exposed nested parameters in one guarded native undo step; older snapshots without group context remain supported. Does not load devices, clips, samples, hidden state, automation or mappings.", inputSchema: guarded({ trackId: ids.trackId, snapshot: trackStateSnapshot }, ["trackId", "snapshot"]) },
  recall_device_parameter_snapshot: { description: "Guarded recall of parameter JSON onto a matching native device class and exact ordered parameter layout. Supports ordinary, Return, and Main tracks; rejects incompatible bounds/choices and disabled changed controls. Does not restore hidden state.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, snapshot: parameterSnapshot }, ["trackId", "deviceId", "snapshot"]) },
  get_factory_coverage: { description: "Compare observed top-level Live factory browser devices with name-matched knowledge profiles. Reports missing profiles, not verified deep integration or all presets/Packs/plugins.", inputSchema: empty },
  get_producer_workflow: { description: "List producer workflows, or retrieve one with named string arguments. Returns shared MCP prompt instructions without calling Live or executing work. Omit workflow to list names and required arguments. Available in all and producer profiles.", inputSchema: object({
    workflow: { type: "string", enum: listPrompts().map(prompt=>prompt.name) },
    arguments: { type: "object", description: "Named prompt arguments from listing, such as request, mode or setPath.", maxProperties: 8,
      propertyNames: { minLength: 1, maxLength: 64 }, additionalProperties: { type: "string", maxLength: 8192 } }
  }) },
  list_producer_chain_blueprints: { description: "List deterministic producer starting points for ordered track, bus, return, mastering, and layered-instrument chains.", inputSchema: empty },
  get_producer_chain_blueprint: { description: "Return one ordered factory-device chain or shared-bus topology with exact browser paths, stage roles, execution tools, and explicit limitations.", inputSchema: object({ target: { type: "string", enum: ["bass", "drums", "vocals", "guitar", "keys", "synth", "mix-bus", "mastering", "reverb-return", "delay-return", "layered-bass-system", "layered-synth-system", "layered-drums-system", "layered-keys-system", "layered-vocals-system", "layered-guitar-system"] } }, ["target"]) },
  inspect_producer_chain: { description: "Read the devices on one exact track and compare their factory profiles and order with a named producer-chain blueprint. No devices are loaded or changed.", inputSchema: object({ target: { type: "string", enum: ["bass", "drums", "vocals", "guitar", "keys", "synth", "mix-bus", "mastering", "reverb-return", "delay-return", "layered-bass-system", "layered-synth-system", "layered-drums-system", "layered-keys-system", "layered-vocals-system", "layered-guitar-system"] }, trackId: ids.deviceOwnerId }, ["target", "trackId"]) },
  inspect_producer_bus: { description: "Read an existing Group or ordinary audio bus, ordered FX, child sources and routing against a layered blueprint. Audio uses two matching snapshot passes; checks No Input, monitor In, Main output and child Track In routes. Optional pluginId selects an explicitly chosen Serum 2, Omnisphere or VPS Avenger instead of the blueprint's factory instrument; this verifies loaded identity, not preset or sound.", inputSchema: object({ target: { type: "string", enum: ["layered-bass-system", "layered-synth-system", "layered-drums-system", "layered-keys-system", "layered-vocals-system", "layered-guitar-system"] }, busTrackId: ids.trackId, busKind: { type: "string", enum: ["group", "audio"], description: "group (default) or ordinary audio bus." }, children: array(object({ role: string("Exact blueprint child role."), trackId: ids.trackId, pluginId: { type: "string", enum: ["serum-2", "omnisphere", "vps-avenger"] } }, ["role", "trackId"]), "One track for each blueprint child role.") }, ["target", "busTrackId", "children"]) },
  inspect_producer_return_bus: { description: "Read an existing Return bus, ordered FX, child sources, sends and Sends Only routing against a layered blueprint. Optional pluginId selects an explicitly chosen Serum 2, Omnisphere or VPS Avenger instead of the blueprint's factory instrument; this verifies loaded identity, not preset or sound.", inputSchema: object({ target: { type: "string", enum: ["layered-bass-system", "layered-synth-system", "layered-drums-system", "layered-keys-system", "layered-vocals-system", "layered-guitar-system"] }, returnTrackId: string("Exact Return Track ID."), children: array(object({ role: string("Exact blueprint child role."), trackId: ids.trackId, pluginId: { type: "string", enum: ["serum-2", "omnisphere", "vps-avenger"] } }, ["role", "trackId"]), "One track for each blueprint child role.") }, ["target", "returnTrackId", "children"]) },
  search_presets: { description: "Search the optional local NKS preset catalog by name, across every product unless productSlug is given. Presets the last inventory did not find on disk are excluded.", inputSchema: object({ productSlug: string("Product slug."), query: string("Name query."), favorite: boolean("Return only favorites or non-favorites."), tags: array(string("Normalized user tag."), "Require every supplied tag."), limit: { type: "integer", minimum: 1 } }) },
  get_nks_generation_status: { description: "Read discovered preset and durable job counts for one product. Serum 2 and Omnisphere also report pilot size, validated count, gate state, queueable factory count (including already queued presets), remaining discovered pilot IDs, and unqueued discovered pilot IDs without a durable job. Does not create a queue or contact Live.", inputSchema: object({ productSlug: string("Exact product slug.") }, ["productSlug"]) },
  get_nks_generation_job: { description: "Read one durable NKS generation job and its ordered event history without creating or changing the queue.", inputSchema: object({ presetId: ids.presetId }, ["presetId"]) },
  enqueue_nks_generation_jobs: { description: "Plan or enqueue only explicitly selected eligible discovered presets, in batches of at most 100, using a single-use confirmation. Serum 2 and Omnisphere are limited to their deterministic factory pilots until every pilot record is validated. Does not generate or mark any preset saved.", inputSchema: object({ productSlug: string("Exact product slug."), presetIds: { ...array(ids.presetId, "Exact preset IDs to enqueue; product-wide enqueue is not supported."), minItems: 1, maxItems: 100, uniqueItems: true }, dryRun: confirmation.dryRun, confirmationToken: confirmation.confirmationToken, planHash: confirmation.planHash }, ["productSlug", "presetIds"]) },
  claim_nks_generation_job: { description: "Atomically lease one pending NKS generation job for a worker. Returns its catalog preset without loading the plugin or saving a file.", inputSchema: object({ workerId: string("Non-empty worker identity."), productSlug: string("Exact product slug.") }, ["workerId", "productSlug"]) },
  heartbeat_nks_generation_job: { description: "Extend an unexpired NKS generation lease owned by this worker.", inputSchema: object({ presetId: ids.presetId, workerId: string("Lease owner identity.") }, ["presetId", "workerId"]) },
  fail_nks_generation_job: { description: "Record a worker failure and return the leased NKS job to pending, or quarantine it after the retry limit. Does not change preset lifecycle.", inputSchema: object({ presetId: ids.presetId, workerId: string("Lease owner identity."), reason: string("Non-empty failure reason.") }, ["presetId", "workerId", "reason"]) },
  complete_nks_generation_job: { description: "Mark an owned NKS job done only after its catalog preset contains verified saved-artifact evidence. Does not generate or validate the artifact itself.", inputSchema: object({ presetId: ids.presetId, workerId: string("Lease owner identity.") }, ["presetId", "workerId"]) },
  get_preset: { description: "Read one exact NKS preset catalog record.", inputSchema: object({ presetId: ids.presetId }, ["presetId"]) },
  get_preset_metadata: { description: "Read user tags, favorite state, and revision for one preset.", inputSchema: object({ presetId: ids.presetId }, ["presetId"]) },
  set_preset_metadata: { description: "Plan or update user tags and favorite state for one preset with an exact revision guard.", inputSchema: metadataGuarded({ presetId: ids.presetId, favorite: boolean("Favorite state."), tags: array(string("User tag."), "Complete replacement tag set.") }, ["presetId"]) },
  get_browser_item_metadata: { description: "Read private MCP-managed tags, favorite state, and revision for one exact observed Live browser item or local audio sample. A Live user-folder sample shares the local Splice record only when its URI unambiguously matches a configured local Splice file; reserved URI delimiters and existing separate Live metadata preserve exact Live identity. For a local sample, use root local_splice and path [absolute directory, relative audio path]. Does not read native collections.", inputSchema: object({ root: string("Live browser root or local_splice."), path: array(string("Exact browser segment, or [absolute directory, relative audio path] for local_splice."), "Non-empty path to one item.") }, ["root", "path"]) },
  set_browser_item_metadata: { description: "Plan or edit private MCP-managed tags and favorite state with observed Live browser identity or local audio-file version, exact revision, and single-use confirmation. A Live user-folder sample shares the local Splice record only when its URI unambiguously matches a configured local Splice file; reserved URI delimiters and existing separate Live metadata preserve exact Live identity. For a local sample, use root local_splice and path [absolute directory, relative audio path]. Does not modify native collections.", inputSchema: metadataGuarded({ root: string("Live browser root or local_splice."), path: array(string("Exact browser segment, or [absolute directory, relative audio path] for local_splice."), "Non-empty path to one item."), favorite: boolean("Private favorite state."), tags: array(string("Private user tag."), "Complete replacement tag set, up to 32 entries.") }, ["root", "path"]) },
  search_browser_item_metadata: { description: "Search saved private tags and favorites for Live browser items or local_splice samples. Results are not reverified against Live or the local filesystem and do not represent native collections.", inputSchema: object({ root: string("Optional browser root or local_splice filter."), favorite: boolean("Optional private favorite filter."), tags: array(string("Required private user tag."), "Require all tags."), limit: { type: "integer", minimum: 1, maximum: 200 } }) },
  get_live_state: { description: "Read Ableton bridge identity, capabilities, set file path, tempo, playback, and state version.", inputSchema: empty },
  open_live_set: { description: "Plan/open a macOS Set; launch requires closed Live and configured app.", inputSchema: { ...guarded({
    path: string("Existing absolute .als path."),
    mode: { type: "string", enum: ["open", "launch"], description: "launch if closed." },
    expectedSetFingerprint: string("Current setFingerprint, except launch.")
  }), required: ["path"], anyOf: [{ required: ["expectedStateVersion", "expectedSetFingerprint"],
    properties: { expectedStateVersion: {}, expectedSetFingerprint: {} } },
    { required: ["mode"], properties: { mode: { const: "launch" } } }] } },
  save_live_set: { description: "Save macOS Set; verify write or clean state. Path: Save As without overwrite.", inputSchema: guarded({
    path: string("New absolute .als; parent must exist."),
    expectedSetFingerprint: string("Current setFingerprint.")
  }, ["expectedSetFingerprint"]) },
  get_history_state: { description: "Read current Ableton undo and redo availability.", inputSchema: empty },
  capture_live_audio: { description: "Plan or start a bounded Live Resampling recording of current playback into a new muted, monitor-off audio track. Requires playback, recording off and no armed tracks. Only its capture is stopped/disarmed automatically, even after client disconnect. No isolated-stem, hardware or listener proof.", inputSchema: guarded({
    beats: number("Record 1-16 beats, lasting 0.5-30 seconds at current tempo.", { minimum: 1, maximum: 16 }),
    name: { type: "string", minLength: 1, maxLength: 128, description: "Name for the retained capture track." }
  }, ["beats", "name"]) },
  get_live_audio_capture: { description: "Read a capture's status, current native track/clip IDs, cleanup errors and stable completed file provenance. Omit captureId to list handles after reconnect or a timed-out start. No edits; runtime handles are not saved in the Set.", inputSchema: object({ captureId: string("Capture ID from start or listing.") }) },
  finish_live_audio_capture: { description: "Plan or release a completed capture handle, keeping its track/file. Cancel true stops and disarms an active capture early and retains partial audio. A pending native stop returns captureActive true with stopping status; read until confirmed, then finish. Cleanup failure is explicit and preserves the handle. Never stops source playback.", inputSchema: guarded({
    captureId: string("Capture ID from start or listing."), cancel: boolean("Explicitly stop an in-progress capture early; retain partial recording.")
  }, ["captureId"]) },
  get_session_orientation: { description: "Read Set, recording, selection, clip and instruments together; configured scale and ambiguous MIDI evidence. No edits, playback or focus changes.", inputSchema: empty },
  analyze_arrangement_section: { description: "Read one explicit Arrangement beat window across all or selected ordinary tracks. Report overlapping clips and projected stored-MIDI tonal evidence with loop repeats and trimmed boundaries. Optional includeHarmony adds timed pitch sets, literal chord candidates and gaps. Includes muted material; audio, drums, recording and large clips remain explicit exclusions. Not playback, a detected key, or a meter/key map. Read-only; no focus changes.", inputSchema: object({
    startBeats: number("Inclusive song-time start in quarter-note beats.", { minimum: 0 }),
    endBeats: number("Exclusive end; increasing range, at most 512 beats.", { exclusiveMinimum: 0 }),
    trackIds: { ...array(ids.trackId, "Optional unique ordinary tracks; omit for all, up to 64."), minItems: 1, maxItems: 64, uniqueItems: true },
    includeHarmony: boolean("Include timed stored-pitch sets and exact chord candidates, gaps and ambiguity. At most 4096 projected spans and 256 intervals; no inferred harmonic function or audio.")
  }, ["startBeats", "endBeats"]) },
  analyze_midi_parts: { description: "Read 1-8 explicit Session/Arrangement clips together. Report per-part register, duration-weighted pitch classes and combined diatonic compatibility. Loop/marker ranges only; not simultaneous playback or detected key. Audio, drums, recording and oversized clips are excluded explicitly. No edits or focus changes.", inputSchema: object({
    parts: { ...array(clip, "Exact parts from list_clips or list_arrangement_clips; unique references, at most 16384 analyzed notes total."), minItems: 1, maxItems: 8, uniqueItems: true }
  }, ["parts"]) },
  get_instrument_comparison: { description: "Read a runtime instrument comparison and current track IDs, mute states and readiness. Omit comparisonId to list this bridge instance's active comparisons, including after a timed-out preparation. No edits.", inputSchema: object({ comparisonId: string("Comparison ID returned by preparation or listing.") }) },
  prepare_instrument_comparison: { description: "Plan or natively duplicate a MIDI instrument track for comparison. Binds exposed devices, routing, clips and notes; verifies source/copy and cleans up a failed copy. Requires stopped transport. Temporarily mutes source, restores it, leaves copy muted/unarmed with input monitoring off. IDs shift. Opaque state/audio unverified.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId,
    name: { type: "string", minLength: 1, maxLength: 128, description: "Name for the alternative track." } }, ["trackId", "clipId", "name"]) },
  adopt_instrument_comparison: { description: "Plan or bind a new runtime comparison handle to two explicitly chosen existing MIDI parts, including after restart. Binds current notes, timing, devices, routing and topology; no tracks, notes, mutes or playback are changed. Restore uses both adoption-time mutes, not an unknown prior baseline. Refuses active pairs, recording, solo, live-input conflicts and two unmuted tracks. Does not prove historical identity or matching copies.", inputSchema: guarded({
    original: clip, variation: clip
  }, ["original", "variation"]) },
  select_instrument_comparison: { description: "Plan or switch only the original/alternative pair's mutes in one native step. Restore uses the reported preparation/adoption mute baseline. Refuses recording, frozen, solo and live-input conflicts. No playback, routing or note edits. Optional finish ends the handle and preserves both tracks.", inputSchema: guarded({ comparisonId: string("Active comparison ID."),
    choice: { type: "string", enum: ["original", "variation", "restore"] }, finish: boolean("End the comparison handle after applying the choice; keep both tracks.") }, ["comparisonId", "choice"]) },
  get_selection_context: { description: "Read selected track/scene/device, displayed clip and highlighted slot together without changing focus. Null is unresolved; clip and slot can differ.", inputSchema: empty },
  duplicate_midi_clip_variations: { description: "Copy 1-4 named Session MIDI clips to empty slots on the same track. Binds notes/timing; verifies exposed copies and preserves original. One undo step; removes copies on failure. Edit identical copies separately.", inputSchema: guarded({
    trackId: ids.trackId, sourceClipId: string("Exact populated Session MIDI clip ID."),
    variants: { type: "array", description: "Named copies.", minItems: 1, maxItems: 4, items: object({
      clipId: string("Existing empty Session slot on the same track."),
      name: { type: "string", minLength: 1, maxLength: 128, description: "Name for this alternative." }
    }, ["clipId", "name"]) }
  }, ["trackId", "sourceClipId", "variants"]) },
  undo: { description: "Plan or apply one guarded Ableton undo operation.", inputSchema: guarded() },
  redo: { description: "Plan or apply one guarded Ableton redo operation.", inputSchema: guarded() },
  get_transport_context: { description: "Read transport playback, metronome, and count-in state.", inputSchema: empty },
  set_transport_context: { description: "Plan/apply metronome or count-in settings. Count-in requires stopped playback/recording, a saved Set and macOS English Live UI; changes focus.", inputSchema: guarded({ metronome: boolean("Metronome enabled."), countInDuration: choice("Count-in duration value or name.") }) },
  get_transport_recording_context: { description: "Read playhead, Arrangement and Session recording modes, automation arm, and native Capture MIDI readiness with MIDI track IDs.", inputSchema: empty },
  get_midi_capture_context: {description:"Read global Capture MIDI readiness, armed/monitored candidates, playing-clip risks, input routing, full-note digests and clip timing with native identity. Does not expose buffer contents or reserve a moving playhead.",inputSchema:empty},
  capture_midi_session: {description:"Capture Live's hidden recent MIDI input into Session globally. Rechecks native identities, existing note/timing, routing, arms, monitoring and musical/recording state. May start playback/add scenes/change tempo. Known playing-clip changes require explicit allowExistingClipChanges. Read changedSlots and captureVerified; no exact buffer preview or automatic rollback.",inputSchema:guarded({allowExistingClipChanges:boolean("Explicit authority for known playing Session clip changes; default false.")})},
  set_transport_recording_context: { description: "Plan or apply guarded playhead and recording-mode changes.", inputSchema: guarded({ currentSongTime: number("Playhead position in beats.", { minimum: 0 }), arrangement: object({ record: boolean("Arrangement record."), overdub: boolean("Arrangement overdub."), punchIn: boolean("Punch-in."), punchOut: boolean("Punch-out."), backToArranger: boolean("Back-to-Arrangement state.") }), session: object({ record: boolean("Session record."), overdub: boolean("Session overdub.") }), automationArm: boolean("Automation arm.") }) },
  get_song_musical_context: { description: "Read key, scale, time signature, quantization, groove, swing, and Arrangement loop context.", inputSchema: empty },
  get_live_scale_reference: { description: "Resolve one exact Ableton Live 12 scale and root to semitone intervals, pitch classes, note names, degrees, and scale family. Read-only.", inputSchema: object({ scaleName: { ...string("Exact Live scale name."), enum: listLiveScaleReferences().map(({ name }) => name) }, rootNote: { type: "integer", minimum: 0, maximum: 11, description: "C=0 through B=11." } }, ["scaleName", "rootNote"]) },
  list_live_scales: { description: "List Ableton Live 12 scale names with semitone intervals and musical families for exact scale selection. Read-only.", inputSchema: empty },
  get_song_grid_reference: { description: "Read a meter/tempo-aware bar of straight 16ths and eighth/sixteenth triplets, downbeats/offbeats and advisory 4/4 genre placements. Read-only.", inputSchema: empty },
  plan_grid_envelope_pattern: { description: "Read current Live grid and return exact on/off Session clip envelope steps for a straight or triplet rhythm, including Beat Repeat Repeat. No Live edits. Supply the exact native on/off values; set_clip_parameter_envelope validates the destination clip and parameter before any write. Rejects grid/bar misalignment.", inputSchema: object({ grid: { type: "string", enum: ["straight16", "eighthTriplet", "sixteenthTriplet"] }, bars: { type: "integer", minimum: 1, maximum: 16 }, activeSteps: array({ type: "integer", minimum: 1 }, "Unique 1-based active step numbers within each bar."), onValue: number("Native parameter value during active steps."), offValue: number("Native parameter value during inactive steps."), startBeat: number("Absolute Session clip beat offset; default zero.", { minimum: 0 }) }, ["grid", "bars", "activeSteps", "onValue", "offValue"]) },
  plan_drum_pattern: { description: "Plan explicit multi-lane drum notes against the current Live meter on a straight-sixteenth, eighth-triplet, or sixteenth-triplet grid. Supports per-lane accents without treating style examples as universal rules.", inputSchema: object(drumPatternProperties, ["grid", "bars", "lanes"]) },
  set_groove: { description: "Plan or apply guarded Groove Pool base-grid, name and percentage edits. Timing, random, pre-quantization use 0–100; velocity uses -100–100. Affects every clip using this shared groove; does not bake or extract a groove.", inputSchema: guarded({ grooveId: string("Exact groove ID from musical context."), baseGrid: choice("Exact native baseGrid choice name or value from musical context, including triplets."), name: string("Groove name."), timingAmount: number("Timing percentage.", { minimum: 0, maximum: 100 }), quantizationAmount: number("Straight pre-quantization percentage.", { minimum: 0, maximum: 100 }), randomAmount: number("Random timing percentage.", { minimum: 0, maximum: 100 }), velocityAmount: number("Velocity percentage; negative reverses the groove's velocity influence.", { minimum: -100, maximum: 100 }) }, ["grooveId"]) },
  set_song_musical_context: { description: "Plan or apply guarded song key, scale, timing, quantization, groove, swing, or loop changes.", inputSchema: guarded({
    timeSignature: object({ numerator: { type: "integer", minimum: 1 }, denominator: { type: "integer", enum: [1, 2, 4, 8, 16] } }),
    key: object({ rootNote: { type: "integer", minimum: 0, maximum: 11 }, scaleName: string("Live scale name."), scaleMode: boolean("Enable Live scale mode.") }),
    quantization: object({ clipTrigger: choice("Clip-trigger quantization value or name."), midiRecording: choice("MIDI-recording quantization value or name.") }), groove: object({ amount: number("Native global groove intensity: 1 is 100%; maximum 1.3125. Individual pool amounts use separate percentage units.", { minimum: 0, maximum: 1.3125 }), swingAmount: number("Swing amount.", { minimum: 0, maximum: 1 }) }),
    loop: object({ enabled: boolean("Arrangement loop enabled."), startBeats: number("Loop start.", { minimum: 0 }), lengthBeats: number("Loop length.", { exclusiveMinimum: 0 }) }),
  }) },
  list_arrangement_cue_points: { description: "List Arrangement cue points with stable IDs and beat positions.", inputSchema: empty },
  create_arrangement_cue_point: { description: "Plan or create an Arrangement cue point at an exact beat position.", inputSchema: guarded({ name: string("Cue-point name."), timeBeats: number("Cue-point position in beats.", { minimum: 0 }) }, ["name", "timeBeats"]) },
  rename_arrangement_cue_point: { description: "Plan or rename one exact Arrangement cue point.", inputSchema: guarded({ cuePointId: string("Stable cue-point ID."), name: string("New cue-point name.") }, ["cuePointId", "name"]) },
  delete_arrangement_cue_point: { description: "Plan or delete one exact Arrangement cue point.", inputSchema: guarded({ cuePointId: string("Stable cue-point ID.") }, ["cuePointId"]) },
  jump_to_arrangement_cue_point: { description: "Plan or move the playhead to one exact Arrangement cue point.", inputSchema: guarded({ cuePointId: string("Stable cue-point ID.") }, ["cuePointId"]) },
  list_tracks: { description: "List stable Ableton track identities, mixer state, and existing group hierarchy.", inputSchema: empty },
  list_scenes: { description: "List stable Session scene identities, names, and per-scene launch quantization.", inputSchema: empty },
  get_take_lane_audition_context: {description: "Read native take inventory and currently exposed macOS English Live audition checkboxes without changing view, focus or playback. Hidden lanes have unknown audition state. Requires a saved Set with native document identity, one Live instance and an updated bridge; all profile.",inputSchema:track},
  show_take_lanes: {description: "Show Arrangement and one track take lanes through the macOS English Live UI. Requires an unarmed unfrozen track, recording off and unfolded ancestor groups. Requires a saved Set with native document identity and one Live instance. Changes visible UI/focus; no playback or comp edit.",inputSchema:guarded({trackId:ids.trackId},["trackId"])},
  select_take_lane_audition: {description: "Select audition for one entire visible take lane, or return its track to the comp with laneId null. Rechecks native and UI identities/flags. Does not start playback, edit the comp or change mutes/solos/routing. Requires a saved Set with native document identity and one Live instance; macOS English Live, all profile.",inputSchema:guarded({trackId:ids.trackId,laneId:{oneOf:[{type:"string"},{type:"null"}],description:"Exact lane ID from inventory, or explicit null for the comp."}},["trackId","laneId"])},
  get_take_lane_context: {description: "Inspect one track take-lane inventory and optionally one complete stored take clip. Read-only; preserves focus. Selected MIDI reports up to 4096 notes; audio reports exposed source/timing controls. Does not expose comp selections, envelopes or rendered sound. All profile.", inputSchema: object({trackId:ids.trackId,takeClipId:string("Exact take clip ID from this inventory; omit for lane/clip summaries.")},["trackId"])},
  get_scene_launch_context: {description:'Preview an exact Session scene in one native read: every track/slot, clip/stop/Group actions, arms, recording risks, current playback and global/scene musical context. Preserves selection and playback. Launch metadata only; no audible or follow-action prediction. All profile.',inputSchema:object({sceneId:ids.sceneId},['sceneId'])},
  get_simpler_sample_state: {description:'Read one existing Simpler, including nested racks: path, length/start-end markers/slices in sample frames, rate in Hz, native warp/slicing controls, playback mode, parameters and edit context. No edits. All profile; requires updated bridge.',inputSchema:object({trackId:ids.trackId,deviceId:ids.deviceId},['trackId','deviceId'])},
  set_simpler_manual_slices: {description:'Set an exact manual slice layout on a loaded single-sample Simpler, including nested racks. Selects Slicing/Manual mode, disables Pad Slicing and clears prior manual cuts, including outside the active region. Requires stopped transport and an inactive unarmed target; verifies native slices and retained sample. No file crop/reload or automatic rollback. All profile.',inputSchema:guarded({trackId:ids.trackId,deviceId:ids.deviceId,slicesFrames:{type:'array',minItems:1,maxItems:64,items:{type:'integer',minimum:0},description:'Complete playable layout in increasing sample frames, beginning at observed startMarkerFrames and strictly below endMarkerFrames.'},slicingPlaybackMode:{type:'string',enum:['mono','poly','thru'],description:'Optional slice playback: one slice, overlapping slices, or play from a slice through the region. Omit to retain observed setting.'}},['trackId','deviceId','slicesFrames'])},
  set_simpler_sample_region: {description:'Set a loaded Simpler playback region in native sample frames, including nested racks. At least one marker; omitted bound stays unchanged. Requires stopped transport and an inactive unarmed single-sample target. Binds native context and verifies exact markers; does not crop the source file. Partial failure requires inspection; no automatic rollback. All profile.',inputSchema:guarded({trackId:ids.trackId,deviceId:ids.deviceId,startMarkerFrames:{type:'integer',minimum:0,description:'Native start frame, below end. Omit to retain observed start.'},endMarkerFrames:{type:'integer',minimum:1,description:'Native end frame, above start and below observed lengthFrames. Omit to retain observed end.'}},['trackId','deviceId'])},
  load_simpler_sample: {description:'Load a local audio file into an existing single-sample Simpler. Requires stopped transport and an inactive unarmed target; loaded samples require allowReplace. Binds native context/file metadata and verifies exposed readback. Failure may leave partial state; no full sample rollback. All profile.',inputSchema:guarded({trackId:ids.trackId,deviceId:ids.deviceId,sourcePath:string('Existing absolute local audio-file path; Live validates format.'),allowReplace:boolean('Explicitly permit replacing an already loaded sample. Defaults to false.'),playbackMode:{type:'string',enum:['classic','one-shot','slicing'],description:'Optional native playback mode after loading; omit to leave mode selection to Live.'}},['trackId','deviceId','sourcePath'])},
  list_clips: { description: "List clip slots and clips on one exact track, including arm/freeze recording readiness and native one-shot launch quantization choices.", inputSchema: track },
  create_track: { description: "Plan/create an audio/MIDI track at an insertion index. Live rechecks neighbors and verifies inserted type/name in one undo step.", inputSchema: guarded({ type: { type: "string", enum: ["audio", "midi"] }, index: { type: "integer", minimum: 0 }, name: string("Track name.") }, ["type", "name"]) },
  create_return_track: { description: "Plan or append a Return Track for shared send effects using Live's native bus API. Name is the raw label; Live prefixes the displayed return letter, and the result reports the observed display name.", inputSchema: guarded({ name: string("Raw Return Track label without its automatic bus-letter prefix.") }, ["name"]) },
  create_scene: { description: "Plan or create a Session scene at an exact insertion index. Native execution rechecks the neighboring scene records and verifies the new scene in one Live undo step.", inputSchema: guarded({ index: { type: "integer", minimum: 0 }, name: string("Scene name.") }, ["name"]) },
  rename_session_object: { description: "Plan or rename an exact track, Return Track, scene, or Session clip. Return names are raw labels; Live prefixes the displayed bus letter.", inputSchema: guarded({ targetType: { type: "string", enum: ["track", "return", "scene", "clip"] }, targetId: string("Stable target ID."), trackId: ids.trackId, name: string("New name; for Return Tracks omit the automatic bus-letter prefix.") }, ["targetType", "targetId", "name"]) },
  duplicate_session_object: { description: "Plan or duplicate an exact track, Session scene, or clip, optionally naming a duplicated track.", inputSchema: guarded({ targetType: { type: "string", enum: ["track", "scene", "clip"] }, targetId: string("Stable source ID."), trackId: ids.trackId, name: string("Optional name for a duplicated track.") }, ["targetType", "targetId"]) },
  delete_session_object: { description: "Plan or delete an exact track, Return Track, scene, or Session clip with explicit content authority. Return deletion discloses its devices and affected track-send lanes.", inputSchema: guarded({ targetType: { type: "string", enum: ["track", "return", "scene", "clip"] }, targetId: string("Stable target ID."), trackId: ids.trackId, allowContent: boolean("Allow deletion of contained material or a Return Track and its send lane.") }, ["targetType", "targetId"]) },
  get_midi_clip_notes: { description: "Read standard MIDI notes from one exact Session or Arrangement MIDI clip; Arrangement responses include timeline identity.", inputSchema: clip },
  get_midi_clip_notes_extended: { description: "Read MIDI note IDs, probability, release velocity, deviation and other fields from one Session/Arrangement clip; includes Arrangement timeline identity.", inputSchema: clip },
  analyze_midi_clip_scale: { description: "Analyze one exact MIDI clip against the current Live key and scale. Returns per-note pitch names, scale degrees, chromatic note IDs, and bounded nearest in-scale correction candidates without editing notes. Read-only.", inputSchema: clip },
  analyze_midi_clip_chords: { description: "Analyze sustained-note-aware chord events in one exact MIDI clip against the current Live key and scale. Returns deterministic chord candidates, inversions, Roman-numeral function, ambiguity, and chromatic pitch classes without editing notes. Read-only.", inputSchema: clip },
  plan_scale_chord_progression: { description: "Plan exact MIDI notes for a scale-degree chord progression in the current Live key and scale. Supports functional harmony, block chords, grid-locked pulses, ascending or descending arpeggios, bounded register, and deterministic voice leading.", inputSchema: object({ ...functionalProgressionProperties, degrees: { ...array({ type: "integer", minimum: 1, maximum: 9 }, "Ordered one-based scale degrees."), minItems: 1, maxItems: 64 }, notesPerChord: { type: "integer", enum: [3, 4] }, startBeats: number("First chord start in beats.", { minimum: 0 }), chordBeats: number("Duration and spacing of each chord in beats.", { exclusiveMinimum: 0 }), velocity: { type: "integer", minimum: 1, maximum: 127 }, minPitch: { type: "integer", minimum: 0, maximum: 127 }, maxPitch: { type: "integer", minimum: 0, maximum: 127 }, voiceLeading: { type: "string", enum: ["closest", "root_position"] }, articulation: object({ mode: { type: "string", enum: ["block", "pulse", "arpeggio_up", "arpeggio_down"] }, stepBeats: number("Grid subdivision in beats; required for pulse and arpeggio modes.", { exclusiveMinimum: 0 }), gate: number("Note duration as a fraction of stepBeats; required for pulse and arpeggio modes.", { exclusiveMinimum: 0, maximum: 1 }) }, ["mode"]) }, ["degrees", "notesPerChord", "startBeats", "chordBeats", "velocity", "minPitch", "maxPitch", "voiceLeading"]) },
  create_scale_chord_progression_clip: { description: "Plan or create a functional scale-degree chord progression in one exact empty Session clip. Native execution independently rederives the signed harmony and verifies every generated note.", inputSchema: guarded({ ...functionalProgressionProperties, trackId: ids.trackId, clipId: ids.clipId, name: string("New clip name."), degrees: { ...array({ type: "integer", minimum: 1, maximum: 9 }, "Ordered one-based scale degrees."), minItems: 1, maxItems: 64 }, notesPerChord: { type: "integer", enum: [3, 4] }, startBeats: number("First chord start in beats.", { minimum: 0 }), chordBeats: number("Duration and spacing of each chord in beats.", { exclusiveMinimum: 0 }), velocity: { type: "integer", minimum: 1, maximum: 127 }, minPitch: { type: "integer", minimum: 0, maximum: 127 }, maxPitch: { type: "integer", minimum: 0, maximum: 127 }, voiceLeading: { type: "string", enum: ["closest", "root_position"] }, articulation: object({ mode: { type: "string", enum: ["block", "pulse", "arpeggio_up", "arpeggio_down"] }, stepBeats: number("Grid subdivision in beats; required for pulse and arpeggio modes.", { exclusiveMinimum: 0 }), gate: number("Note duration as a fraction of stepBeats; required for pulse and arpeggio modes.", { exclusiveMinimum: 0, maximum: 1 }) }, ["mode"]) }, ["trackId", "clipId", "name", "degrees", "notesPerChord", "startBeats", "chordBeats", "velocity", "minPitch", "maxPitch", "voiceLeading"]) },
  plan_scale_bassline: { description: "Plan a deterministic scale-aware bassline from progression degrees in the current Live key. Places roots, root-octave motion, or roots with each chord's diatonic fifth on explicit straight or triplet grid steps.", inputSchema: object({ degrees: { ...array({ type: "integer", minimum: 1, maximum: 9 }, "Ordered one-based scale degrees."), minItems: 1, maxItems: 64 }, startBeats: number("Bassline start in beats.", { minimum: 0 }), chordBeats: number("Duration of each progression degree in beats.", { exclusiveMinimum: 0 }), stepBeats: number("Grid subdivision in beats; must divide chordBeats exactly.", { exclusiveMinimum: 0 }), activeSteps: { ...array({ type: "integer", minimum: 0, maximum: 4095 }, "Unique zero-based grid steps played within every chord."), minItems: 1, maxItems: 4096 }, gate: number("Note duration as a fraction of stepBeats.", { exclusiveMinimum: 0, maximum: 1 }), velocity: { type: "integer", minimum: 1, maximum: 127 }, minPitch: { type: "integer", minimum: 0, maximum: 127 }, maxPitch: { type: "integer", minimum: 0, maximum: 127 }, pitchPattern: { type: "string", enum: ["root", "root_octave", "root_fifth"] } }, ["degrees", "startBeats", "chordBeats", "stepBeats", "activeSteps", "gate", "velocity", "minPitch", "maxPitch", "pitchPattern"]) },
  plan_scale_melody: { description: "Plan an explicit scale-degree melody in the current Live key and meter on a straight or triplet grid. Omitted steps are rests; motifs can repeat deterministically.", inputSchema: object(scaleMelodyProperties, ["grid", "motifBars", "repeats", "events", "gate", "velocity", "basePitch", "minPitch", "maxPitch"]) },
  create_scale_bassline_clip: { description: "Plan or create one scale-aware bassline in an exact empty Session clip. Binds the Live key, progression, rhythm, register, destination, and state version; native execution verifies every generated note.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, name: string("New clip name."), degrees: { ...array({ type: "integer", minimum: 1, maximum: 9 }, "Ordered one-based scale degrees."), minItems: 1, maxItems: 64 }, startBeats: number("Bassline start in beats.", { minimum: 0 }), chordBeats: number("Duration of each progression degree in beats.", { exclusiveMinimum: 0 }), stepBeats: number("Grid subdivision in beats; must divide chordBeats exactly.", { exclusiveMinimum: 0 }), activeSteps: { ...array({ type: "integer", minimum: 0, maximum: 4095 }, "Unique zero-based grid steps played within every chord."), minItems: 1, maxItems: 4096 }, gate: number("Note duration as a fraction of stepBeats.", { exclusiveMinimum: 0, maximum: 1 }), velocity: { type: "integer", minimum: 1, maximum: 127 }, minPitch: { type: "integer", minimum: 0, maximum: 127 }, maxPitch: { type: "integer", minimum: 0, maximum: 127 }, pitchPattern: { type: "string", enum: ["root", "root_octave", "root_fifth"] } }, ["trackId", "clipId", "name", "degrees", "startBeats", "chordBeats", "stepBeats", "activeSteps", "gate", "velocity", "minPitch", "maxPitch", "pitchPattern"]) },
  create_scale_melody_clip: { description: "Plan or create one exact scale-degree melody in an empty Session clip. Binds Live key, meter, grid, destination, and state; native execution verifies every generated note.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, name: string("New melody clip name."), ...scaleMelodyProperties }, ["trackId", "clipId", "name", "grid", "motifBars", "repeats", "events", "gate", "velocity", "basePitch", "minPitch", "maxPitch"]) },
  create_drum_pattern_clip: { description: "Plan or create one exact multi-lane drum pattern in an empty Session clip. Binds current meter, tempo, grid, lanes, destination, and state; native execution verifies every generated note.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, name: string("New drum clip name."), ...drumPatternProperties }, ["trackId", "clipId", "name", "grid", "bars", "lanes"]) },
  plan_drum_pattern_edit: { description: "Plan replacement of explicitly selected drum lanes and bars in an existing MIDI clip while preserving unrelated notes. Empty activeSteps clears that lane in the range.", inputSchema: object({ trackId: ids.trackId, clipId: ids.clipId, grid: drumPatternProperties.grid, startBar: { type: "integer", minimum: 0, maximum: 4095 }, bars: drumPatternProperties.bars, lanes: { ...array(drumEditLane, "Drum lanes to replace inside the selected bars."), minItems: 1, maxItems: 128 } }, ["trackId", "clipId", "grid", "startBar", "bars", "lanes"]) },
  edit_drum_pattern_clip: { description: "Plan or apply guarded replacement of selected drum lanes and bars in an existing MIDI clip. Preserves unrelated notes and verifies the complete native note set.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, grid: drumPatternProperties.grid, startBar: { type: "integer", minimum: 0, maximum: 4095 }, bars: drumPatternProperties.bars, lanes: { ...array(drumEditLane, "Drum lanes to replace inside the selected bars."), minItems: 1, maxItems: 128 } }, ["trackId", "clipId", "grid", "startBar", "bars", "lanes"]) },
  plan_drum_variation: { description: "Plan deterministic bounded timing and velocity humanization plus an optional explicit final-bar fill. Preserves unrelated notes and rejects collisions.", inputSchema: object(drumVariationProperties, ["trackId", "clipId", "grid", "startBar", "bars", "laneNotes", "seed", "timingAmount", "velocityAmount", "preserveAccentsAbove"]) },
  apply_drum_variation: { description: "Plan or apply a guarded deterministic drum variation with exact native context and complete note readback.", inputSchema: guarded(drumVariationProperties, ["trackId", "clipId", "grid", "startBar", "bars", "laneNotes", "seed", "timingAmount", "velocityAmount", "preserveAccentsAbove"]) },
  plan_midi_humanization: { description: "Plan deterministic bounded timing and velocity humanization for exact MIDI note IDs. Preserves expression metadata and rejects new same-pitch collisions.", inputSchema: object(midiHumanizationProperties, ["trackId", "clipId", "noteIds", "seed", "gridBeats", "maxTimingOffsetBeats", "maxVelocityOffset"]) },
  humanize_midi_notes: { description: "Plan or apply guarded deterministic MIDI timing and velocity humanization with exact clip, grid, and complete native note readback.", inputSchema: guarded(midiHumanizationProperties, ["trackId", "clipId", "noteIds", "seed", "gridBeats", "maxTimingOffsetBeats", "maxVelocityOffset"]) },
  plan_midi_velocity_curve: { description: "Plan exact crescendo, decrescendo, fixed, or repeating accent velocities across complete ordered MIDI onsets.", inputSchema: object(midiVelocityCurveProperties, ["trackId", "clipId", "noteIds", "curve"]) },
  apply_midi_velocity_curve: { description: "Plan or apply a guarded MIDI velocity curve while preserving timing, pitch, duration, probability, and expression metadata.", inputSchema: guarded(midiVelocityCurveProperties, ["trackId", "clipId", "noteIds", "curve"]) },
  plan_midi_gate_pattern: { description: "Plan explicit repeating gate ratios across complete ordered MIDI onsets on a straight or triplet beat grid.", inputSchema: object(midiGatePatternProperties, ["trackId", "clipId", "noteIds", "gridBeats", "gateRatios"]) },
  apply_midi_gate_pattern: { description: "Plan or apply guarded MIDI gate durations while preserving onset, pitch, velocity, probability, and expression metadata.", inputSchema: guarded(midiGatePatternProperties, ["trackId", "clipId", "noteIds", "gridBeats", "gateRatios"]) },
  plan_midi_probability_pattern: { description: "Plan explicit repeating playback probabilities across complete ordered MIDI onsets.", inputSchema: object(midiProbabilityPatternProperties, ["trackId", "clipId", "noteIds", "probabilities"]) },
  apply_midi_probability_pattern: { description: "Plan or apply guarded MIDI playback probabilities while preserving pitch, timing, velocity, mute, and expression metadata.", inputSchema: guarded(midiProbabilityPatternProperties, ["trackId", "clipId", "noteIds", "probabilities"]) },
  plan_midi_ratchet_pattern: { description: "Plan explicit straight or triplet MIDI repeats across complete ordered onsets.", inputSchema: object(midiRatchetPatternProperties, ["trackId", "clipId", "noteIds", "spanBeats", "repeatCounts", "gate"]) },
  apply_midi_ratchet_pattern: { description: "Plan or apply guarded MIDI ratchets while preserving velocity, probability, mute, release velocity, and velocity deviation.", inputSchema: guarded(midiRatchetPatternProperties, ["trackId", "clipId", "noteIds", "spanBeats", "repeatCounts", "gate"]) },
  plan_midi_strum_pattern: { description: "Plan deterministic up, down, or alternating chord attacks while preserving every selected note end.", inputSchema: object(midiStrumPatternProperties, ["trackId", "clipId", "noteIds", "direction", "spreadBeats"]) },
  apply_midi_strum_pattern: { description: "Plan or apply guarded chord strumming while preserving pitch, velocity, probability, mute, release velocity, and velocity deviation.", inputSchema: guarded(midiStrumPatternProperties, ["trackId", "clipId", "noteIds", "direction", "spreadBeats"]) },
  plan_midi_chord_inversion: { description: "Plan deterministic octave rotation of complete chord onsets while preserving all non-pitch note state.", inputSchema: object(midiChordInversionProperties, ["trackId", "clipId", "noteIds", "direction", "steps"]) },
  apply_midi_chord_inversion: { description: "Plan or apply guarded chord inversions with complete native note readback verification.", inputSchema: guarded(midiChordInversionProperties, ["trackId", "clipId", "noteIds", "direction", "steps"]) },
  plan_midi_drop_voicing: { description: "Plan deterministic drop-2, drop-3, or drop-2-and-4 voicings for complete chord onsets.", inputSchema: object(midiDropVoicingProperties, ["trackId", "clipId", "noteIds", "mode"]) },
  apply_midi_drop_voicing: { description: "Plan or apply guarded chord drop voicings with complete native note readback verification.", inputSchema: guarded(midiDropVoicingProperties, ["trackId", "clipId", "noteIds", "mode"]) },
  plan_midi_chord_voice_leading: { description: "Plan deterministic octave-only voice leading across complete chord onsets, anchored to the first chord.", inputSchema: object(midiChordVoiceLeadingProperties, ["trackId", "clipId", "noteIds", "mode", "minPitch", "maxPitch"]) },
  apply_midi_chord_voice_leading: { description: "Plan or apply guarded chord voice leading with complete native note readback verification.", inputSchema: guarded(midiChordVoiceLeadingProperties, ["trackId", "clipId", "noteIds", "mode", "minPitch", "maxPitch"]) },
  plan_midi_chord_doubling: { description: "Plan exact bass, top, or outer octave chord doublings across complete selected onsets.", inputSchema: object(midiChordDoublingProperties, ["trackId", "clipId", "noteIds", "mode"]) },
  apply_midi_chord_doubling: { description: "Plan or apply guarded chord doublings while preserving existing notes and verifying every native addition.", inputSchema: guarded(midiChordDoublingProperties, ["trackId", "clipId", "noteIds", "mode"]) },
  plan_midi_chord_arpeggiation: { description: "Plan deterministic up, down, up-down, or seeded-random arpeggiation of complete chord onsets.", inputSchema: object(midiChordArpeggiationProperties, ["trackId", "clipId", "noteIds", "mode", "stepBeats", "gate", "seed"]) },
  apply_midi_chord_arpeggiation: { description: "Plan or apply guarded chord arpeggiation with stable native note IDs and complete readback verification.", inputSchema: guarded(midiChordArpeggiationProperties, ["trackId", "clipId", "noteIds", "mode", "stepBeats", "gate", "seed"]) },
  plan_midi_transposition: { description: "Plan exact chromatic transposition of stable MIDI note IDs while preserving all non-pitch note state.", inputSchema: object(midiTranspositionProperties, ["trackId", "clipId", "noteIds", "semitones"]) },
  apply_midi_transposition: { description: "Plan or apply guarded chromatic MIDI transposition with complete native readback verification.", inputSchema: guarded(midiTranspositionProperties, ["trackId", "clipId", "noteIds", "semitones"]) },
  plan_midi_diatonic_transposition: { description: "Plan scale-degree transposition of exact in-scale MIDI note IDs using Live's current key and scale.", inputSchema: object(midiDiatonicTranspositionProperties, ["trackId", "clipId", "noteIds", "scaleSteps"]) },
  apply_midi_diatonic_transposition: { description: "Plan or apply guarded scale-degree MIDI transposition bound to Live's current key and scale.", inputSchema: guarded(midiDiatonicTranspositionProperties, ["trackId", "clipId", "noteIds", "scaleSteps"]) },
  plan_midi_diatonic_harmony: { description: "Plan literal harmony voices above or below exact in-scale MIDI notes using Live's current key and scale.", inputSchema: object(midiDiatonicHarmonyProperties, ["trackId", "clipId", "noteIds", "degreeOffsets"]) },
  apply_midi_diatonic_harmony: { description: "Plan or apply guarded scale-aware harmony additions while preserving source notes and expression.", inputSchema: guarded(midiDiatonicHarmonyProperties, ["trackId", "clipId", "noteIds", "degreeOffsets"]) },
  plan_midi_scale_chord_remapping: { description: "Plan complete chord onsets onto explicit degrees of Live's current scale while preserving chord intervals and expression.", inputSchema: object(midiScaleChordRemappingProperties, ["trackId", "clipId", "noteIds", "targetDegrees", "mode"]) },
  apply_midi_scale_chord_remapping: { description: "Plan or apply guarded scale-aware chord remapping with optional bass voice leading and complete native readback.", inputSchema: guarded(midiScaleChordRemappingProperties, ["trackId", "clipId", "noteIds", "targetDegrees", "mode"]) },
  plan_midi_diatonic_chord_quality: { description: "Plan complete selected onsets as scale-native, secondary-dominant, parallel-minor borrowed, suspended, added-tone, or altered-dominant voicings. Supports per-onset functions, recipes, inversions, voicing modes, and explicit scale-degree slash basses.", inputSchema: midiDiatonicChordQualityInput() },
  apply_midi_diatonic_chord_quality: { description: "Plan or atomically apply guarded functional-harmony chord rebuilding with per-onset functions, recipes, inversions, voicing modes, slash basses, stable retained voices, and verified additions/removals.", inputSchema: midiDiatonicChordQualityInput(true) },
  get_clip_timing: { description: "Read Session/Arrangement loops and markers, plus Session launch modes. Units: MIDI/warped beats, unwarped seconds. Unavailable: supported=false.", inputSchema: clip },
  get_clip_groove_context: { description: "Read one native callback snapshot of exact clip/track names, MIDI note IDs and expression metadata or audio state, clip timing, complete Groove Pool and global musical context. Supports before/after validation of UI-only extraction and baking; does not execute them.", inputSchema: clip },
  analyze_midi_feel: { description: "Measure stored MIDI timing/velocity by grid slot over 1–8 clip-meter bars, with optional exact notes and cycle origin. Defaults: all notes, beat zero. Read-only; assigned native groove playback is not measured or extracted.", inputSchema: object({ trackId: ids.trackId, clipId: ids.clipId, grid: { type: "string", enum: ["straight16", "eighthTriplet", "sixteenthTriplet"] }, bars: { type: "integer", minimum: 1, maximum: 8, description: "Number of clip-meter bars in the repeating analysis cycle; defaults to one." }, originBeats: feelOrigin, noteIds: feelSourceNoteIds }, ["trackId", "clipId", "grid"]) },
  save_midi_feel_template: { description: "Analyze exact MIDI notes with an optional cycle origin and save a private named timing/velocity template. Never overwrites. Rejects assigned native grooves; does not capture their playback effects.", inputSchema: object({ name: string("New local template name; letters, numbers, dot, underscore and hyphen only."), trackId: ids.trackId, clipId: ids.clipId, grid: { type: "string", enum: ["straight16", "eighthTriplet", "sixteenthTriplet"] }, bars: { type: "integer", minimum: 1, maximum: 8 }, originBeats: feelOrigin, noteIds: feelSourceNoteIds }, ["name", "trackId", "clipId", "grid"]) },
  load_midi_feel_template: { description: "Load a named stored-MIDI feel template from the private local library for review or guarded transfer. Does not change Live or retrieve native Groove Pool patterns.", inputSchema: object({ name: string("Exact saved MIDI feel template name.") }, ["name"]) },
  apply_midi_feel_template: { description: "Plan or transfer a stored-MIDI feel template or measured source-audio feel summary onto exact target note IDs. MIDI templates support timing and velocity blends; audio feel is timing-only and requires velocityAmount zero because audio strength is not MIDI velocity. Preserves note IDs, durations and expression metadata through guarded per-note edits. Rejects a target with an assigned native groove; this is not Live Groove Pool baking.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, template: { oneOf: [midiFeelTemplate, audioFeelTemplate] },
    timingAmount: number("Blend toward template timing; zero preserves each target start.", { minimum: 0, maximum: 1 }),
    velocityAmount: number("Blend toward template mean velocity; zero preserves each target velocity.", { minimum: 0, maximum: 1 }),
    noteIds: { ...array({ type: "integer" }, "Optional exact target note IDs; omit to transfer to all notes at populated slots."), minItems: 1, maxItems: 4096, uniqueItems: true }, originBeats: feelOrigin
  }, ["trackId", "clipId", "template", "timingAmount", "velocityAmount"]) },
  inspect_clip_groove_postconditions: { description: "Read current native context and inspect extraction, baking, or plain groove-removal postconditions against a supplied pre-action get_clip_groove_context snapshot. Does not execute the UI action, prove provenance, or validate audible equivalence. Extraction expects one appended groove and unchanged source/timing; baking expects removed assignment and unchanged unrelated timing/shared context; removal also requires unchanged source content.", inputSchema: object({ ...clip.properties, operation: { type: "string", enum: ["bake", "extract", "remove"] }, before: { type: "object", description: "Complete pre-action native clip groove context snapshot; supplied data is not authenticated history." } }, ["trackId", "clipId", "operation", "before"]) },
  set_clip_timing: { description: "Guarded loop, meter, launch, Session Legato, mute, groove and grid edits.", inputSchema: guarded({
    trackId: ids.trackId, clipId: ids.clipId,
    loop: object({ enabled: boolean("Clip loop enabled."), startBeats: number("Beat start; MIDI/warped audio.", { minimum: 0 }), endBeats: number("Beat end; MIDI/warped audio.", { exclusiveMinimum: 0 }), startSeconds: number("Second start; unwarped audio.", { minimum: 0 }), endSeconds: number("Second end; unwarped audio.", { exclusiveMinimum: 0 }) }),
    timeSignature: object({ numerator: { type: "integer", minimum: 1 }, denominator: { type: "integer", enum: [1, 2, 4, 8, 16] } }),
    launchMode: choice("Session launch choice."), launchQuantization: choice("Launch quantization value or name."), launchLegato: boolean("Session Legato launch."), mute: boolean("Native clip mute."), grooveId: {type: ["string", "null"], description: "ID assigns. Null removes in macOS Clip View: saved Set, unique clip name, sole edit. Selects clip; updated bridge."},
    editorGrid: object({ quantization: choice("Editor-grid choice from get_clip_timing."), isTriplet: boolean("Display clip-editor triplets.") }),
  }, ["trackId", "clipId"]) },
  get_audio_clip_state: { description: "Read Session/Arrangement gain, pitch, warp, markers and fade-switch availability; includes Arrangement timeline identity. Unsupported fades report supported=false.", inputSchema: clip },
  get_audio_source_beat_times: { description: "Read native warped clip-beat positions for source-audio seconds. Uses Live's sample-to-beat converter, not interpolation from sparse warp markers; does not edit the clip.", inputSchema: object({ trackId: ids.trackId, clipId: ids.clipId, sourceSeconds: { ...array(number("Source-file seconds.", { minimum: 0 }), "Source times to convert, in order."), minItems: 1, maxItems: 256 } }, ["trackId", "clipId", "sourceSeconds"]) },
  propose_audio_transient_warp: { description: "Analyze bounded source-audio onset candidates and propose review-only marker actions toward a beat grid using native Live source-to-beat conversion. Reports signed offsets and one-hop detector resolution in beats for every candidate; suppresses actions within that resolution or competing with a closer onset at the same slot. Optional musical roles label bars, downbeats, quarter pulses and half-beat upbeats from the clip meter. Optional feelBars aggregates one to eight bars of selected onset timing and strength by grid slot; this is not native Groove Pool extraction or baking. Heuristic, source-only, no edit or audible validation; individually dry-run actions against current state before applying.", inputSchema: object({ trackId: ids.trackId, clipId: ids.clipId, gridBeats: number("Positive beat-grid spacing, e.g. 0.5 for eighth notes.", { exclusiveMinimum: 0, maximum: 16 }), startSeconds: number("Source window start.", { minimum: 0 }), durationSeconds: number("Source window duration; defaults to 10 seconds.", { exclusiveMinimum: 0, maximum: 60 }), channelIndex: { type: "integer", minimum: 0, description: "Zero-based source channel; defaults to zero." }, includeMusicalRoles: boolean("Label each nearest grid slot by clip-meter bar and pulse role; requires a grid that divides one bar."), feelBars: { type: "integer", minimum: 1, maximum: 8, description: "Aggregate selected onset offsets and strengths over a repeating one-to-eight-bar clip-meter cycle; grid must divide a bar." } }, ["trackId", "clipId", "gridBeats"]) },
  set_audio_clip_state: { description: "Plan or apply guarded audio-clip gain, pitch offsets, warp, and marker changes. Use beats for warped clips and seconds for unwarped clips; change warping separately from markers.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, gain: number("Clip gain."), pitchCoarse: { type: "integer", minimum: -48, maximum: 48 }, pitchFine: { type: "integer", minimum: -50, maximum: 50 }, warping: boolean("Warp enabled."), warpMode: choice("Warp mode value or name."), startMarkerBeats: number("Warped start marker in beats.", { minimum: 0 }), endMarkerBeats: number("Warped end marker in beats.", { minimum: 0 }), startMarkerSeconds: number("Unwarped start marker in seconds.", { minimum: 0 }), endMarkerSeconds: number("Unwarped end marker in seconds.", { minimum: 0 }) }, ["trackId", "clipId"]) },
  apply_monophonic_audio_tuning: { description: "Plan or apply an exact Live clip coarse/fine pitch offset from full-source, stable monophonic analysis of a mono or stereo local source at most 60 seconds long. Every stereo channel must agree; confirmation binds a SHA-256 source hash and current clip state, then verifies native pitch readback. Whole-clip tuning only: not note-by-note vocal correction, rendered audio analysis, or audible validation.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, targetMidiNote: { type: "integer", minimum: 0, maximum: 127, description: "Explicit equal-tempered target note at A4=440 Hz." } }, ["trackId", "clipId", "targetMidiNote"]) },
  duplicate_clip: { description: "Copy a Session audio/MIDI clip into an empty compatible track slot. Destination defaults to source track. Rechecks both owners and clip content, verifies the copy and cleans up only a confirmed new copy. Envelope retargeting/hidden state not verified; audio shares its file. Updated bridge required.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, destinationTrackId: string("Destination ordinary track ID; defaults to trackId. Must accept the source clip kind."), destinationClipId: ids.clipId, name: string("Optional copy name.", { minLength: 1, maxLength: 128 }) }, ["trackId", "clipId", "destinationClipId"]) },
  plan_audio_midi_sketch: {description: "Propose approximate monophonic source-audio MIDI notes in native warped clip beats. Uses current loop/markers or an explicit region, 0.256–30 seconds, one selected channel and assigned uniform velocity. Does not render clip pitch, groove or effects, change audio, or create MIDI.",inputSchema:object({trackId:ids.trackId,clipId:ids.clipId,startBeats:number("Optional explicit clip-beat region start; requires endBeats."),endBeats:number("Explicit clip-beat end; at most 256 quarter-note beats."),channelIndex:{type:"integer",minimum:0,description:"Selected source channel, zero-based; defaults to 0."},velocity:{type:"integer",minimum:1,maximum:127,description:"Uniform assigned velocity, default 100; not measured dynamics."}},["trackId","clipId"])},
  analyze_audio_file: { description: "Measure local source loudness, true peak, format, and optional spectrum, spectrogram, monophonic pitch or note events. A target note proposes a review-only whole-clip offset for stable monophonic windows; no edits or correction of changing notes. Loudness uses the source stream; optional analyses use the selected channel. Excludes Live processing. Requires ffmpeg/ffprobe.", inputSchema: object({ channelIndex: { type: "integer", minimum: 0, description: "Source channel for optional analyses; zero-based, default 0." }, targetMidiNote: { type: "integer", minimum: 0, maximum: 127, description: "MIDI reference at A4=440 Hz; enables monophonic pitch analysis, not correction." }, includeResonanceCandidates: boolean("Narrow spectral features persisting across 4+ frames; heuristic, not confirmed resonances or EQ advice."), includeWaveform: boolean("Up to 1024 contiguous channel min/max/RMS buckets at 48 kHz."), includeTransients: boolean("Channel onset candidates at 10-ms resolution; not Live warp/slice markers."), sourcePath: string("Absolute local audio file."), includeSpectrogram: boolean("Up to 64 spectral frames at 48 kHz."), includePitchEvents: boolean("Approximate monophonic channel note events for review; no correction."), includePitch: boolean("Monophonic channel pitch in overlapping 256-ms frames; requires 256+ ms."), includeSpectrum: boolean("One 4096-sample spectral frame at window start."), startSeconds: number("Window start.", { minimum: 0 }), durationSeconds: number("Window duration, defaults to 10 seconds.", { exclusiveMinimum: 0, maximum: 60 }) }, ["sourcePath"]) },
  analyze_audio_clip: { description: "Measure a Session or Arrangement clip's local source window, with optional approximate note events. A target note proposes absolute clip pitch accounting for current pitch settings for stable monophonic windows; review only, no edits or correction of changing notes. Loudness uses the source stream; optional analyses use the selected channel. Excludes rendered clip/track audio.", inputSchema: object({ channelIndex: { type: "integer", minimum: 0, description: "Source channel for optional analyses; zero-based, default 0." }, targetMidiNote: { type: "integer", minimum: 0, maximum: 127, description: "MIDI reference at A4=440 Hz; enables monophonic pitch analysis, not correction." }, includeResonanceCandidates: boolean("Narrow spectral features persisting across 4+ frames; heuristic, not confirmed resonances or EQ advice."), includeWaveform: boolean("Up to 1024 contiguous channel min/max/RMS buckets at 48 kHz."), includeTransients: boolean("Channel onset candidates at 10-ms resolution; not Live warp/slice markers."), trackId: ids.trackId, clipId: ids.clipId, includeSpectrogram: boolean("Up to 64 channel spectral frames at 48 kHz."), includePitchEvents: boolean("Approximate monophonic channel note events for review; no correction."), includePitch: boolean("Monophonic channel pitch in overlapping 256-ms frames; no correction."), includeSpectrum: boolean("One channel spectral frame of 4096 samples."), startSeconds: number("Source window start.", { minimum: 0 }), durationSeconds: number("Source window duration, defaults to 10 seconds.", { exclusiveMinimum: 0, maximum: 60 }) }, ["trackId", "clipId"]) },
  delete_clip: { description: "Plan or delete one exact occupied Session clip.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]) },
  duplicate_clip_loop: { description: "Plan or duplicate the current loop region of one exact clip.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]) },
  get_automation_capabilities: { description: "Report exact supported and unsupported automation and per-note expression surfaces.", inputSchema: empty },
  get_track_mixer: { description: "Read bounded track volume, pan, mute, solo, and named return sends.", inputSchema: track },
  get_track_signal_activity: { description: "Read native input/output peak-hold meters and control flags for one trackId, or 1-64 unique trackIds in one callback with shared transport and ordered tracks. Track, Group, Return and Main supported. Native 0–1; not dB, sample-synchronous audio, silence or speaker proof. Unavailable meters stay unknown. No edits; all profile.", inputSchema: {
    ...object({trackId: ids.deviceOwnerId, trackIds: {type: "array", items: ids.deviceOwnerId, minItems: 1, maxItems: 64, uniqueItems: true, description: "Exact track/Group/Return/Main IDs in requested order; excludes trackId."}}),
    oneOf: [{required: ["trackId"], properties: {trackId: {}}}, {required: ["trackIds"], properties: {trackIds: {}}}]
  } },
  get_track_routing: { description: "Read exact input, output, and monitoring choices for one track. Group Tracks expose monitoring as null because Live does not support it.", inputSchema: track },
  set_track_routing: { description: "Plan or apply guarded track routing and monitoring changes by exact choice ID.", inputSchema: guarded({ trackId: ids.trackId, inputTypeId: string("Input routing type ID."), inputChannelId: string("Input routing channel ID."), outputTypeId: string("Output routing type ID."), outputChannelId: string("Output routing channel ID."), monitoring: choice("Monitoring mode value or name.") }, ["trackId"]) },
  set_group_fold_state: { description: "Plan or apply the folded state of one exact existing group track.", inputSchema: guarded({ trackId: ids.trackId, folded: boolean("Whether the group is folded.") }, ["trackId", "folded"]) },
  route_tracks_to_bus: { description: "Plan or route existing tracks to one exact existing group bus using Live's available routing choices.", inputSchema: guarded({ trackIds: array(ids.trackId, "Source track IDs."), busTrackId: ids.trackId }, ["trackIds", "busTrackId"]) },
  route_tracks_to_return_bus: { description: "Plan or route existing tracks to one exact Return bus using matching sends and Sends Only outputs. Prevalidates all sources; Live applies one undo step but runtime failures can interrupt it.", inputSchema: guarded({ trackIds: array(ids.trackId, "Source track IDs."), returnTrackId: string("Stable return-track ID."), sendValue: number("Normalized send level (0 to 1).", { minimum: 0, maximum: 1 }) }, ["trackIds", "returnTrackId", "sendValue"]) },
  get_set_mixer: { description: "Read master and return-bus mixer levels, sends, and routing from the current Live Set.", inputSchema: empty },
  get_return_routing: {description:'Read the exact output destination and available choices of one Return Track without changing routing, selection or playback. Reports unavailable native properties explicitly; send pre/post mode is not exposed.',inputSchema:object({returnTrackId:string('Canonical return-N ID from get_set_mixer.')},['returnTrackId'])},
  list_arrangement_clips: { description: "Read timeline clip IDs, types, and start/end positions in beats for one track.", inputSchema: object({ trackId: ids.trackId }, ["trackId"]) },
  create_audio_clip: { description: "Plan/import local audio into an empty Session slot on an unfrozen audio track. Binds source identity, size and mtime; Live validates format.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, sourcePath: string("Absolute local audio-file path."), name: string("Optional imported clip name.") }, ["trackId", "clipId", "sourcePath"]) },
  move_arrangement_clip: { description: "Plan or move one exact Arrangement clip to a new beat position, preserving its span with staged copies, rollback, and an isolated undo step. Rejects collisions with other clips; self-overlap is supported.", inputSchema: guarded({ trackId: ids.trackId, clipId: string("Exact timeline clip ID from list_arrangement_clips."), startBeats: number("New nonnegative timeline position in beats.", { minimum: 0 }) }, ["trackId", "clipId", "startBeats"]) },
  duplicate_arrangement_clip: { description: "Plan or duplicate one exact Arrangement clip at a non-overlapping beat position on the same track. Preserves the source and validates its identity again at the native write boundary.", inputSchema: guarded({ trackId: ids.trackId, clipId: string("Exact source timeline clip ID from list_arrangement_clips."), startBeats: number("Nonnegative destination position in beats.", { minimum: 0 }) }, ["trackId", "clipId", "startBeats"]) },
  delete_arrangement_clip: { description: "Plan or delete one exact Arrangement clip, preserving other timeline material. Requires current clip identity and confirmation; deletion is undoable in Live.", inputSchema: guarded({ trackId: ids.trackId, clipId: string("Exact timeline clip ID returned by list_arrangement_clips.") }, ["trackId", "clipId"]) },
  place_session_clip_in_arrangement: { description: "Plan/copy a Session clip onto its own Arrangement track. Updated bridge binds source identity and notes/timing or audio settings; excludes file bytes and automation. Rejects overlap and verifies interval. Limits: 4096 source notes and 4096 timeline clips. Refuses frozen, recording, pending-launch or unwarped sources.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, startBeats: number("Nonnegative Arrangement start in beats.", { minimum: 0 }) }, ["trackId", "clipId", "startBeats"]) },
  move_device: { description: "Plan or reorder one exact device within its current ordinary, Return, Main, or rack chain. Live may choose the nearest valid position; read actualPosition and the new device ID from the result.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, targetPosition: { type: "integer", minimum: 0, description: "Device-chain insertion index; zero is first." } }, ["trackId", "deviceId", "targetPosition"]) },
  set_master_mixer: { description: "Plan or apply master mixer and available hardware output-channel changes. The native write rechecks the signed mixer state, validates bounded values, and groups all writes in one undo step with rollback on failure.", inputSchema: guarded({ outputChannelId: string("Exact available master output channel ID from get_set_mixer."), volume: number("Master volume."), pan: number("Master pan.", { minimum: -1, maximum: 1 }), cueVolume: number("Cue volume."), crossfader: number("Crossfader position.", { minimum: -1, maximum: 1 }) }) },
  set_return_mixer: { description: "Plan or apply return-bus volume, pan, mute, or solo changes. The native write rechecks the complete signed Return state and groups changes in one undo step with rollback on failure.", inputSchema: guarded({ returnTrackId: string("Stable return-track ID."), volume: number("Return volume."), pan: number("Return pan.", { minimum: -1, maximum: 1 }), mute: boolean("Mute return."), solo: boolean("Solo return.") }, ["returnTrackId"]) },
  list_factory_device_profiles: { description: "List producer-oriented knowledge profiles for foundational Ableton factory devices.", inputSchema: empty },
  get_factory_device_context: { description: "Read native parameters, matched factory knowledge and group coverage. Auto Shift includes song key, Scale Aware, manual Root/Scale and selected scale source; no proof of audible correction. Includes configured plug-in controls or exposed/enabled Max for Live parameter IDs and duplicate-name warnings. Excludes hidden plug-in state, Max patch internals and modulation targets.", inputSchema: device },
  get_plugin_integration_context: { description: "Inspect loaded Serum 2/Omnisphere/VPS Avenger: installed variants, controls, NKS counts, browser limits and Live UI save/User Library load. Loading in Live does not verify hidden plug-in state.", inputSchema: device },
  get_looper_export_context: {description: "Read native Looper export capability, buffer length, state and an exact destination slot without changing focus or playback. Buffer audio bytes are unavailable.", inputSchema: object({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,destinationTrackId:ids.trackId,destinationClipId:ids.clipId},["trackId","deviceId","destinationTrackId","destinationClipId"])},
  export_looper_clip: {description: "Export a fixed nonempty native Looper buffer into an empty unarmed audio Session slot. Binds exposed context and native identities; never launches, clears Looper or overwrites a clip. Partial material is retained. Buffer audio equivalence is not verified.", inputSchema: guarded({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,destinationTrackId:ids.trackId,destinationClipId:ids.clipId,name:string("Optional new clip name.",{minLength:1,maxLength:128})},["trackId","deviceId","destinationTrackId","destinationClipId"])},
  get_rack_performance_context: { description: "Read one native snapshot of visible rack macros, exact mapped descendant parameters, ranges, current values, automation and variation count/index. Unresolved mappings and unknown layouts are explicit. Saved variation contents and audible results are unavailable.", inputSchema: device },
  get_looper_performance_context: { description: "Read one native snapshot of a loaded Looper's State, Quantization, Monitor, Song Control, Tempo Control, all exposed parameters, global clip-launch quantization, track input/output routing, monitoring, and transport. Read-only; source readiness and audible outcome are not inferred.", inputSchema: device },
  get_beat_repeat_performance_context: { description: "Read one native snapshot of a loaded Beat Repeat's Repeat, Grid, Interval, Block Triplets, Mix Type, all exposed parameters and their display values, track routing, monitoring, and transport. Grid and Interval expose labels at their native integer positions; duplicate labels are not assumed equivalent, and quantized behavior is not inferred from this mapping. Read-only; no audible outcome is inferred.", inputSchema: device },
  get_factory_browser_items: { description: "Browse one exact level of a Live factory browser root; optional offset and limit return a bounded child page. Optionally join private MCP tags and favorites for exact child identities, not native Live collections.", inputSchema: object({ root: string("Factory browser root."), path: array(string("Exact browser path segment."), "Path below the root."), offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 }, includeMetadata: boolean("Join private MCP tags and favorites for children with exact URIs.") }, ["root"]) },
  load_factory_browser_item: { description: "Guarded factory-item load on ordinary/Return/Main tracks. Binds native item and Set topology. Reports device, clip and track effects, rebased IDs and partial errors; observations are immediate.", inputSchema: guarded({ trackId: ids.deviceOwnerId, root: string("Factory browser root."), path: array(string("Exact browser path segment."), "Path to the loadable item.") }, ["trackId", "root", "path"]) },
  list_browser_roots: { description: "List Live's general browser roots with observed availability and immediate child counts. Read-only; this is not Splice cloud search or a filesystem inventory.", inputSchema: empty },
  search_browser_roots: { description: "Search selected/all available Live roots in order. Returns exact root/path, unavailable roots and result/scan truncation. Optional private MCP tags/favorites match root/path/URI; not native collections or Splice cloud.", inputSchema: object({ roots: array(string("Live browser root from list_browser_roots."), "Optional roots to search in order; omit for all general roots."), query: string("Case-insensitive item-name query."), maxDepth: { type: "integer", minimum: 1, maximum: 16 }, limit: { type: "integer", minimum: 1, maximum: 200 }, maxVisited: { type: "integer", minimum: 1, maximum: 50000, description: "Maximum child items to inspect across selected roots; defaults to 10000." }, includeMetadata: boolean("Include private MCP tags and favorites for results with an exact URI.") }, ["query"]) },
  get_browser_items: { description: "Browse one level of Live factory/plug-in/Pack/Max/project/user content. Page with offset and limit together. Optional private MCP tags/favorites use exact child identities; not native collections.", inputSchema: object({ root: string("Live browser root."), path: array(string("Exact browser path segment."), "Path below the root."), offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 }, includeMetadata: boolean("Join private MCP tags and favorites for children with exact URIs.") }, ["root"]) },
  load_browser_item: { description: "Plan/load an exact browser item on ordinary/Return/Main tracks. Binds native item and Set topology. Reports device, clip and track effects, rebased IDs and partial errors. MIDI may create tracks; observations are immediate.", inputSchema: guarded({ trackId: ids.deviceOwnerId, root: string("Live browser root."), path: array(string("Exact browser path segment."), "Path to the loadable item.") }, ["trackId", "root", "path"]) },
  search_browser_items: { description: "Search a bounded subtree of Live's browser and return exact paths usable by load_browser_item. Optionally join private MCP tags and favorites by exact root, path, and URI; not native Live collections.", inputSchema: object({ root: string("Live browser root."), path: array(string("Exact browser path segment."), "Optional subtree path."), query: string("Case-insensitive item-name query."), maxDepth: { type: "integer", minimum: 1, maximum: 16 }, limit: { type: "integer", minimum: 1, maximum: 200 }, includeMetadata: boolean("Join private MCP tags and favorites for results with an exact URI.") }, ["root", "query"]) },
  list_local_splice_roots: { description: "List existing local Splice folders and cache paths, including detected macOS defaults and explicitly configured roots. Does not search Splice cloud assets, verify licenses, or download files.", inputSchema: empty },
  browse_local_splice_directory: { description: "Page through immediate subfolders and audio files inside a configured local Splice root. Optionally join private MCP tags and favorites for audio files. Returned folder paths can be searched individually when a broad search is truncated. Skips symlinks and non-audio files; not Splice cloud browsing, downloads, or license verification.", inputSchema: object({ rootPath: string("Absolute configured Splice root or descendant folder returned by this tool."), offset: { type: "integer", minimum: 0, description: "Zero-based entry offset; defaults to zero." }, limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum entries per page; defaults to 100." }, includeMetadata: boolean("Include private MCP tags and favorites for audio-file entries.") }, ["rootPath"]) },
  search_local_splice_samples: { description: "Search existing local Splice audio files by filename/folder, private favorite state and/or private tags. Query is optional when a metadata filter is supplied. Filtering happens before pagination; visited and truncated report an incomplete bounded scan. Private metadata is not a native Splice collection; no cloud search, license verification, download, or sync.", inputSchema: object({ rootPath: string("Absolute local Splice asset directory."), query: string("Optional case-insensitive audio filename or relative-path query; required without metadata filters."), favorite: boolean("Optional private favorite state filter."), tags: array(string("Required private user tag."), "Require every supplied tag."), maxDepth: { type: "integer", minimum: 1, maximum: 16 }, offset: { type: "integer", minimum: 0, description: "Zero-based match offset for deterministic pagination; defaults to zero." }, limit: { type: "integer", minimum: 1, maximum: 200 }, maxVisited: { type: "integer", minimum: 1, maximum: 50000, description: "Maximum directory entries to inspect; defaults to 50000. A truncated result is incomplete." }, includeMetadata: boolean("Include private MCP tags and favorites for matching local files.") }, ["rootPath"]) },
  get_device_hierarchy: { description: "Read rack chains/mixers, populated Drum Rack pads and macro/variation state. Available macro_mappings include displayed target path, parameter and min/max; paths are descriptive, not stable IDs. Variation contents are unavailable.", inputSchema: device },
  set_rack_chain_note_routing: { description: "Plan or reassign a Drum Rack chain to a MIDI pad note and optionally change its instrument output note. Occupied destinations layer chains rather than replace sounds.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, chainId: string("Exact rack chain ID."), inputNote: { type: "integer", minimum: 0, maximum: 127 }, outputNote: { type: "integer", minimum: 0, maximum: 127 } }, ["trackId", "deviceId", "chainId"]) },
  set_drum_pad_state: { description: "Plan or mute/solo an exact populated Drum Rack pad by MIDI note with a guarded rack snapshot. Does not assign sounds to pads.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, note: { type: "integer", minimum: 0, maximum: 127 }, mute: boolean("Mute pad."), solo: boolean("Solo pad.") }, ["trackId", "deviceId", "note"]) },
  rename_rack_chain: { description: "Plan or rename an exact rack chain with a guarded hierarchy snapshot. For return chains, name is a raw label; Live adds the return letter prefix. Use observed name for display, not verbatim restoration.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, chainId: string("Exact chain ID."), name: string("New layer name; raw unprefixed label for returns.") }, ["trackId", "deviceId", "chainId", "name"]) },
  set_rack_chain_mixer: { description: "Plan or apply exact rack-chain volume, pan, mute, solo, and send levels using native ranges and guarded hierarchy state.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, chainId: string("Exact chain ID from device hierarchy."), volume: number("Native chain volume value, not decibels."), pan: number("Native chain pan value."), mute: boolean("Mute chain."), solo: boolean("Solo chain."), sends: array(object({ index: { type: "integer", minimum: 0 }, value: number("Native send level within observed bounds.") }, ["index", "value"]), "Exact native rack send indices and levels.") }, ["trackId", "deviceId", "chainId"]) },
  move_device_to_chain: { description: "Plan or move an exact device into a rack chain across ordinary, Return, or Main tracks, including nested destinations. Live may choose the nearest valid position; use the returned device ID and actualPosition.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, targetTrackId: ids.deviceOwnerId, targetChainId: string("Exact chain ID from device hierarchy."), targetPosition: { type: "integer", minimum: 0 } }, ["trackId", "deviceId", "targetTrackId", "targetChainId", "targetPosition"]) },
  create_rack_chain: { description: "Plan or create a named empty chain in an exact rack on an ordinary, Return, or Main track, including nested racks. Omitted index appends. Drum-pad assignment is separate.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, index: { type: "integer", minimum: 0 }, name: string("New chain name.") }, ["trackId", "deviceId", "name"]) },
  adjust_rack_macro_count: { description: "Plan or invoke one native add/remove macro action on an exact rack, then report the observed count. Removal is refused while any macro mapping exists because Live does not expose the affected mapping target.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, action: { type: "string", enum: ["add", "remove"], description: "One native macro-count adjustment." } }, ["trackId", "deviceId", "action"]) },
  map_rack_macro_to_parameter: { description: "Plan or create one native macro mapping to an exact descendant device parameter. Rechecks rack and target-parameter snapshots at the native boundary, then reads back the observed mapping. Live chooses the default mapping range; inspect the result.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, targetDeviceId: ids.deviceId, parameterId: ids.parameterId, macroIndex: { type: "integer", minimum: 0, description: "Zero-based visible rack macro index." } }, ["trackId", "deviceId", "targetDeviceId", "parameterId", "macroIndex"]) },
  set_rack_macro_mapping_edge: { description: "Plan or change one native min or max endpoint of a rack macro with exactly one observed nonquantized mapping. Value is in the target parameter's native range. Rechecks the full rack snapshot and reads back the result; reversed ranges are possible.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, macroIndex: { type: "integer", minimum: 0, description: "Zero-based visible rack macro index." }, edge: { type: "string", enum: ["min", "max"] }, value: number("New endpoint value in the mapped parameter's native units.") }, ["trackId", "deviceId", "macroIndex", "edge", "value"]) },
  rename_rack_macro: { description: "Plan or rename one exact rack macro when Live exposes an unambiguous macro parameter layout and name readback. Rechecks the full rack snapshot and confirms the observed name after the native write.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, macroIndex: { type: "integer", minimum: 0, description: "Zero-based visible rack macro index." }, name: string("New macro name.") }, ["trackId", "deviceId", "macroIndex", "name"]) },
  store_rack_macro_variation: { description: "Plan or store a new native variation of mapped rack macros. Binds exact rack and parameter state, reports the observed count and appended storedVariationIndex independently of selection; variation contents are not exposed by Live's API.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId }, ["trackId", "deviceId"]) },
  recall_rack_macro_variation: { description: "Plan or recall one existing rack macro variation by zero-based index. Binds exact rack and current parameter state; Live exposes observed values after recall, not the saved variation contents beforehand.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, variationIndex: { type: "integer", minimum: 0 } }, ["trackId", "deviceId", "variationIndex"]) },
  delete_rack_macro_variation: { description: "Plan or delete one exact zero-based rack macro variation. Destructive: Live does not expose saved variation contents for preview or reconstruction. Requires confirmation and reports observed count.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, variationIndex: { type: "integer", minimum: 0 } }, ["trackId", "deviceId", "variationIndex"]) },
  randomize_rack_macros: { description: "Plan or invoke Live's native randomization of eligible mapped rack macros. Binds exact rack and parameter state, then reports observed values. No seed or predictable outcome is available.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId }, ["trackId", "deviceId"]) },
  get_clip_parameter_envelope: { description: "Sample one Session clip parameter envelope at exact beat positions.", inputSchema: object({ trackId: ids.trackId, clipId: ids.clipId, deviceId: ids.deviceId, parameterId: ids.parameterId, sampleTimes: array(number("Beat position.", { minimum: 0 }), "Beat positions to sample.") }, ["trackId", "clipId", "deviceId", "parameterId"]) },
  get_clip_mixer_envelope: {description:'Read an ordinary Session clip volume, Stereo pan or exact Return-send envelope without changing focus or playback. MIDI/warped audio beats. Pan requires known Stereo mode. Samples do not recover the complete curve.',inputSchema:object({...mixerEnvelopeTarget,sampleTimes:{...array(number('Absolute clip beat position.',{minimum:0}),'Optional native probes.'),maxItems:512}},['trackId','clipId','mixerControl'])},
  list_devices: { description: "List loaded devices on one exact ordinary, Return, or Main track.", inputSchema: object({ trackId: ids.deviceOwnerId }, ["trackId"]) },
  get_device_sidechain_routing: { description: "Read exact native external-sidechain source type and channel choices for one loaded device. Reports unsupported explicitly; does not confuse device-sidechain routing with track input routing.", inputSchema: device },
  set_device_sidechain_routing: { description: "Plan or apply one guarded native device-sidechain source type or channel change. Read refreshed channels after changing source type. Rejects unsupported devices and ambiguous choices; does not enable external sidechain automatically.", inputSchema: guarded({ ...device.properties, sourceTypeId: string("Exact available sidechain source type ID."), sourceChannelId: string("Exact available sidechain channel ID.") }, ["trackId", "deviceId"]) },
  crop_audio_clip: { description: "Plan or apply Live native cropping of one exact audio clip. Preview reports the selected loop interval when enabled, otherwise start/end markers, in current units. Live may retain pre-loop playback material and creates a processed source. Selected interval is not a guarantee of exclusive source-file bounds. Binds audio and loop state and reads back native results.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]) },
  quantize_audio_clip: { description: "Plan or request Live native quantization for one warped audio clip at a selected grid, amount, and observed global swing. Dry runs warn that Live may insert many warp markers and shift existing source start/end anchors; duplicate the clip first if the original edit must be preserved. Returns native anchors and a measured before/after marker-change summary; an existing marker is not guaranteed to snap to the grid. Use move_audio_warp_marker for an exact anchor move. Requires unchanged audio state and swing. Does not quantize MIDI note ends.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, grid: { type: "string", enum: ["1_4", "1_8", "1_8_triplet", "1_8_and_triplet", "1_16", "1_16_triplet", "1_16_and_triplet", "1_32"] }, amount: number("Quantization amount, zero to one.", { minimum: 0, maximum: 1 }) }, ["trackId", "clipId", "grid", "amount"]) },
  set_device_active: { description: "Plan or set the active state of one exact loaded device on an ordinary, Return, or Main track.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, active: boolean("Requested active state.") }, ["trackId", "deviceId", "active"]) },
  delete_device: { description: "Plan or delete one exact loaded device from an ordinary, Return, Main, or rack chain.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId }, ["trackId", "deviceId"]) },
  move_audio_warp_marker: { description: "Plan or apply movement of an exact audio warp marker to a target beat. Preserves sample position; rejects neighbor crossing and the hidden terminal marker.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, beatTime: number("Exact current marker beat time from audio state."), targetBeatTime: number("Requested target beat time.") }, ["trackId", "clipId", "beatTime", "targetBeatTime"]) },
  remove_audio_warp_marker: { description: "Plan or apply deletion of an exact visible audio warp marker. Rejects the hidden terminal marker and stale clip state.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, beatTime: number("Exact marker beat time from audio state.") }, ["trackId", "clipId", "beatTime"]) },
  add_audio_warp_marker: { description: "Plan or apply an audio warp anchor. Omit sampleTime to preserve playback timing; explicit sample positions are seconds. Live enforces sample bounds, neighbor ordering, and segment BPM limits.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, beatTime: number("Anchor beat time."), sampleTime: number("Optional source position in seconds.", { minimum: 0 }) }, ["trackId", "clipId", "beatTime"]) },
  list_device_parameters: { description: "List exact live parameter IDs, values, bounds, labels, and quantized choices.", inputSchema: device },
  set_device_parameters: { description: "Plan/set bounded device parameters on ordinary/Return/Main tracks. Strings select exact unambiguous quantized labels; numbers retain native clamping. Looper State Record/Overdub writes mutate recorded content: restoring a parameter does not restore captured audio.", inputSchema: guarded({ trackId: ids.deviceOwnerId, deviceId: ids.deviceId, changes: array(object({ id: ids.parameterId, value: { oneOf: [{ type: "number" }, { type: "string" }], description: "Native numeric value or exact observed quantized choice label from list_device_parameters." } }, ["id", "value"]), "Parameter changes.") }, ["trackId", "deviceId", "changes"]) },
  set_looper_state: { description: "Plan or request one exact native Looper State choice: Stop, Record, Play, or Overdub. Native execution rechecks the complete Looper, routing, and transport snapshot before writing State; result reports the immediately observed State parameter and whether it matches the target, not an audible or quantized-boundary outcome. Record/Overdub can mutate captured audio and cannot be rolled back by restoring a parameter value. This does not promise beat-scheduled execution; verify native quantization behavior separately.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId, targetState: { type: "string", enum: ["Stop", "Record", "Play", "Overdub"] } }, ["trackId", "deviceId", "targetState"]) },
  set_beat_repeat_enabled: { description: "Plan or request one exact native Beat Repeat Repeat choice, Off or On. Native execution rechecks the complete device, routing, and transport snapshot before writing Repeat and reports its immediately observed value. Does not promise beat-scheduled execution, a captured buffer, or an audible effect.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId, enabled: boolean("Target native Repeat On or Off.") }, ["trackId", "deviceId", "enabled"]) },
  perform_beat_repeat_fill: {description:"Set an existing native Beat Repeat's Repeat On for 0.25–8 requested wall-clock seconds, then release Off on Live display ticks without a client. Requires authorized playback, Repeat Off and no source recording/Repeat automation. Owns only Repeat; manual changes relinquish ownership. No beat timing, bypass or audible-result guarantee. Updated bridge; all profile.",inputSchema:guarded({...device.properties,durationSeconds:number("Requested wall-clock duration, not beat scheduling or a hard real-time bound.",{minimum:.25,maximum:8})},["trackId","deviceId","durationSeconds"])},
  get_beat_repeat_fill: {description:"Read a temporary Repeat fill or list retained handles after reconnect. Reports current native IDs, status, Off observation, historical release verification and cleanup errors. Handles are not saved in the Set.",inputSchema:object({fillId:string("Fill ID from start or listing; omit to list.")})},
  finish_beat_repeat_fill: {description:"Release a terminal fill handle; cancel true attempts owned Repeat Off early. Preserves manual Repeat edits and other controls. Cleanup failure stays explicit; releasing a terminal handle does not repair its device. Updated bridge; all profile.",inputSchema:guarded({fillId:string("Exact retained fill ID."),cancel:boolean("Explicitly end an active fill early; default false.")},["fillId"])},
  set_beat_repeat_grid: { description: "Plan or request one exact native Beat Repeat Grid display division from get_beat_repeat_performance_context.gridChoices. Ambiguous or unavailable display labels fail closed. Native execution rechecks the complete device, routing, and transport snapshot before writing; observed parameter equality is reported, not an audible or beat-scheduled result.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId, gridDisplayValue: string("Exact native Grid display value, for example 1/12.") }, ["trackId", "deviceId", "gridDisplayValue"]) },
  set_beat_repeat_interval: { description: "Plan or request one exact native Beat Repeat Interval display from get_beat_repeat_performance_context.intervalChoices. Native integer-position labels are mapped without assuming a quantized parameter or scheduled trigger. Ambiguous or unavailable labels fail closed; execution rechecks the complete device, routing, and transport snapshot and reports immediately observed parameter equality, not an audible result.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId, intervalDisplayValue: string("Exact native Interval display value, for example 1/2.") }, ["trackId", "deviceId", "intervalDisplayValue"]) },
  create_midi_clip: { description: "Plan or create a MIDI clip in an exact empty Session slot.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, lengthBeats: number("Clip length.", { exclusiveMinimum: 0 }), name: string("Optional clip name."), notes: array(note, "Initial MIDI notes.") }, ["trackId", "clipId", "lengthBeats", "notes"]) },
  set_clip_parameter_envelope: { description: "Plan/set 1–512 ordered Session envelope steps with native context checks and explicit clamping. Existing lanes require replaceExisting:true, which discards the whole curve, including unsampled edits. No full-curve backup or restoration. Playback must be stopped; recording off. Verifies sampled interiors.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, deviceId: ids.deviceId, parameterId: ids.parameterId, replaceExisting:boolean("Explicit authority to discard the entire existing lane, including unsampled points; default false. No complete curve backup."), points:{...array(envelopePoint,"Ordered nonoverlapping envelope steps."),minItems:1,maxItems:512} }, ["trackId", "clipId", "deviceId", "parameterId", "points"]) },
  set_midi_note_properties: { description: "Plan or apply guarded per-note timing, velocity, probability, mute, and pitch changes by stable note ID on one exact Session or Arrangement MIDI clip.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, changes: array(object({ noteId: { type: "integer" }, pitch: { type: "integer", minimum: 0, maximum: 127 }, start: number("Start beat.", { minimum: 0 }), duration: number("Duration.", { exclusiveMinimum: 0 }), velocity: { type: "integer", minimum: 1, maximum: 127 }, velocityDeviation: { type: "integer", minimum: -127, maximum: 127 }, releaseVelocity: { type: "integer", minimum: 0, maximum: 127 }, probability: number("Playback probability.", { minimum: 0, maximum: 1 }), mute: boolean("Mute note.") }, ["noteId"]), "Exact note changes.") }, ["trackId", "clipId", "changes"]) },
  correct_midi_clip_to_scale: { description: "Plan or apply guarded pitch correction of exact chromatic MIDI notes into the current Live scale. Direction is explicit; equal nearest choices require an explicit tie break. Existing in-scale notes are never changed.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, noteIds: { ...array({ type: "integer" }, "Optional stable note IDs; omitted selects every chromatic note."), minItems: 1, uniqueItems: true }, direction: { type: "string", enum: ["nearest", "up", "down"] }, tieBreak: { type: "string", enum: ["up", "down"], description: "Required only for equal nearest choices." } }, ["trackId", "clipId", "direction"]) },
  transform_midi_notes: { description: "Plan or apply guarded quantize, legato, or duplicate transforms to exact MIDI note IDs on one exact Session or Arrangement MIDI clip.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, operation: object({ type: { type: "string", enum: ["quantize", "legato", "duplicate"] }, gridBeats: number("Quantization grid in beats; fractional values support triplets.", { exclusiveMinimum: 0 }), strength: number("Quantization strength.", { minimum: 0, maximum: 1 }), target: { type: "string", enum: ["start", "end", "both"], description: "Quantize absolute note starts, ends, or both; defaults to start." }, quantizeDuration: boolean("Legacy duration-grid quantization; cannot combine with end or both."), gapBeats: number("Legato gap in beats.", { minimum: 0 }), offsetBeats: number("Duplication offset in beats.", { exclusiveMinimum: 0 }), repeats: { type: "integer", minimum: 1, maximum: 16, description: "Duplication repeat count; defaults to one." } }, ["type"]), noteIds: array({ type: "integer" }, "Stable note IDs.") }, ["trackId", "clipId", "operation", "noteIds"]) },
  panic: { description: "Plan or stop Live playback immediately using the guarded panic operation.", inputSchema: guarded() },
  transport_play: { description: "Plan or start Ableton transport playback.", inputSchema: guarded() },
  transport_stop: { description: "Plan or stop Ableton transport playback.", inputSchema: guarded() },
  set_tempo: { description: "Plan or set song tempo within Live's accepted range.", inputSchema: guarded({ tempo: number("Tempo in BPM.", { minimum: 20, maximum: 999 }) }, ["tempo"]) },
  set_track_mixer: { description: "Plan or apply guarded track volume, pan, mute, solo, and return-send changes.", inputSchema: guarded({ trackId: ids.trackId, volume: number("Track volume."), pan: number("Track pan.", { minimum: -1, maximum: 1 }), mute: boolean("Mute track."), solo: boolean("Solo track."), sends: array(object({ id: string("Send ID."), value: number("Send value.") }, ["id", "value"]), "Named return-send changes.") }, ["trackId"]) },
  launch_scene: { description: "Plan/fire a scene with full-row recheck. May stop, record or change tempo/meter. Request-only receipt. Requires updated bridge.", inputSchema: guarded({ sceneId: ids.sceneId, forceLegato: boolean("Force immediate Legato launch for every clip in this scene; defaults to false.") }, ["sceneId"]) },
  launch_clip: { description: "Launch a Session slot. recordLengthBeats records an empty armed slot; updated bridge rechecks input, native identity and recording readiness. launchQuantization overrides once. Receipt does not prove take completion.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, recordLengthBeats: number("Fixed recording length in beats for an empty armed slot.", { exclusiveMinimum: 0 }), launchQuantization: choice("One-shot native launch quantization choice from get_clip_timing or list_clips.launchQuantizationChoices.") }, ["trackId", "clipId"]) },
  stop_clip: { description: "Plan or stop one exact Session clip slot.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]) },
  set_clip_slot_stop_button: {description:'Plan or change the stop button of one empty ordinary Session slot. Binds native full-row context, verifies readback and attempts owned rollback. Does not launch, stop playback or guarantee armed-empty recording behavior. Requires updated bridge; all profile.', inputSchema:guarded({trackId:ids.trackId,clipId:ids.clipId,hasStopButton:boolean('True stops this track on scene launch; false leaves an unarmed empty slot without a stop button.')},['trackId','clipId','hasStopButton'])},
  arm_track: { description: "Plan or set the record-arm state of one exact track.", inputSchema: guarded({ trackId: ids.trackId, armed: boolean("Requested arm state.") }, ["trackId", "armed"]) },
  set_scene_launch_quantization: { description: "Plan or apply a guarded per-scene clip-launch quantization override from list_scenes. The global setting stays in song musical context; only the selected scene changes.", inputSchema: guarded({ sceneId: ids.sceneId, launchQuantization: choice("Launch quantization value or name from list_scenes.") }, ["sceneId", "launchQuantization"]) },
  set_scene_musical_context: { description: "Plan or set an exact Session scene tempo and/or time-signature override. Disabled overrides inherit the song context; enabled overrides take effect when the scene is launched.", inputSchema: guarded({ sceneId: ids.sceneId, tempoEnabled: boolean("Enable or disable the scene tempo override."), tempo: number("Scene tempo in BPM when enabled.", { minimum: 20, maximum: 999 }), timeSignatureEnabled: boolean("Enable or disable the scene meter override."), numerator: { type: "integer", minimum: 1, maximum: 99 }, denominator: { type: "integer", enum: [1, 2, 4, 8, 16] } }, ["sceneId"]) },
  create_groove: { description: "Plan or create a new groove in Live's Groove Pool with an optional name. Adjust its base grid and amounts afterward with set_groove; groove deletion is not exposed by Live's public API.", inputSchema: guarded({ name: string("New groove name.") }) },
  get_track_midi_routing: { description: "Read one track's native MIDI note routing (input/output notes and scale transposition) from its MIDIMap. Reports unsupported explicitly when Live does not expose it.", inputSchema: track },
  set_track_midi_routing: { description: "Plan or apply guarded changes to one track's native MIDI input/output note and scale transposition. Affects every clip launched on the track; does not change device-level or rack-chain note routing.", inputSchema: guarded({
    trackId: ids.trackId,
    inNote: { type: "integer", minimum: 0, maximum: 127, description: "MIDI note that triggers the track." },
    outNote: { type: "integer", minimum: 0, maximum: 127, description: "MIDI note the track outputs." },
    inScale: boolean("Transpose incoming notes according to Live's scale."),
    outScale: boolean("Transpose outgoing notes according to Live's scale.")
  }, ["trackId"]) },
  get_track_freeze_state: { description: "Read one track native freeze state. A frozen flag does not prove saved state or audio equivalence.", inputSchema: track },
  set_track_freeze_state: { description: "Plan/apply native track freeze or unfreeze. Requires a saved Set, stopped playback/recording, an unarmed visible ordinary track and macOS English Live. Changes focus and selection; verify freezeVerified and inspect uncertain outcomes before continuing.", inputSchema: guarded({ trackId: ids.trackId, frozen: boolean("Requested freeze state.") }, ["trackId", "frozen"]) },
  set_bulk_track_mixer: { description: "Plan or apply guarded volume, pan, mute, and solo changes to multiple existing ordinary tracks in one confirmed step. Per-track values clamp to each observed native range; sends are unchanged.", inputSchema: guarded({
    trackIds: { ...array(ids.trackId, "Unique ordinary track IDs to change."), minItems: 1, maxItems: 64 },
    volume: number("Volume applied to every listed track."),
    pan: number("Pan applied to every listed track.", { minimum: -1, maximum: 1 }),
    mute: boolean("Mute state applied to every listed track."),
    solo: boolean("Solo state applied to every listed track; a solo write mutes everything else at Live level.")
  }, ["trackIds"]) },
  set_track_volume_db: { description: "Set a track fader in dB using Live's native display, with identity, value and automation rechecks. Refuses recording, disabled or automated faders and unrepresentable levels.", inputSchema: guarded({trackId:ids.trackId,volumeDb:number("Finite absolute fader level in dB; native range, no clamping.")},["trackId","volumeDb"]) },
  set_track_send_db: { description: "Set one track-to-Return send in native dB or to its verified silent minimum. Rechecks track, send and Return identity, current value and automation. Refuses recording, frozen or disabled sends and unsupported levels.", inputSchema: guarded({trackId:ids.trackId,sendId:string("Canonical send-N ID from get_track_mixer."),returnTrackId:string("Matching return-N ID from the selected send record."),sendDb:{oneOf:[{type:"number"},{type:"string",enum:["-inf"]}],description:"Absolute finite dB target, or -inf for the native verified silent minimum; no clamping."}},["trackId","sendId","returnTrackId","sendDb"]) },
  create_clip_parameter_envelope: { description: "Create an absent Session clip device-parameter envelope with 1–128 ordered, nonoverlapping steps in beats. Accepts exact native values or supported unit displays. Requires stopped playback and recording off; preserves existing lanes. Verifies sampled steps, not the full curve. Requires all profile.", inputSchema: guarded({trackId:ids.trackId,clipId:ids.clipId,deviceId:ids.deviceId,parameterId:ids.parameterId,points:{type:"array",items:creationEnvelopePoint,minItems:1,maxItems:128}},["trackId","clipId","deviceId","parameterId","points"]) },
  create_clip_mixer_envelope: {description:'Create an absent Session volume, Stereo pan or exact Return-send envelope with 1–128 ordered steps. Exact raw values; volume/send also accept finite native dB targets. Pan refuses Split Stereo or unknown modes. No clamping. Requires stopped playback, recording off and inactive target automation. Binds clip, mixer and Return identity; verifies sampled interiors. Existing lanes are preserved. All profile.',inputSchema:guarded({...mixerEnvelopeTarget,points:{type:'array',items:mixerEnvelopePoint,minItems:1,maxItems:128}},['trackId','clipId','mixerControl','points'])},
  set_device_parameter_display: { description: "Set one continuous device parameter to a finite native unit display (Hz/kHz, ms/s, dB, %). Resolves through Live's formatter without guessing raw values; refuses automation, recording and unrepresentable targets. Requires all profile.", inputSchema: guarded({trackId:ids.deviceOwnerId,deviceId:ids.deviceId,parameterId:ids.parameterId,targetDisplay:string("Numeric target and unit, such as 2 kHz, 200 ms, -12 dB or 25 %. Decimal point only; no clamping or approximation.")},["trackId","deviceId","parameterId","targetDisplay"]) },
  stop_all_clips: { description: "Plan or stop every playing Session clip in one guarded step using Live's native stop-all action. Playback-only; does not delete or mute clips.", inputSchema: guarded() }
};

const readOnlyTools = new Set([
  'get_selected_parameter_context',
  'get_browser_preview_context',
  "get_parameter_automation_context",
  "get_mixer_panning_context",
  "get_crossfader_context",
  "get_session_clip_hold",
  "get_track_ungrouping_status",
  "get_track_grouping_status",
  "get_live_object_colors",
  "get_arrangement_take",
  "get_device_ab_context",
  "get_take_lane_audition_context",
  "get_take_lane_context",
  "get_project_media",
  "get_producer_workflow",
  "search_presets", "get_nks_generation_status", "get_nks_generation_job", "get_preset", "get_preset_metadata",
  "get_browser_item_metadata", "search_browser_item_metadata",
  "get_midi_capture_context",
  "get_live_state",
  "get_selection_context",
  "get_session_orientation",
  "analyze_arrangement_section",
  "analyze_midi_parts",
  "get_instrument_comparison",
  "get_live_audio_capture",
  "get_transport_context",
  "get_history_state",
  "plan_audio_midi_sketch",
  "get_rack_performance_context",
  "get_beat_repeat_fill",
  "get_song_musical_context", "get_live_scale_reference", "list_live_scales",
  "get_song_grid_reference", "plan_grid_envelope_pattern",
  "plan_drum_pattern", "plan_drum_pattern_edit", "plan_drum_variation",
  "get_clip_groove_context", "analyze_midi_feel", "load_midi_feel_template", "inspect_clip_groove_postconditions",
  "get_transport_recording_context", "list_arrangement_cue_points",
  "list_tracks", "list_scenes", "get_scene_launch_context", "get_simpler_sample_state", "list_clips",
  "get_midi_clip_notes", "get_midi_clip_notes_extended",
  "analyze_midi_clip_scale", "analyze_midi_clip_chords",
  "plan_scale_chord_progression", "plan_scale_bassline", "plan_scale_melody",
  "plan_midi_humanization", "plan_midi_velocity_curve", "plan_midi_gate_pattern",
  "plan_midi_probability_pattern", "plan_midi_ratchet_pattern", "plan_midi_strum_pattern",
  "plan_midi_chord_inversion", "plan_midi_drop_voicing", "plan_midi_chord_voice_leading",
  "plan_midi_chord_doubling", "plan_midi_chord_arpeggiation",
  "plan_midi_transposition", "plan_midi_diatonic_transposition", "plan_midi_diatonic_harmony",
  "plan_midi_scale_chord_remapping", "plan_midi_diatonic_chord_quality",
  "get_clip_timing", "get_audio_clip_state", "get_audio_source_beat_times",
  "propose_audio_transient_warp", "get_device_sidechain_routing",
  "analyze_audio_file", "analyze_audio_clip", "get_automation_capabilities",
  "get_track_mixer", "get_track_routing", "get_set_mixer",
  "compare_audio_reference",
  "analyze_audio_file",
  "analyze_audio_clip",
  "get_automation_capabilities",
  "get_track_mixer",
  "get_track_routing",
  "get_set_mixer",
  "get_track_signal_activity",
  "get_return_routing",
  "list_producer_chain_blueprints", "get_producer_chain_blueprint",
  "inspect_producer_chain", "inspect_producer_bus", "inspect_producer_return_bus",
  "list_arrangement_clips", "list_factory_device_profiles", "get_factory_coverage",
  "get_factory_device_context", "get_plugin_integration_context",
  "get_looper_export_context",
  "get_looper_performance_context", "get_beat_repeat_performance_context",
  "get_factory_browser_items", "list_browser_roots", "get_browser_items", "search_browser_items", "search_browser_roots",
  "list_local_splice_roots", "browse_local_splice_directory", "search_local_splice_samples", "get_device_hierarchy",
  "get_clip_parameter_envelope", "get_clip_mixer_envelope", "list_devices", "list_device_parameters",
  "capture_device_parameter_snapshot", "capture_device_chain_snapshot", "list_saved_snapshots", "load_device_chain_snapshot",
  "capture_track_state_snapshot", "load_track_state_snapshot",
  "capture_group_system_snapshot", "load_group_system_snapshot", "plan_group_system_recall",
  "get_track_midi_routing", "get_track_freeze_state"
]);

const destructiveTools = new Set([
  "export_looper_clip",
  "load_simpler_sample",
  "set_simpler_sample_region",
  "set_simpler_manual_slices",
  "audition_arrangement_passage",
  "open_live_set",
  "save_live_set",
  "collect_project_media",
  "save_native_device_preset",
  "ungroup_tracks",
  "delete_session_object",
  "delete_clip",
  "delete_arrangement_clip",
  "export_midi_clip",
  "import_midi_file",
  "delete_arrangement_cue_point", "remove_audio_warp_marker",
  "delete_device", "crop_audio_clip", "set_looper_state", "set_device_parameters", "set_clip_parameter_envelope",
  "fail_nks_generation_job", "complete_nks_generation_job",
  "bounce_track_in_place", "set_track_freeze_state", "adjust_rack_macro_count", "delete_rack_macro_variation"
]);

// These tools answer from bundled reference data; all other tools can observe or
// change the local catalog, filesystem, or a running Ableton Live set.
const closedWorldTools = new Set([
  "get_live_scale_reference", "list_live_scales",
  "list_producer_chain_blueprints", "get_producer_chain_blueprint",
  "list_factory_device_profiles"
]);

const parameterDescriptions = {
  search_presets: { limit: "Maximum returned presets; defaults to 50 and is capped at 200." },
  get_producer_chain_blueprint: { target: "Exact blueprint ID returned by list_producer_chain_blueprints." },
  set_song_musical_context: {
    timeSignature: "Requested native numerator and denominator.",
    key: "Live song root, scale name, and scale mode.",
    quantization: "Native launch and MIDI-recording quantization choices.",
    groove: "Global groove intensity and swing.",
    loop: "Arrangement loop enablement and boundaries in beats."
  },
  set_clip_timing: {
    loop: "Clip loop enablement and boundaries; beats for warped clips, seconds for unwarped audio.",
    timeSignature: "Requested native numerator and denominator.",
    editorGrid: "Native clip-editor quantization and triplet display."
  },
  create_track: { type: "Native track type to create.", index: "Zero-based insertion index; omit to append." },
  create_scene: { index: "Zero-based insertion index; omit to append." },
  set_audio_clip_state: { pitchCoarse: "Coarse pitch offset in semitones.", pitchFine: "Fine pitch offset in cents." },
  get_browser_items: { offset: "Zero-based child offset; supply with limit.", limit: "Maximum children per page; supply with offset." },
  search_browser_items: { maxDepth: "Maximum subtree depth to scan.", limit: "Maximum matching items to return." },
  search_browser_roots: { maxDepth: "Maximum depth below each root.", limit: "Maximum matching items across all roots." }
};

function describedInput(name, schema) {
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([field, value]) => [
    field, {
      ...value,
      ...(parameterDescriptions[name]?.[field] ? { description: parameterDescriptions[name][field] } : {}),
      ...(field === "root" && ["get_browser_items", "search_browser_items", "load_browser_item"].includes(name)
        ? { enum: LIVE_BROWSER_ROOTS } : {})
    }
  ])) };
}

export const toolContracts = Object.fromEntries(Object.entries(contracts).map(([name, contract]) => [
  name, { ...contract, inputSchema: describedInput(name, contract.inputSchema),
    outputSchema: toolOutputContracts[name] ?? extensibleToolResult, annotations: {
    readOnlyHint: readOnlyTools.has(name),
    destructiveHint: destructiveTools.has(name),
    idempotentHint: readOnlyTools.has(name),
    openWorldHint: !closedWorldTools.has(name)
  } }
]));
Object.assign(toolContracts, producerToolContracts);
