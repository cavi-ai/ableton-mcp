import { result, text, numeric, bool, integer, array, nullable, strings, records, versioned } from "./result-schemas.mjs";

const object = { type: "object" };
const target = { trackId: text, clipId: text };
const note = result({ pitch: { type: "integer", minimum: 0, maximum: 127 }, start: numeric,
  duration: numeric, velocity: { type: "integer", minimum: 0, maximum: 127 } });
const notes = array(note);
const plan = result({ notes, changes: records, newNotes: notes, preservedNotes: records,
  noteIds: array(integer) }, []);
const analysis = versioned({ ...target, lengthBeats: numeric, analysis: object });
const clipPlan = versioned({ ...target, context: object, plan });
const audioMeasurement = result({ sourcePath: text, scope: { const: "source_audio" }, durationSeconds: numeric,
  sampleRate: numeric, channels: integer, window: result({ startSeconds: numeric, durationSeconds: numeric }),
  integratedLufs: nullable(numeric), truePeakDbtp: nullable(numeric), loudnessRangeLu: nullable(numeric) });

export const musicOutputContracts = {
  get_song_grid_reference: versioned({ setFingerprint: text, timeSignature: object, tempoBpm: numeric,
    barLengthBeats: numeric, grids: object, conventions: nullable(object), tempoInterpretation: object, toolReferences: object }),
  plan_grid_envelope_pattern: versioned({ grid: text, bars: numeric, startBeat: numeric,
    points: array(result({ time: numeric, value: numeric })), destinationTool: text, nativeParameterValidation: text }),
  plan_drum_pattern: versioned({ gridReference: object, plan }),
  plan_drum_pattern_edit: versioned({ gridReference: object, clipTiming: object, before: object, edit: object }),
  plan_drum_variation: versioned({ gridReference: object, clipTiming: object, before: object, variation: object }),
  analyze_midi_clip_scale: analysis,
  analyze_midi_clip_chords: analysis,
  plan_scale_chord_progression: versioned({ musicalContext: object, plan }),
  plan_scale_bassline: versioned({ musicalContext: object, plan }),
  plan_scale_melody: versioned({ musicalContext: object, gridReference: object, plan }),
  analyze_midi_feel: versioned({ ...target, grid: text, bars: integer, originBeats: numeric,
    sourceNoteCount: integer, totalSourceNoteCount: integer, notes: records, slots: records, template: object }),
  inspect_clip_groove_postconditions: result({ operation: text, postconditionsObserved: { const: true },
    actionProvenanceVerified: { const: false }, sourceContentChanged: bool, observed: object }),
  get_audio_source_beat_times: versioned({ ...target, sourcePath: nullable(text), conversion: { const: "native" },
    points: array(result({ sourceSeconds: numeric, beatTime: numeric })) }),
  propose_audio_transient_warp: versioned({ ...target, gridBeats: numeric, nativeConversion: { const: true },
    sourcePath: text, sourceWindow: object, candidateCount: integer, gridAlignment: records, actions: records }),
  plan_audio_midi_sketch: versioned({ ...target, eligible: bool, reason: text, lengthBeats: numeric,
    notes, sourceFile: object, sourceWindow: object, audioCorrectionApplied: { const: false } }),
  analyze_audio_file: audioMeasurement,
  analyze_audio_clip: versioned({ ...target, measurement: audioMeasurement }),
  compare_audio_reference: result({ scope: { const: "source_audio_windows" }, mix: object, reference: object,
    mixMinusReference: result({ integratedLufs: nullable(numeric), truePeakDbtp: nullable(numeric), loudnessRangeLu: nullable(numeric) }),
    levelMatch: result({ available: bool, applied: { const: false } }, ["available", "applied"]), limitation: text }),
  get_session_orientation: versioned({ setFingerprint: text, live: object, musicalContext: object,
    recording: object, tracks: records, selection: object, focus: object }, ["setFingerprint", "live", "tracks"]),
  analyze_arrangement_section: versioned({ parts: records, coverage: object }),
  analyze_midi_parts: versioned({ parts: records }),
  plan_arrangement_repeat: versioned({ setFingerprint: text, atomic: { const: false },
    requiresFreshConfirmation: { const: true }, contentVerified: { const: false }, automationVerified: { const: false },
    canCopy: bool, emptySource: bool, sourceRange: object, destinationRange: object, repeatCount: integer,
    periodBeats: numeric, tracks: records, sources: records, placements: records, emptyTrackIds: strings,
    boundaryClips: records, destinationClips: records, plannedOverlaps: records })
};

for (const name of ["humanization", "velocity_curve", "gate_pattern", "probability_pattern", "ratchet_pattern", "strum_pattern",
  "chord_inversion", "drop_voicing", "chord_voice_leading", "chord_doubling", "chord_arpeggiation", "transposition",
  "diatonic_transposition", "diatonic_harmony", "scale_chord_remapping", "diatonic_chord_quality"])
  musicOutputContracts[`plan_midi_${name}`] = clipPlan;
