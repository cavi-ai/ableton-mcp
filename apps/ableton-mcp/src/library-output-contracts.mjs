import { result, text, numeric, bool, integer, array, nullable, strings, records, versioned, localMutation } from "./result-schemas.mjs";

const object = { type: "object" };
const metadata = result({ favorite: bool, tags: strings, revision: { type: "integer", minimum: 0 } });
const saved = { name: text, path: text };
const loaded = result({ ...saved, snapshot: object });
const captured = versioned({ trackId: text, snapshot: object, limitation: text });
const savedCapture = versioned({ ...saved, trackId: text, limitation: text });
const browserItem = result({ name: text, path: strings, uri: nullable(text), loadable: bool }, ["name"]);
const browserPage = versioned({ root: text, path: strings, item: nullable(browserItem), children: array(browserItem),
  offset: integer, nextOffset: nullable(integer), totalChildren: integer }, ["root", "path", "children"]);
const browserSearch = versioned({ root: text, path: strings, query: text, results: array(browserItem) });
const job = object;

export const libraryOutputContracts = {
  list_saved_snapshots: result({ kind: text, names: strings }),
  capture_device_chain_snapshot: captured,
  capture_track_state_snapshot: captured,
  capture_device_parameter_snapshot: versioned({ trackId: text, deviceId: text, snapshot: object, limitation: text }),
  capture_group_system_snapshot: versioned({ busTrackId: text, snapshot: object, limitation: text }),
  save_device_chain_snapshot: savedCapture,
  save_track_state_snapshot: savedCapture,
  save_group_system_snapshot: versioned({ ...saved, busTrackId: text, limitation: text }),
  load_device_chain_snapshot: loaded,
  load_track_state_snapshot: loaded,
  load_group_system_snapshot: loaded,
  save_midi_feel_template: result({ ...saved, template: object }),
  load_midi_feel_template: result({ ...saved, template: object }),
  plan_group_system_recall: versioned({ dryRun: { const: true }, busTrackId: text, tracks: records, limitation: text }),
  get_project_media: versioned({ setFingerprint: text, file: object, project: object, samples: records,
    deviceDependencies: records, savedSnapshotMatchesLive: bool, completePortabilityVerified: { const: false }, native: object }),
  search_presets: result({ presets: records, catalog: result({ configured: bool }) }),
  get_preset: result({ preset: object }),
  get_preset_metadata: result({ presetId: text, metadata }),
  set_preset_metadata: localMutation({ requested: object, observed: metadata, timestamp: text }),
  get_browser_item_metadata: result({ item: object, metadata, nativeLiveCollectionsModified: { const: false } }),
  set_browser_item_metadata: localMutation({ requested: object, observed: metadata, nativeLiveCollectionsModified: { const: false }, timestamp: text }),
  search_browser_item_metadata: result({ items: records, limitation: text }),
  get_nks_generation_status: result({ productSlug: text, eligible: integer, fingerprint: text, initialized: bool, jobs: object }),
  get_nks_generation_job: result({ job: nullable(job), events: records }),
  enqueue_nks_generation_jobs: localMutation({ enqueued: integer, jobs: object }),
  claim_nks_generation_job: result({ job: nullable(job), preset: nullable(object) }),
  heartbeat_nks_generation_job: result({ job }),
  fail_nks_generation_job: result({ job }),
  complete_nks_generation_job: result({ job }),
  get_factory_browser_items: browserPage,
  get_browser_items: browserPage,
  list_browser_roots: versioned({ roots: records }),
  search_browser_items: browserSearch,
  search_browser_roots: versioned({ query: text, searchedRoots: strings, unavailableRoots: strings,
    results: array(browserItem), visitedItems: integer, truncated: bool, truncationReason: nullable(text) }),
  list_local_splice_roots: result({ roots: array(result({ configuredPath: text, rootPath: nullable(text), available: bool })),
    scope: { const: "configured_local_directories" }, limitation: text }),
  browse_local_splice_directory: result({ rootPath: text, scope: { const: "local_files_only" }, offset: integer, total: integer,
    nextOffset: nullable(integer), entries: array(result({ name: text, type: { enum: ["directory", "audio_file"] }, sourcePath: text })) }),
  search_local_splice_samples: result({ rootPath: text, query: nullable(text), scope: { const: "local_files_only" }, offset: integer,
    visited: integer, maxVisited: integer, truncated: bool, nextOffset: nullable(integer),
    samples: array(result({ relativePath: text, sourcePath: text })), limitation: text }),
  get_factory_coverage: result({ roots: { type: "object", additionalProperties: result({ stateVersion: integer,
    loadableCount: integer, profiledByName: records, missingProfiles: records }) }, deepIntegrationVerified: { const: false }, limitation: text }),
  get_factory_device_context: versioned({ trackId: text, device: object, profile: nullable(object), parameters: records }, ["trackId", "device"]),
  get_plugin_integration_context: versioned({ trackId: text, device: object, profile: object,
    installedVariants: records, recommendedVariant: nullable(object), parameterExposure: object }),
  inspect_producer_chain: versioned({ trackId: text, verification: object }),
  inspect_producer_bus: versioned({ busTrackId: text, busChain: object, children: records, matchesBlueprint: bool, limitation: text }),
  inspect_producer_return_bus: versioned({ returnTrackId: text, busChain: object, children: records, matchesBlueprint: bool, limitation: text }),
  get_producer_workflow: { type: "object", anyOf: [result({ workflows: records }),
    result({ workflow: text, description: text, messages: records })] }
};
