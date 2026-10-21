// Implementation boundaries are distinct from nativeApiSupport reported by a
// running Live. Returning copies keeps callers from mutating shared metadata.
export const productionBoundaries = Object.freeze({
  atomicMultiOperationTasks: false,
  completeEnvelopeRecovery: false,
  hiddenPluginStateVerification: false,
  automaticAudibleQualityVerification: false,
  noChangeEvidence: "fresh_caller_postconditions",
  inspectionIntent: "read_only"
});

const automation = {
  sessionClipParameterEnvelopes: { read: true, write: true, shape: "steps" },
  sessionClipMixerEnvelopes: { read: true, create: true, replace: false, controls: ["volume", "pan", "send"], shape: "steps",
    pan: { panningMode: 0, splitStereo: false, targets: "raw_native_values" } },
  arrangementParameterAutomation: { read: false, write: false,
    reason: "Ableton Live's public Clip API returns no automation envelope for Arrangement clips" },
  perNoteProperties: { read: true, write: true,
    fields: ["pitch", "start", "duration", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"] },
  perNoteExpressionCurves: { read: false, write: false,
    reason: "The bridge does not expose per-note pitch-bend, pressure, or slide curves" },
  productionBoundaries,
  handoffs: [
    { capability: "arrangement_automation", action: "Edit Arrangement envelopes in Live; do not substitute Session steps for continuous curves." },
    { capability: "complete_envelope_recovery", action: "Preserve the original lane; sampled observations are not a curve backup." },
    { capability: "hidden_plugin_state", action: "Inspect or save the native instrument state; exposed parameters do not establish full sound equivalence." },
    { capability: "audible_quality", action: "Capture or audition the result and obtain explicit listening feedback before claiming musical acceptance." },
    { capability: "partial_task_failure", action: "Inspect applied receipts and actual state before proposing further work; prior operations are not rolled back." }
  ]
};

export function getProductionCapabilities() { return structuredClone(automation); }
