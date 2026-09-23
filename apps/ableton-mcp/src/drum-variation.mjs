const MAX_NOTES = 4096;
const NOTE_FIELDS = ["noteId", "pitch", "start", "duration", "velocity",
  "velocityDeviation", "releaseVelocity", "probability", "mute"];

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
}

function finite(value, field, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be finite from ${minimum} to ${maximum}`);
}

function randomFromSeed(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function exactNote(expected, actual) {
  return NOTE_FIELDS.every(field => expected[field] === actual?.[field]);
}

function normalizedNote(expected, actual) {
  return NOTE_FIELDS.every(field => field === "start" || field === "duration"
    ? Math.abs(expected[field] - actual?.[field]) <= 2e-7
    : expected[field] === actual?.[field]);
}

function overlaps(left, right) {
  return left.pitch === right.pitch && left.start < right.start + right.duration &&
    right.start < left.start + left.duration;
}

export function planDrumVariation(reference, observed, options) {
  if (!Number.isFinite(observed?.lengthBeats) || observed.lengthBeats <= 0 || !Array.isArray(observed.notes))
    throw new Error("observed MIDI clip must include finite lengthBeats and notes");
  if (observed.notes.length > MAX_NOTES) throw new Error(`drum variation supports at most ${MAX_NOTES} MIDI notes`);
  const grid = reference?.grids?.[options?.grid];
  if (!grid?.barBoundaryOnGrid || !Number.isInteger(grid.stepsPerBar)) throw new Error("unknown or bar-misaligned grid");
  integer(options.startBar, "startBar", 0, 4095);
  integer(options.bars, "bars", 1, 16);
  integer(options.seed, "seed", 0, 0xffffffff);
  finite(options.timingAmount, "timingAmount", 0, 0.49);
  integer(options.velocityAmount, "velocityAmount", 0, 32);
  if (!Array.isArray(options.laneNotes) || options.laneNotes.length === 0 ||
      new Set(options.laneNotes).size !== options.laneNotes.length)
    throw new Error("laneNotes must be a non-empty unique array");
  options.laneNotes.forEach((pitch, index) => integer(pitch, `laneNotes[${index}]`, 0, 127));
  integer(options.preserveAccentsAbove, "preserveAccentsAbove", 1, 127);
  const startBeat = options.startBar * reference.barLengthBeats;
  const endBeat = startBeat + options.bars * reference.barLengthBeats;
  if (endBeat > observed.lengthBeats) throw new Error("drum variation range exceeds the MIDI clip length");
  const targetPitches = new Set(options.laneNotes);
  const selected = [], preservedNotes = [];
  for (const note of observed.notes) {
    const selectedLane = targetPitches.has(note.pitch);
    const inside = note.start >= startBeat && note.start < endBeat;
    if (selectedLane && ((note.start < startBeat && note.start + note.duration > startBeat) ||
        (note.start < endBeat && note.start + note.duration > endBeat)))
      throw new Error(`target-lane note ${note.noteId} crosses the variation boundary`);
    if (selectedLane && inside) selected.push(note);
    else preservedNotes.push(note);
  }
  const random = randomFromSeed(options.seed);
  const stepBeats = 1 / grid.stepsPerQuarter;
  const changes = [], changedBefore = [];
  for (const note of selected) {
    const change = { noteId: note.noteId };
    if (options.timingAmount > 0) {
      const magnitude = (random() * 2 - 1) * stepBeats * options.timingAmount;
      let start = note.start + magnitude;
      if (start < startBeat) start = note.start + Math.abs(magnitude);
      if (start + note.duration > endBeat) start = note.start - Math.abs(magnitude);
      start = Math.max(startBeat, Math.min(endBeat - note.duration, start));
      if (start !== note.start) change.start = start;
    }
    if (options.velocityAmount > 0 && note.velocity < options.preserveAccentsAbove) {
      const delta = Math.round((random() * 2 - 1) * options.velocityAmount);
      const velocity = Math.max(1, Math.min(127, note.velocity + delta));
      if (velocity !== note.velocity) change.velocity = velocity;
    }
    if (Object.keys(change).length > 1) {
      changes.push(change);
      changedBefore.push(note);
    } else preservedNotes.push(note);
  }
  const newNotes = [];
  if (options.fill !== undefined) {
    const fillGrid = reference.grids?.[options.fill.grid];
    if (!fillGrid?.barBoundaryOnGrid || !Number.isInteger(fillGrid.stepsPerBar))
      throw new Error("fill grid must land on every bar boundary");
    integer(options.fill.note, "fill.note", 0, 127);
    integer(options.fill.velocity, "fill.velocity", 1, 127);
    finite(options.fill.gate, "fill.gate", Number.MIN_VALUE, 1);
    if (!Array.isArray(options.fill.activeSteps) || options.fill.activeSteps.length === 0 ||
        new Set(options.fill.activeSteps).size !== options.fill.activeSteps.length ||
        options.fill.activeSteps.some(step => !Number.isInteger(step) || step < 1 || step > fillGrid.stepsPerBar))
      throw new Error("fill.activeSteps must be unique steps within the final bar");
    const fillStepBeats = 1 / fillGrid.stepsPerQuarter;
    const finalBarStart = endBeat - reference.barLengthBeats;
    for (const step of options.fill.activeSteps.toSorted((a, b) => a - b)) newNotes.push({
      pitch: options.fill.note, start: finalBarStart + (step - 1) * fillStepBeats,
      duration: fillStepBeats * options.fill.gate, velocity: options.fill.velocity,
      velocityDeviation: 0, releaseVelocity: 0, probability: 1, mute: false
    });
  }
  if (changes.length === 0 && newNotes.length === 0) throw new Error("drum variation would not change any notes");
  if (observed.notes.length + newNotes.length > MAX_NOTES)
    throw new Error(`drum variation supports at most ${MAX_NOTES} final MIDI notes`);
  const changedById = new Map(changes.map(change => [change.noteId, change]));
  const finalExisting = observed.notes.map(note => ({ ...note, ...changedById.get(note.noteId) }));
  const finalNotes = [...finalExisting, ...newNotes];
  const changedIds = new Set(changes.map(change => change.noteId));
  for (let left = 0; left < finalNotes.length; left++) for (let right = left + 1; right < finalNotes.length; right++) {
    const involvesMutation = changedIds.has(finalNotes[left].noteId) || changedIds.has(finalNotes[right].noteId) ||
      left >= finalExisting.length || right >= finalExisting.length;
    if (involvesMutation && overlaps(finalNotes[left], finalNotes[right]))
      throw new Error("drum variation would create a same-lane note collision");
  }
  return { grid: options.grid, startBar: options.startBar, bars: options.bars, seed: options.seed,
    range: { startBeat, endBeat }, stepBeats, timingAmount: options.timingAmount,
    velocityAmount: options.velocityAmount, preserveAccentsAbove: options.preserveAccentsAbove,
    laneNotes: [...options.laneNotes], fill: options.fill ?? null, changes, changedBefore, newNotes, preservedNotes };
}

export function matchDrumVariationReadback(plan, observedMutation, finalNotes) {
  const byId = new Map(finalNotes.map(note => [note.noteId, note]));
  if (plan.preservedNotes.some(expected => !exactNote(expected, byId.get(expected.noteId)))) return false;
  for (const before of plan.changedBefore) {
    const expected = { ...before, ...plan.changes.find(change => change.noteId === before.noteId) };
    if (!normalizedNote(expected, byId.get(before.noteId))) return false;
  }
  const addedIds = observedMutation?.addedNoteIds;
  if (!Array.isArray(addedIds) || addedIds.length !== plan.newNotes.length ||
      new Set(addedIds).size !== addedIds.length) return false;
  const added = addedIds.map(noteId => byId.get(noteId));
  if (added.some(note => !note)) return false;
  const close = (left, right) => Math.abs(left - right) <= 1e-7;
  const unmatched = [...added];
  const additionsMatch = plan.newNotes.every(expected => {
    const index = unmatched.findIndex(actual => actual.pitch === expected.pitch &&
      close(actual.start, expected.start) && close(actual.duration, expected.duration) &&
      actual.velocity === expected.velocity && actual.velocityDeviation === expected.velocityDeviation &&
      actual.releaseVelocity === expected.releaseVelocity && actual.probability === expected.probability &&
      actual.mute === expected.mute);
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  });
  return additionsMatch && unmatched.length === 0 &&
    finalNotes.length === plan.preservedNotes.length + plan.changedBefore.length + plan.newNotes.length;
}
