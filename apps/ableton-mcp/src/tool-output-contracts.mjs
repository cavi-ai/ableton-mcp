// Live readbacks and guarded mutation receipts are extensible objects. Bundled
// references have stable fields that can be validated more specifically.
const result = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required
});
const text = { type: "string" };
const integers = { type: "array", items: { type: "integer" } };
const strings = { type: "array", items: text };
const scale = result({ name: text, family: text, intervals: {
  type: "array", minItems: 1, items: { type: "integer", minimum: 0, maximum: 11 }
} });
const blueprint = result({ id: text, topology: text, summary: text });
const version = { type: "integer", minimum: 1 };
const records = { type: "array", items: { type: "object" } };
const versioned = (properties) => result({ stateVersion: version, ...properties });
export const mutationReceiptSchema = result({ schemaVersion: { const: 1 },
  status: { enum: ["applied", "outcome_unknown", "postconditions_failed", "pending_postconditions", "pending_user_action"] },
  reason: text, evidence: strings });
export const guardedMutationResult = {
  type: "object", required: ["dryRun"], properties: { dryRun: { type: "boolean" } },
  oneOf: [result({ dryRun: { const: true }, plan: { type: "object" }, confirmation: result({
    token: { type: "string", minLength: 1 }, planHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, expiresAt: { type: "number" }
  }) }), result({ dryRun: { const: false }, operationOutcome: mutationReceiptSchema })]
};

// Compact discovery preserves the original reference schemas. Full contracts
// are enforced on every call, independent of the host's discovery profile.
export const compactOutputNames = new Set(["list_live_scales", "get_live_scale_reference", "list_producer_chain_blueprints",
  "get_producer_chain_blueprint", "list_factory_device_profiles"]);

export const toolOutputContracts = {
  get_live_state: result({ stateVersion: version, setFingerprint: text }),
  list_tracks: versioned({ tracks: { type: "array", items: result({ id: text, name: text, type: text }) } }),
  list_scenes: versioned({ scenes: records }),
  list_clips: versioned({ clips: records }),
  list_arrangement_clips: versioned({ clips: records }),
  list_devices: versioned({ devices: records }),
  list_device_parameters: versioned({ parameters: { type: "array", items: result({ id: text, name: text, value: { type: "number" } }) } }),
  get_device_parameter_edit_context: versioned({ parameters: records, editContext: { type: "object" } }),
  get_midi_clip_notes_extended: versioned({ notes: records }),
  get_midi_clip_notes: versioned({ notes: { type: "array" } }),
  get_clip_timing: versioned({}),
  get_audio_clip_state: versioned({ trackId: text, clipId: text }),
  get_track_mixer: versioned({ trackId: text, volume: result({ value: { type: "number" } }) }),
  get_track_routing: versioned({}),
  get_song_musical_context: versioned({ timeSignature: { type: "object" } }),
  list_live_scales: result({ scales: { type: "array", items: scale } }),
  get_live_scale_reference: result({ scale: result({ ...scale.properties,
    rootNote: { type: "integer", minimum: 0, maximum: 11 }, rootName: text,
    pitchClasses: integers, noteNames: strings, degrees: integers
  }) }),
  list_producer_chain_blueprints: result({ blueprints: { type: "array", items: blueprint } }),
  get_producer_chain_blueprint: result({ blueprint }),
  list_factory_device_profiles: result({ profiles: { type: "array", items: result({
    id: text, name: text, type: text, family: text, notes: strings, parameterRoles: strings
  }, ["id", "name", "type", "family", "parameterRoles"]) } })
};

export const extensibleToolResult = { type: "object" };

const artifactId = { type: "string", pattern: "^[a-f0-9]{64}$" };
const checkSource = { enum: ["caller", "specialist"] };
const sessionSummary = result({ sessionId: { type: "string" }, sessionRef: artifactId, revision: { type: "integer", minimum: 1 },
  phase: { enum: ["inspect", "choose", "propose", "proposing", "apply", "execution_pending", "needs_inspection", "audition", "evaluate", "complete"] },
  audibleQualityVerified: { const: false } });
export const producerOutputContracts = {
  start_production_session: sessionSummary,
  advance_production_session: sessionSummary,
  get_production_session: { type: "object", oneOf: [sessionSummary, result({ sessions: records,
    nextOffset: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } })] },
  get_production_context: result({ stateVersion: version, setFingerprint: text, contextRef: artifactId, summary: text }),
  record_production_note: result({ noteRef: artifactId }),
  read_production_artifact: result({ artifactId, text, offset: { type: "integer", minimum: 0 }, totalCharacters: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" }, nextOffset: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } }),
  run_production_task: result({ taskId: artifactId, intent: { enum: ["inspect", "change"] },
    status: { enum: ["proposed", "observed", "no_change_needed", "incomplete", "budget_exhausted", "stale_context", "needs_input"] },
    checkSource, operationCount: { type: "integer", minimum: 0, maximum: 16 }, summary: text,
    stateVersion: version, setFingerprint: text, questions: strings, contextRef: artifactId, resultRefs: records, turnRefs: records, readsUsed: { type: "integer", minimum: 0 } }),
  apply_production_operation: result({ taskId: artifactId, operationIndex: { type: "integer", minimum: 0 },
    status: { enum: ["planned", "applied", "rejected", "outcome_unknown", "postconditions_failed", "pending_postconditions", "pending_user_action"] }, checkSource })
};
