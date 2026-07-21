function variableLength(value) {
  const bytes = [value & 0x7f];
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

export function buildSerumPreviewMidi() {
  const notes = [48, 55, 60, 63, 67, 72, 67, 63, 50, 57, 62, 65, 69, 74, 69, 65, 53, 60, 65, 68, 72, 77, 72, 68];
  const events = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20];
  for (const note of notes) {
    events.push(0x00, 0x90, note, 96);
    events.push(...variableLength(480), 0x80, note, 0);
  }
  events.push(0x00, 0xff, 0x2f, 0x00);
  const track = Buffer.from(events);
  const header = Buffer.alloc(14);
  header.write("MThd", 0, "ascii");
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(480, 12);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write("MTrk", 0, "ascii");
  trackHeader.writeUInt32BE(track.length, 4);
  return Buffer.concat([header, trackHeader, track]);
}
