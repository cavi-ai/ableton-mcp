function velocity(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 127)
    throw new Error(`${field} must be an integer from 1 to 127`);
}

function normalizeCurve(curve) {
  if (!curve || typeof curve !== "object" || Array.isArray(curve))
    throw new Error("curve must be an object");
  if (curve.type === "fixed") {
    velocity(curve.velocity, "curve.velocity");
    return { type: "fixed", velocity: curve.velocity };
  }
  if (curve.type === "accent") {
    if (!Array.isArray(curve.velocities) || curve.velocities.length === 0)
      throw new Error("curve.velocities must be a non-empty array");
    if (curve.velocities.length > 128) throw new Error("curve.velocities supports at most 128 values");
    curve.velocities.forEach((value, index) => velocity(value, `curve.velocities[${index}]`));
    return { type: "accent", velocities: [...curve.velocities] };
  }
  if (curve.type === "crescendo" || curve.type === "decrescendo") {
    velocity(curve.startVelocity, "curve.startVelocity");
    velocity(curve.endVelocity, "curve.endVelocity");
    if (curve.type === "crescendo" && curve.endVelocity <= curve.startVelocity)
      throw new Error("crescendo endVelocity must be greater than startVelocity");
    if (curve.type === "decrescendo" && curve.endVelocity >= curve.startVelocity)
      throw new Error("decrescendo endVelocity must be less than startVelocity");
    return { type: curve.type, startVelocity: curve.startVelocity, endVelocity: curve.endVelocity };
  }
  throw new Error("curve.type must be crescendo, decrescendo, fixed, or accent");
}

export function planMidiVelocityCurve(clip, options) {
  if (!Array.isArray(clip?.notes) || !Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0)
    throw new Error("complete MIDI clip notes and length are required");
  if (new Set(clip.notes.map(note => note.noteId)).size !== clip.notes.length)
    throw new Error("clip notes must have unique note IDs");
  if (!Array.isArray(options?.noteIds) || options.noteIds.length === 0)
    throw new Error("noteIds must be a non-empty array");
  if (options.noteIds.length > 4096) throw new Error("noteIds supports at most 4096 notes");
  if (new Set(options.noteIds).size !== options.noteIds.length)
    throw new Error("noteIds must not contain a duplicate noteId");
  const curve = normalizeCurve(options.curve);
  const byId = new Map(clip.notes.map(current => [current.noteId, current]));
  const selected = options.noteIds.map(noteId => {
    const current = byId.get(noteId);
    if (!current) throw new Error(`unknown noteId ${noteId}`);
    return current;
  });
  const selectedIds = new Set(options.noteIds);
  const selectedStarts = new Set(selected.map(current => current.start));
  if (clip.notes.some(current => selectedStarts.has(current.start) && !selectedIds.has(current.noteId)))
    throw new Error("velocity curves require every note at each selected complete onset");
  const onsets = [...selectedStarts].sort((left, right) => left - right);
  const velocityByStart = new Map(onsets.map((start, index) => {
    let target;
    if (curve.type === "fixed") target = curve.velocity;
    else if (curve.type === "accent") target = curve.velocities[index % curve.velocities.length];
    else {
      const progress = onsets.length === 1 ? 0 : index / (onsets.length - 1);
      target = Math.round(curve.startVelocity + (curve.endVelocity - curve.startVelocity) * progress);
    }
    return [start, target];
  }));
  const changes = selected
    .map(previous => ({ noteId: previous.noteId, previous, velocity: velocityByStart.get(previous.start) }))
    .filter(change => change.velocity !== change.previous.velocity);
  if (changes.length === 0) throw new Error("velocity curve would not change any selected notes");
  return { noteIds: [...options.noteIds], curve, changes };
}

export function matchMidiVelocityCurveReadback(beforeNotes, changes, observedNotes, tolerance = 2e-7) {
  if (!Array.isArray(beforeNotes) || !Array.isArray(changes) || !Array.isArray(observedNotes) ||
      beforeNotes.length !== observedNotes.length) return false;
  const expected = new Map(beforeNotes.map(current => [current.noteId, { ...current }]));
  if (expected.size !== beforeNotes.length) return false;
  for (const change of changes) {
    const current = expected.get(change.noteId);
    if (!current) return false;
    current.velocity = change.velocity;
  }
  if (new Set(observedNotes.map(current => current.noteId)).size !== expected.size ||
      observedNotes.some(current => !expected.has(current.noteId))) return false;
  const exactFields = ["pitch", "duration", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"];
  return observedNotes.every(actual => {
    const wanted = expected.get(actual.noteId);
    return exactFields.every(field => wanted[field] === actual[field]) &&
      Math.abs(wanted.start - actual.start) <= tolerance;
  });
}
