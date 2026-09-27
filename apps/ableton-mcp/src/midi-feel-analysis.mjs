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
    limitation: "Measures stored MIDI note timing and velocity only; an assigned native Live groove may change playback timing and accents, which this analysis does not capture." };
}
