export function buildSongGridReference(timeSignature, tempoBpm) {
  if (typeof tempoBpm !== "number" || !Number.isFinite(tempoBpm) || tempoBpm <= 0) throw new Error("invalid Live tempo");
  if (!Number.isInteger(timeSignature?.numerator) || timeSignature.numerator < 1 || timeSignature.numerator > 99 ||
    ![1, 2, 4, 8, 16].includes(timeSignature.denominator)) throw new Error("invalid Live time signature");
  const { numerator, denominator } = timeSignature;
  const barLengthBeats = numerator * 4 / denominator;
  const beatUnitBeats = 4 / denominator;
  const grids = {};
  for (const [name, stepsPerQuarter] of [["straight16", 4], ["eighthTriplet", 3], ["sixteenthTriplet", 6]]) {
    const stepsPerBar = barLengthBeats * stepsPerQuarter;
    const count = Math.ceil(stepsPerBar - 1e-9);
    const meterBeatAnchors = Array.from({ length: numerator }, (_, index) => {
      const offsetBeats = index * beatUnitBeats;
      const stepIndex = offsetBeats * stepsPerQuarter;
      return { meterBeat: index + 1, offsetBeats,
        stepNumber: Math.abs(stepIndex - Math.round(stepIndex)) < 1e-9 ? Math.round(stepIndex) + 1 : null };
    });
    const meterBeatSteps = meterBeatAnchors.flatMap(anchor => anchor.stepNumber === null ? [] : [anchor.stepNumber]);
    const eighthOffbeatSteps = [];
    for (let index = 0; index < count; index++) {
      if (name === "straight16" && denominator === 4 && index % 4 === 2) eighthOffbeatSteps.push(index + 1);
    }
    grids[name] = { stepsPerQuarter, stepsPerBar, barBoundaryOnGrid: Number.isInteger(stepsPerBar),
      barDownbeatSteps: [1], meterBeatAnchors, meterBeatSteps, eighthOffbeatSteps };
  }
  const conventions = numerator === 4 && denominator === 4 ? {
    bindingRule: "examples_not_rules",
    hipHopBackbeat: { snareBeats: [2, 4], straight16Steps: [grids.straight16.meterBeatSteps[1], grids.straight16.meterBeatSteps[3]],
      eighthTripletSteps: [grids.eighthTriplet.meterBeatSteps[1], grids.eighthTriplet.meterBeatSteps[3]],
      sixteenthTripletSteps: [grids.sixteenthTriplet.meterBeatSteps[1], grids.sixteenthTriplet.meterBeatSteps[3]] },
    houseFourOnFloor: { kickBeats: [1, 2, 3, 4], snareBeats: [2, 4] },
    trapHalfTime: { snareBeats: [3], straight16Steps: [grids.straight16.meterBeatSteps[2]],
      eighthTripletSteps: [grids.eighthTriplet.meterBeatSteps[2]],
      sixteenthTripletSteps: [grids.sixteenthTriplet.meterBeatSteps[2]],
      hatSubdivisionExamples: ["eighthTriplet", "sixteenthTriplet"] }
  } : null;
  const round = value => Math.round(value * 1e6) / 1e6;
  const tempoInterpretation = {
    projectTempoBpm: tempoBpm, perceivedHalfTimeBpm: tempoBpm / 2,
    perceivedDoubleTimeBpm: tempoBpm * 2,
    quarterSecondsAtProjectTempo: round(60 / tempoBpm),
    barSecondsAtProjectTempo: round(barLengthBeats * 60 / tempoBpm),
    barSecondsIfProjectTempoHalved: round(barLengthBeats * 120 / tempoBpm),
    perceivedHalfTimeChangesProjectTempo: false,
    projectTempoChangeRequiresWarpAndMidiAudit: true
  };
  const toolReferences = {
    midiQuantize: { tool: "transform_midi_notes", field: "operation.gridBeats",
      straight16: 1 / 4, eighthTriplet: 1 / 3, sixteenthTriplet: 1 / 6 },
    audioQuantize: { tool: "quantize_audio_clip", field: "grid",
      straight16: "1_16", eighthTriplet: "1_8_triplet", sixteenthTriplet: "1_16_triplet" },
    grooveChoices: "get_song_musical_context", grooveEdit: "set_groove",
    transientGridInspection: "propose_audio_transient_warp", actualTempoChange: "set_tempo",
    clipLoopAndSignature: "get_clip_timing",
    clipGridEnvelope: { planner: "plan_grid_envelope_pattern", destination: "set_clip_parameter_envelope" }
  };
  return { timeSignature, tempoBpm, barLengthBeats, grids, conventions, tempoInterpretation, toolReferences };
}

export function planGridEnvelopePattern(reference, { grid, bars, activeSteps, onValue, offValue, startBeat = 0 }) {
  const selected = reference.grids?.[grid];
  if (!selected) throw new Error("unknown grid; use a grid from get_song_grid_reference");
  if (!selected.barBoundaryOnGrid || !Number.isInteger(selected.stepsPerBar)) {
    throw new Error("grid cannot land on every bar boundary in this time signature");
  }
  if (!Number.isInteger(bars) || bars < 1 || bars > 16) throw new Error("bars must be an integer from 1 to 16");
  if (bars * selected.stepsPerBar > 512) throw new Error("too many envelope steps; plan fewer bars");
  if (!Array.isArray(activeSteps) || activeSteps.length === 0 || activeSteps.some(step =>
    !Number.isInteger(step) || step < 1 || step > selected.stepsPerBar) ||
    new Set(activeSteps).size !== activeSteps.length) throw new Error("activeSteps must be unique step numbers within one bar");
  if (![onValue, offValue, startBeat].every(value => typeof value === "number" && Number.isFinite(value)) ||
    startBeat < 0 || onValue === offValue) throw new Error("pattern values and startBeat must be finite, nonnegative startBeat, and distinct on/off values");
  const stepBeats = 1 / selected.stepsPerQuarter;
  if (startBeat + stepBeats === startBeat ||
    startBeat + bars * reference.barLengthBeats > Number.MAX_SAFE_INTEGER) {
    throw new Error("startBeat cannot safely represent every grid step");
  }
  const active = new Set(activeSteps);
  const points = Array.from({ length: bars * selected.stepsPerBar }, (_, index) => ({
    time: startBeat + index * stepBeats,
    duration: stepBeats,
    value: active.has(index % selected.stepsPerBar + 1) ? onValue : offValue
  }));
  return { stateVersion: reference.stateVersion, grid, bars, startBeat, points,
    destinationTool: "set_clip_parameter_envelope", nativeParameterValidation: "destination_tool" };
}
