export function validatePreviewMeasurement(value) {
  const findings = [];
  if (value.durationSeconds < 11.9 || value.durationSeconds > 12.1) {
    findings.push("duration_not_12_seconds");
  }
  if (value.sampleRate !== 48000) findings.push("sample_rate_not_48000");
  if (value.bitDepth !== 24) findings.push("bit_depth_not_24");
  if (value.integratedLufs < -60) findings.push("silence");
  if (value.truePeakDbtp > -1) findings.push("true_peak_above_-1_dbtp");
  return { ok: findings.length === 0, findings };
}
