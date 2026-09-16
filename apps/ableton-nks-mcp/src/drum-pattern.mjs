function requireInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
}

export function planDrumPattern(reference, options) {
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
    if (!Array.isArray(lane.activeSteps) || lane.activeSteps.length === 0 ||
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
