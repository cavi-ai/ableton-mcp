function requireInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
}

function buildDrumPattern(reference, options, { allowEmptyLanes = false } = {}) {
  if (!Number.isFinite(reference?.tempoBpm) || reference.tempoBpm <= 0)
    throw new Error("tempoBpm must be finite and positive");
  const selected = reference?.grids?.[options?.grid];
  if (!selected) throw new Error("unknown grid; use a grid from get_song_grid_reference");
  if (!selected.barBoundaryOnGrid || !Number.isInteger(selected.stepsPerBar))
    throw new Error("grid cannot land on every bar boundary in this time signature");
  requireInteger(options.bars, "bars", 1, 16);
  const startBeat = options.startBeat ?? 0;
  if (!Number.isFinite(startBeat) || startBeat < 0) throw new Error("startBeat must be finite and nonnegative");
  if (!Array.isArray(options.lanes) || options.lanes.length === 0) throw new Error("lanes must be a non-empty array");
  const laneNotes = options.lanes.map(lane => lane?.note);
  if (new Set(laneNotes).size !== laneNotes.length) throw new Error("drum lanes must use a unique MIDI note");
  const stepBeats = 1 / selected.stepsPerQuarter;
  const lengthBeats = startBeat + options.bars * reference.barLengthBeats;
  if (!Number.isFinite(stepBeats) || !Number.isFinite(lengthBeats))
    throw new Error("derived drum timing must be finite");
  const estimatedNotes = options.lanes.reduce((total, lane) =>
    total + (Array.isArray(lane?.activeSteps) ? lane.activeSteps.length * options.bars : 0), 0);
  if (estimatedNotes > 4096) throw new Error("drum pattern may generate at most 4096 MIDI notes");
  const notes = [];
  const lanes = options.lanes.map((lane, laneIndex) => {
    if (typeof lane.role !== "string" || !lane.role.trim()) throw new Error(`lanes[${laneIndex}].role must be non-empty`);
    requireInteger(lane.note, `lanes[${laneIndex}].note`, 0, 127);
    requireInteger(lane.velocity, `lanes[${laneIndex}].velocity`, 1, 127);
    if (!Number.isFinite(lane.gate) || lane.gate <= 0 || lane.gate > 1)
      throw new Error(`lanes[${laneIndex}].gate must be greater than zero and at most one`);
    if (!Array.isArray(lane.activeSteps) || (!allowEmptyLanes && lane.activeSteps.length === 0) ||
        lane.activeSteps.some(step => !Number.isInteger(step) || step < 1 || step > selected.stepsPerBar) ||
        new Set(lane.activeSteps).size !== lane.activeSteps.length)
      throw new Error(`lanes[${laneIndex}].activeSteps must be unique step numbers within one bar`);
    const accentSteps = lane.accentSteps ?? [];
    if (lane.accentVelocity !== undefined && accentSteps.length === 0)
      throw new Error(`lanes[${laneIndex}].accentVelocity requires accentSteps`);
    if (!Array.isArray(accentSteps) || new Set(accentSteps).size !== accentSteps.length ||
        accentSteps.some(step => !lane.activeSteps.includes(step)))
      throw new Error(`lanes[${laneIndex}].accentSteps must be unique active steps`);
    if (accentSteps.length) requireInteger(lane.accentVelocity, `lanes[${laneIndex}].accentVelocity`, 1, 127);
    const active = lane.activeSteps.toSorted((a, b) => a - b);
    const accents = new Set(accentSteps);
    for (let bar = 0; bar < options.bars; bar++) {
      for (const step of active) notes.push({ pitch: lane.note,
        start: startBeat + bar * reference.barLengthBeats + (step - 1) * stepBeats,
        duration: stepBeats * lane.gate,
        velocity: accents.has(step) ? lane.accentVelocity : lane.velocity,
        mute: false });
    }
    return { role: lane.role.trim(), note: lane.note, activeSteps: active, accentSteps: [...accentSteps].toSorted((a, b) => a - b),
      velocity: lane.velocity, accentVelocity: accentSteps.length ? lane.accentVelocity : null, gate: lane.gate };
  });
  if (notes.some(note => !Number.isFinite(note.start) || !Number.isFinite(note.duration)))
    throw new Error("derived drum timing must be finite");
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { grid: options.grid, bars: options.bars, startBeat, stepBeats, tempoBpm: reference.tempoBpm,
    timeSignature: reference.timeSignature, barLengthBeats: reference.barLengthBeats,
    stepsPerBar: selected.stepsPerBar, lanes, notes, lengthBeats };
}

export function planDrumPattern(reference, options) {
  return buildDrumPattern(reference, options);
}

export function planDrumPatternEdit(reference, observed, options) {
  requireInteger(options?.startBar, "startBar", 0, 4095);
  if (!Number.isFinite(observed?.lengthBeats) || observed.lengthBeats <= 0 || !Array.isArray(observed.notes))
    throw new Error("observed MIDI clip must include finite lengthBeats and notes");
  if (observed.notes.length > 4096) throw new Error("drum edit supports at most 4096 existing MIDI notes");
  const startBeat = options.startBar * reference.barLengthBeats;
  const pattern = buildDrumPattern(reference, { ...options, startBeat }, { allowEmptyLanes: true });
  const endBeat = startBeat + options.bars * reference.barLengthBeats;
  if (endBeat > observed.lengthBeats) throw new Error("drum edit range exceeds the MIDI clip length");
  const targetPitches = new Set(pattern.lanes.map(lane => lane.note));
  const removeNoteIds = [];
  const preservedNotes = [];
  for (const note of observed.notes) {
    const noteEnd = note.start + note.duration;
    const targetsLane = targetPitches.has(note.pitch);
    const startsInside = note.start >= startBeat && note.start < endBeat;
    const crossesBoundary = targetsLane && ((note.start < startBeat && noteEnd > startBeat) ||
      (note.start < endBeat && noteEnd > endBeat));
    if (crossesBoundary) throw new Error(`target-lane note ${note.noteId} crosses the edit boundary`);
    if (targetsLane && startsInside) removeNoteIds.push(note.noteId);
    else preservedNotes.push(note);
  }
  if (removeNoteIds.length === 0 && pattern.notes.length === 0)
    throw new Error("drum edit would not change any notes");
  if (removeNoteIds.length > 4096 || pattern.notes.length > 4096 ||
      preservedNotes.length + pattern.notes.length > 4096)
    throw new Error("drum edit supports at most 4096 removed, added, or final MIDI notes");
  return { ...pattern, startBar: options.startBar, range: { startBeat, endBeat },
    removeNoteIds: removeNoteIds.toSorted((a, b) => a - b), newNotes: pattern.notes, preservedNotes };
}

export function matchDrumPatternEditReadback(edit, observedMutation, finalNotes) {
  const addedNoteIds = observedMutation?.addedNoteIds;
  if (!Array.isArray(addedNoteIds) || addedNoteIds.length !== edit.newNotes.length ||
      new Set(addedNoteIds).size !== addedNoteIds.length ||
      finalNotes.length !== edit.preservedNotes.length + edit.newNotes.length) return false;
  const byId = new Map(finalNotes.map(note => [note.noteId, note]));
  const extendedFields = ["noteId", "pitch", "start", "duration", "velocity",
    "velocityDeviation", "releaseVelocity", "probability", "mute"];
  if (edit.preservedNotes.some(expected => {
    const actual = byId.get(expected.noteId);
    return !actual || extendedFields.some(field => actual[field] !== expected[field]);
  })) return false;
  const added = addedNoteIds.map(noteId => byId.get(noteId));
  if (added.some(note => !note)) return false;
  const close = (a, b) => Math.abs(a - b) <= 1e-7;
  const unmatched = [...added];
  return edit.newNotes.every(expected => {
    const index = unmatched.findIndex(actual => actual.pitch === expected.pitch &&
      close(actual.start, expected.start) && close(actual.duration, expected.duration) &&
      actual.velocity === expected.velocity && actual.mute === expected.mute &&
      actual.velocityDeviation === 0 && actual.releaseVelocity === 0 && actual.probability === 1);
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  }) && unmatched.length === 0;
}
