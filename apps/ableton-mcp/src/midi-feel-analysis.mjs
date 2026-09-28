const subdivisions = Object.freeze({ straight16: 4, eighthTriplet: 3, sixteenthTriplet: 6 });

export function analyzeMidiFeel(observed, timing, { grid, bars = 1 }) {
  const perBeat = subdivisions[grid];
  if (!perBeat) throw new Error("grid must be straight16, eighthTriplet, or sixteenthTriplet");
  if (!Number.isInteger(bars) || bars < 1 || bars > 8) throw new Error("bars must be an integer from 1 to 8");
  const numerator = timing?.timeSignature?.numerator;
  const denominator = timing?.timeSignature?.denominator;
  if (!Number.isInteger(numerator) || numerator < 1 || ![1, 2, 4, 8, 16].includes(denominator))
    throw new Error("clip time signature is unavailable");
  const barBeats = numerator * 4 / denominator;
  const cycleBeats = barBeats * bars;
  const slotsPerBar = barBeats * perBeat;
  const slotCount = cycleBeats * perBeat;
  if (!Number.isInteger(slotsPerBar) || slotCount > 4096)
    throw new Error("selected grid does not divide the analysis cycle");
  if (!Array.isArray(observed?.notes) || observed.notes.length > 4096)
    throw new Error("MIDI feel analysis supports at most 4096 notes");

  const notes = observed.notes.map((note) => {
    if (!Number.isInteger(note.noteId) || !Number.isInteger(note.pitch) ||
        !Number.isFinite(note.start) || note.start < 0 || !Number.isInteger(note.velocity) ||
        note.velocity < 1 || note.velocity > 127)
      throw new Error("MIDI note has invalid timing, pitch, velocity, or ID");
    const nearest = Math.round(note.start * perBeat);
    return { noteId: note.noteId, pitch: note.pitch, startBeats: note.start,
      velocity: note.velocity, slot: ((nearest % slotCount) + slotCount) % slotCount,
      offsetBeats: note.start - nearest / perBeat };
  });
  const bySlot = new Map();
  for (const note of notes) {
    const bucket = bySlot.get(note.slot) ?? [];
    bucket.push(note);
    bySlot.set(note.slot, bucket);
  }
  const slots = [...bySlot].sort(([left], [right]) => left - right).map(([slot, hits]) => ({
    slot, positionBeats: slot / perBeat, hitCount: hits.length,
    meanOffsetBeats: hits.reduce((sum, note) => sum + note.offsetBeats, 0) / hits.length,
    meanVelocity: hits.reduce((sum, note) => sum + note.velocity, 0) / hits.length,
    barDownbeat: slot % slotsPerBar === 0, quarterPulse: slot % perBeat === 0,
    halfBeatUpbeat: perBeat % 2 === 0 && slot % perBeat === perBeat / 2
  }));
  return { stateVersion: observed.stateVersion, trackId: observed.trackId, clipId: observed.clipId,
    grid, bars, subdivisionsPerQuarterBeat: perBeat, barBeats, cycleBeats, slotCount,
    sourceNoteCount: notes.length, nativeGrooveId: timing.grooveId ?? null, notes, slots,
    template: { format: "cavi-midi-feel-v1", grid, bars, barBeats,
      nativeGrooveId: timing.grooveId ?? null,
      source: { trackId: observed.trackId, clipId: observed.clipId, stateVersion: observed.stateVersion },
      slots: slots.map(({ slot, hitCount, meanOffsetBeats, meanVelocity }) =>
        ({ slot, hitCount, meanOffsetBeats, meanVelocity })) },
    limitation: "Measures stored MIDI note timing and velocity only; an assigned native Live groove may change playback timing and accents, which this analysis does not capture." };
}

export function planMidiFeelTransfer(observed, timing, { template, timingAmount, velocityAmount, noteIds }) {
  const audioFeel = template?.format === "cavi-audio-feel-v1";
  const perBeat = audioFeel ? 1 / template.gridBeats : subdivisions[template?.grid];
  if ((!audioFeel && template?.format !== "cavi-midi-feel-v1") ||
      !Number.isFinite(perBeat) || perBeat <= 0 ||
      !Number.isInteger(template.bars) || template.bars < 1 || template.bars > 8 ||
      !Number.isFinite(template.barBeats) || template.barBeats <= 0 ||
      template.nativeGrooveId !== null || !Array.isArray(template.slots) || !template.slots.length)
    throw new Error("invalid stored MIDI feel template");
  if (typeof template.source?.trackId !== "string" || !template.source.trackId ||
      typeof template.source?.clipId !== "string" || !template.source.clipId ||
      !Number.isInteger(template.source?.stateVersion) || template.source.stateVersion < 1 ||
      (audioFeel && (typeof template.source?.sourcePath !== "string" || !template.source.sourcePath)))
    throw new Error("stored MIDI feel template source identity is missing");
  if (audioFeel && velocityAmount !== 0) throw new Error("audio feel cannot infer MIDI velocity; velocityAmount must be zero");
  if (timing.grooveId !== null && timing.grooveId !== undefined)
    throw new Error("remove the target clip's native groove before transferring stored MIDI feel");
  const barBeats = timing.timeSignature?.numerator * 4 / timing.timeSignature?.denominator;
  const slotsPerBar = barBeats * perBeat;
  const slotCount = slotsPerBar * template.bars;
  if (Math.abs(slotsPerBar - Math.round(slotsPerBar)) > 1e-9 ||
      Math.abs(slotCount - Math.round(slotCount)) > 1e-9 || slotCount > 4096 ||
      Math.abs(barBeats - template.barBeats) > 1e-9)
    throw new Error("template grid or meter does not match the target clip");
  if (![timingAmount, velocityAmount].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      timingAmount + velocityAmount === 0)
    throw new Error("timingAmount and velocityAmount must be within 0..1 with at least one positive");
  const slots = new Map();
  for (const slot of template.slots) {
    if (!Number.isInteger(slot.slot) || slot.slot < 0 || slot.slot >= slotCount || slots.has(slot.slot) ||
        !Number.isInteger(slot.hitCount) || slot.hitCount < 1 ||
        (slot.meanOffsetBeats !== null && (!Number.isFinite(slot.meanOffsetBeats) || Math.abs(slot.meanOffsetBeats) > 0.5 / perBeat + 1e-9)) ||
        (!audioFeel && (slot.meanOffsetBeats === null || !Number.isFinite(slot.meanVelocity) || slot.meanVelocity < 1 || slot.meanVelocity > 127)) ||
        (audioFeel && (!Number.isInteger(slot.reliableTimingHits) || slot.reliableTimingHits < 0 ||
          slot.reliableTimingHits > slot.hitCount || (slot.meanOffsetBeats === null) !== (slot.reliableTimingHits === 0) ||
          !Number.isFinite(slot.meanStrength) || slot.meanStrength < 0 || slot.meanStrength > 1)))
      throw new Error("invalid stored MIDI feel template slot");
    slots.set(slot.slot, slot);
  }
  if (!Array.isArray(observed.notes) || observed.notes.length > 4096)
    throw new Error("MIDI feel transfer supports at most 4096 target notes");
  const ids = noteIds === undefined ? observed.notes.map(note => note.noteId) : noteIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 4096 ||
      ids.some(id => !Number.isInteger(id)) || new Set(ids).size !== ids.length)
    throw new Error("noteIds must be a non-empty set of unique note IDs");
  const byId = new Map(observed.notes.map(note => [note.noteId, note]));
  const changes = [];
  for (const id of ids) {
    const note = byId.get(id);
    if (!note) throw new Error(`unknown noteId ${id}`);
    const nearest = Math.round(note.start * perBeat);
    const slot = slots.get(((nearest % slotCount) + slotCount) % slotCount);
    if (!slot || slot.meanOffsetBeats === null) continue;
    const change = { noteId: id };
    const start = note.start + timingAmount * (nearest / perBeat + slot.meanOffsetBeats - note.start);
    if (start < 0 || start + note.duration > observed.lengthBeats + 1e-9)
      throw new Error(`transferred timing extends noteId ${id} beyond the clip`);
    if (Math.abs(start - note.start) > 1e-9) change.start = start;
    if (!audioFeel) {
      const velocity = Math.round(note.velocity + velocityAmount * (slot.meanVelocity - note.velocity));
      if (velocity !== note.velocity) change.velocity = velocity;
    }
    if (Object.keys(change).length > 1) changes.push(change);
  }
  if (!changes.length) throw new Error("feel template produces no note changes");
  return changes;
}
