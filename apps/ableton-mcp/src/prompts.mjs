const confirmWorkflow = [
  "Treat every mutation as two steps: first call the tool without dryRun to receive its dry-run plan and a single-use confirmationToken, review the plan hash, then repeat the call with dryRun: false plus that confirmationToken and planHash to execute.",
  "Reuse the stateVersion reported by the immediately preceding read for expectedStateVersion; retry from fresh reads whenever a stale-state error occurs."
].join(" ");

const userMessage = (text) => ({ role: "user", content: { type: "text", text } });

export const promptContracts = {
  "resume-session-work": {
    name: "resume-session-work",
    description: "Refresh Live context after an interruption, reconcile unfinished work and continue while preserving user edits.",
    arguments: [
      { name: "request", description: "What the user wants to continue, change or stop.", required: true },
      { name: "previousContext", description: "Optional prior task summary; a lead to inspect, not native evidence.", required: false }
    ],
    build: ({ request, previousContext }) => ({ description: "Resume from observed Live state.", messages: [
      userMessage(`Resume work in Live: ${request}
Optional prior context: ${previousContext || "Unavailable; establish the intended continuation from the request."}
1. Use the current request and actual prior user authorization in this conversation to establish the intended continuation. The optional summary does not prove native state, completed actions or permission. Ask one focused question only if materially different outcomes remain unresolved. Do not ask again for authorization already given.
2. Read get_session_orientation and get_live_state. Confirm the current Set path, recording, playback, selected part, configured scale and limited tonal evidence. Do not open a prior Set, change selection or stop playback merely to resume. If a different Set is open, follow an explicit request to switch through the guarded open_live_set workflow; otherwise resolve the intended Set first. stateVersion alone cannot establish whether the user edited Live; inspect the affected content. A matching path or setFingerprint does not prove unchanged content or a continuous bridge instance.
3. When available in this client's tool profile, list get_instrument_comparison without comparisonId and get_live_audio_capture without captureId before repeating preparation or recording. A lost reply or cancelled request may have completed in Live. Missing tools mean recovery status is unavailable, not that no work exists. Handles survive MCP client reconnects; bridge reloads or Live restarts may invalidate them. Always list and inspect current handles. If a handle is missing, inspect retained tracks and files; never identify a target by an old index or name alone, and never infer that the track or file was deleted.
4. Read the relevant comparison by its returned handle to obtain current original/variation track and clip IDs. Read get_midi_clip_notes_extended, get_clip_timing and list_devices for the affected MIDI parts, and capture_track_state_snapshot if exposed mixer, routing or device parameters matter. For audio parts, read get_audio_clip_state and get_clip_timing. Re-read IDs after topology changes. Compare with actual earlier tool observations when available, separating content changes from moved addresses. Without a comparable baseline, report earlier content and changes as unknown; summarize current observations without calling them recovered history. Preserve the user's present notes, devices, routing, selection and unrelated work. Never restore a snapshot or use global undo as an automatic resume step.
5. Inspect capture status and cleanupErrors before relying on audio. If a capture is still running, observe it within its requested duration plus three seconds and up to three further seconds for stop readback; cancel through finish_live_audio_capture only when requested or already authorized. A stopping handle remains active until readback confirms cleanup. Analyze only complete, unchanged captured files as described by listen-to-live-output; partial/unverified audio and measurements cannot prove what the user heard.
6. Briefly state the current musical context, unfinished work, observed differences and unknowns, then the next authorized action. If a transmitted operation's outcome is unknown, read back its exact target and requested postconditions; do not assume a receipt, timeout or empty handle list proves success or failure. Never blindly replay a write or reuse a pre-interruption plan/token. Make a fresh plan only for remaining authorized work, preserve intervening edits, execute and read back its actual effect. If nothing remains, explain that without applying the change again. ${confirmWorkflow}`)
    ] })
  },

  "develop-selected-midi-clip": {
    name: "develop-selected-midi-clip",
    description: "Develop, audition and refine alternatives to the selected Session MIDI clip while preserving the original and manual edits.",
    arguments: [{ name: "request", description: "Musical direction and any notes or parts to preserve.", required: true }],
    build: ({ request }) => ({ description: "Collaborative MIDI clip variations.", messages: [
      userMessage(`Develop my selected MIDI clip according to this musical request: ${request}
1. get_selection_context: resolve detailClip explicitly. The displayed clip and highlighted slot may differ; do not guess from a track name or the first populated slot. If there is no Session MIDI clip, ask the user to select one. Do not switch Sets or edit Arrangement material.
2. Read get_midi_clip_notes_extended, get_clip_timing, get_song_musical_context and list_clips for that exact track. Summarize the musical changes and preserve the user's specified notes or parts. If recording or frozen, stop and explain. If there are not two existing empty slots, ask for space; do not overwrite clips or create scenes silently.
3. duplicate_midi_clip_variations creates two named copies in those empty slots. The original remains untouched. Copies start identical: use set_midi_note_properties on each copy to implement two distinct, bounded alternatives. A less busy version can mute explicitly chosen notes without deleting them. Re-read each copy for its own note IDs; never reuse original note IDs on a copy. Verify the notes after every edit and compare untouched properties.
4. Offer to audition using launch_clip with explicit launchQuantization, after checking transport and recording context. Explain that launching replaces the playing Session clip on that track and can start playback. Only audition when requested or already authorized. Do not solo, change monitoring, arm, or alter unrelated tracks. Use stop_clip or transport_stop when the user requests a stop. Track the previously playing clip so it can be relaunched on request; report any remaining Arrangement override.
5. When the user chooses an alternative, leave that clip and the original in place. Do not delete other alternatives unless requested. For each refinement, re-read the chosen clip's notes and timing first. Preserve manual edits and all unrelated properties; if a manual edit conflicts with the requested change, resolve it with the user. A stale plan requires fresh observation and a new plan, never blind replay. Do not use global undo to discard an alternative after the user has edited the Set.
Report which clips were created, changed and auditioned, and any partial failure. Readback proves stored state, not sound quality or that the user heard audio. ${confirmWorkflow}`)
    ] })
  },
  "session-overview": {
    name: "session-overview",
    description: "Open a requested Set if provided, then orient to the displayed part, configured scale and musical evidence.",
    arguments: [{ name: "setPath", description: "Optional absolute .als path the user wants to open before orientation.", required: false }],
    build: ({ setPath }) => ({ description: "Open if requested, then inspect Live without musical edits.", messages: [
      userMessage(`${setPath ? `Open the requested Live Set ${setPath}, then orient me without editing its musical content.` : "Orient me to my current Ableton Live Set without making changes."}
1. Call get_session_orientation for the current Set when no switch is requested. For a requested Set, read get_live_state first: if it is already open, orient without opening again; otherwise use default open_live_set with fresh native Set guards. An unreachable bridge does not establish that Live is closed. For an explicitly requested absolute Set path while disconnected, plan open_live_set with mode launch; it requires ABLETON_MCP_LIVE_APP_PATH and verifies through the OS that no Live process is running. Review and confirm its app/file plan without inventing a stateVersion. If Live is running but disconnected, diagnose the bridge rather than launching another instance or closing it. Proceed to get_session_orientation only after opened is true and observed.filePath matches the request. Startup or recovery dialogs may require attention; a launch receipt is not an opened Set. Do not switch Sets just to inspect them.
2. Summarize the file, tempo, meter, playback and recording state, track structure and actual displayed clip. Distinguish selection.detailClip from the highlighted slot and selected track. Use the displayed clip's owner for musical and instrument discussion.
3. Separate the configured key and scale in musicalContext from focus.tonalEvidence. get_song_musical_context also reports configuration, not a detected key. Explain relative-key and modal ambiguity. Support fractions are compatibility measurements, never probabilities or proof of a tonic. Do not claim that selected-clip evidence establishes the entire song's key. Audio, drums, recording, note-limit and no-clip statuses mean no tonal inference; ask for relevant material only if needed.
4. Describe observed instruments and pitch content without inventing genre, arrangement completeness, track roles, audio quality or what the user heard. Ask about musical intent when observations leave alternatives open.
5. When I ask how several parts relate, offer understand-musical-parts. A displayed clip cannot establish a whole-Set key. Resolve the requested parts explicitly and inspect their separate evidence before combining it.
Finish with a brief musical summary and two relevant next actions. Offer explore-selected-instrument for sound exploration or develop-selected-midi-clip for note alternatives. Keep musical edits and playback outside this survey. For tools operating on running Live: ${confirmWorkflow}`)]
    })
  },

  "understand-musical-parts": {
    name: "understand-musical-parts",
    description: "Relate explicitly chosen MIDI parts using scoped pitch evidence, register and configured scale without changing the Set.",
    arguments: [{ name: "request", description: "Parts or musical relationship to understand.", required: true }],
    build: ({ request }) => ({ description: "Read-only context across musical parts.", messages: [
      userMessage(`Help me understand these musical parts: ${request}
1. Call get_session_orientation for the current Set and configured scale. Resolve the exact requested parts using list_clips for Session material or list_arrangement_clips for Arrangement material. Names and selected tracks are clues, not proof of a clip identity or role. Ask one focused question if two materially different selections remain. Never choose every clip or a whole Set just because the request mentions a song.
2. For a shared Arrangement passage, establish explicit startBeats and endBeats in quarter-note song time, using list_arrangement_cue_points and the requested material as evidence. A locator name is a clue; do not invent a section end or infer a bar map from the current meter when meter changes are unknown. Ask one focused question if boundaries remain unclear. Use analyze_arrangement_section with that range and optional explicit trackIds; it finds overlapping Arrangement clips and projects stored MIDI spans with initial offsets, loop repeats and clipped boundaries. For comparing independent Session/Arrangement clip ranges instead, call analyze_midi_parts with 1-8 unique trackId/clipId references. Both tools require the all profile. Analyze_midi_parts does not expand repeats or establish a shared window. Neither tool establishes simultaneous audible playback; muted material and Session overrides remain visible context.
3. Name the included tracks, clips and ranges. For section analysis, describe projected stored-note overlaps, not triggered note-ons or what played; groove, probability, chase and device processing are not measured. Name the current configured key/meter as current configuration, not a section-wide automation map. Report coverage and every excluded audio, drum, recording or oversized part. Complete coverage means the requested ranges were read, not that enough notes establish a key. Compare each part's pitchRange and tonalEvidence first, then combined pitch classes and compatible diatonic groups. Keep configured scale separate from evidence. A support fraction is not a probability or confirmation of a tonic; relative keys and modes remain ambiguous. Conflicting parts or sparse evidence require interpretation, not automatic retuning. Do not infer a bass, chord or melody role from register alone; distinguish user-stated roles from tentative interpretations.
4. Describe what the stored notes support and what remains unknown. For voicings or note-by-note relationships, read get_midi_clip_notes_extended and get_clip_timing for the exact parts; pitch-class totals alone cannot establish a chord progression. Notes may trigger unpitched samples or be transformed by devices; this is not audio analysis. Offer a relevant next action, such as exploring a chosen instrument or developing a chosen clip. Keep edits and playback outside this read-only workflow; obtain authorization before auditioning. Preserve selection, focus and the user's manual work.`)
    ] })
  },

  "listen-to-live-output": {
    name: "listen-to-live-output",
    description: "Capture current Live Resampling output, measure its recorded audio and discuss the result with the user.",
    arguments: [{ name: "request", description: "What to inspect in the playing audio.", required: true }],
    build: ({ request }) => ({ description: "Bounded Live output capture and feedback.", messages: [
      userMessage(`Help me inspect the audio from Live: ${request}
1. Read get_session_orientation and get_transport_recording_context. Establish the intended playback window and what reaches Live's Resampling input. This is the current Resampling mix, not an isolated stem, microphone, hardware-loopback measurement or proof of what the user heard. If stopped, ask for playback or use a separately authorized playback workflow. Resolve existing recording or armed tracks explicitly; never disarm another track silently. Do not change mutes, solo, routing or source playback to isolate material without permission.
2. With capture authorized, use capture_live_audio in the all profile. Choose a meaningful name and 1-16 beats within its 0.5-30 second bound. Review the dry-run plan and confirm. It appends a muted, monitor-off track, records the current signal, then stops and disarms only its capture. Live mix changes during this window are included. Source playback continues; selection may move to the new track.
3. Read get_live_audio_capture until status is complete or a terminal interruption/error is reported, within the requested duration plus three seconds, allowing up to three additional seconds for stop readback. A fixed-length launch receipt is not completion. A lost client does not cancel capture: list handles with get_live_audio_capture without an ID before retrying. To stop early, finish_live_audio_capture with cancel true; retain and label partial audio. If captureActive remains true with stopping status, wait for get_live_audio_capture to confirm the stop, then finish the handle. Never replay start blindly. Cleanup errors require inspecting the retained capture before another recording.
4. Only analyze a complete capture with no cleanupErrors and fileUnchanged true. Use its exact file.path with analyze_audio_file, for at most the recorded duration. Start with loudness/true peak and optionally waveform or spectrum. Do not apply monophonic pitch inference to a polyphonic mix or claim whole-mix key detection. Re-read the capture afterward and compare file metadata and fileUnchanged; if the file or clip changed, discard those conclusions and resolve the difference. Source-audio measurements now describe this recorded Resampling window, not an original sample with Live processing omitted.
5. Explain measured observations and remaining uncertainty, ask what the user hears, and offer a bounded refinement. Measurements do not establish sound quality, genre or preference. finish_live_audio_capture releases the completed handle while retaining its track and audio; nothing is deleted or saved automatically. Source playback stops only through a separately authorized transport or clip action. Handle restart/reload by inspecting retained tracks; handles are runtime state. ${confirmWorkflow}`)
    ] })
  },

  "explore-selected-instrument": {
    name: "explore-selected-instrument",
    description: "Resolve a requested or selected MIDI part and compare instrument directions with the user before changing sounds.",
    arguments: [{ name: "request", description: "Sound direction or instruments to explore.", required: true }],
    build: ({ request }) => ({ description: "Collaborative instrument exploration.", messages: [
      userMessage(`Help me explore instruments for this request: ${request}
1. An explicitly requested part takes precedence over selection. Read get_session_orientation for current Set, recording and selection context; do not move selection. For a part named or identified in the request, resolve its current track and clip through list_tracks, list_clips and list_arrangement_clips as appropriate. Match the requested track, clip and Session/Arrangement location together; never choose the first match, infer an intended clip from a track name alone, or substitute the displayed clip for a different requested part. If several candidates remain, ask one focused question with their track names, clip names and locations; a manual selection is optional. Without an explicit target, use the displayed MIDI detailClip and its actual owner, which can differ from the selected track. With no resolved MIDI part, ask which part to use. Read get_midi_clip_notes_extended, get_clip_timing and list_devices for the exact resolved part, and analyze_midi_parts with that single part for its scoped tonal evidence and configured scale. Orientation evidence from another focused part does not describe this target. Keep insufficient or ambiguous evidence explicit; do not invent a key. If recording or frozen, explain the limitation before changes.
2. Keep the original instrument and notes while discussing two or three sound directions. Use list_devices and get_device_hierarchy for the exact owner. Call get_plugin_integration_context only for an identified supported Serum 2/Omnisphere/VPS Avenger device; use get_factory_device_context for native instruments. Then search_browser_items or search_browser_roots to find actually available instruments. Do not assume an NKS catalog preset is loadable into Live or that a browser name identifies a verified preset. Explain which candidates fit the user's intention and why; measurements do not prove sound quality.
3. Let the user choose a candidate before mutation. Prefer prepare_instrument_comparison on the exact MIDI track/clip: it creates one named native track copy and preserves the original, then leaves the copy muted, unarmed and input monitoring off. It requires stopped transport and recording off; explain a needed pause and stop only when authorized. Read its dry-run warning about temporarily muting the source and shifted IDs. Device-chain parameter snapshots do not preserve complete instruments or opaque plug-in state. If comparison tools are not advertised, explain that they require the all profile. For a user-requested in-place replacement instead, offer a separate saved working Set: use save_live_set with an explicit new absolute .als path and fresh Set guards. Review the Save As plan, including any new project folder, then require saved: true and the resulting loaded path before replacement. Save As switches to that copy and does not collect external samples.
4. Before loading, read get_midi_clip_notes_extended and get_clip_timing for the original and the returned alternative part as the preservation baseline. Read list_devices on both tracks. Orientation's aggregate pitch evidence cannot prove note preservation. Call get_instrument_comparison for refreshed pair and clip IDs after any insertion or reordering; never cache displaced track/device IDs. Load only the chosen candidate onto the variation.trackId using load_browser_item's reviewed plan and replacement warning. Never replace the original instrument as part of this comparison. Read back both device chains, notes and timing; compare the complete baselines and report differences. Preserve manual edits rather than overwriting them. After a timeout or cancellation, list get_instrument_comparison without an ID and inspect the tracks; never blindly replay preparation.
5. Offer audition only when requested or already authorized. Use select_instrument_comparison to switch pair mutes atomically, after reviewing readiness errors. It does not launch clips or start/stop playback. Check get_transport_recording_context and each returned part's location. For Session material, use launch_clip with explicit launchQuantization only for the chosen part and explain its playback effect; stop that part before auditioning the other when a sequential comparison is requested. Do not claim phase alignment between separately launched clips. For Arrangement material, never pass its ID to launch_clip: ask the user to position/start Arrangement playback or use a separately authorized transport workflow. Do not arm, solo, reroute or change monitoring silently. Stop Session clips with stop_clip or playback with transport_stop when requested. Ask what the user hears and wants changed; re-read before refinements. Do not claim the user heard audio based on readback.
6. When the user chooses a sound, select_instrument_comparison with that choice and finish: true keeps both tracks and ends the handle. A restore choice returns the original's pre-comparison mute and leaves the alternative muted. Neither choice stops playback or deletes tracks. Preserve rejected alternatives until deletion is explicitly requested. Comparison handles are runtime state, not saved in the Set; after reload or restart inspect/list existing comparisons and tracks before continuing.
Report the chosen instrument, exact track/clip, readback and remaining uncertainty. ${confirmWorkflow}`)
    ] })
  },

  "produce-drum-pattern": {
    name: "produce-drum-pattern",
    description: "Plan and write a drum pattern into an exact empty Session clip on the current meter and tempo.",
    arguments: [{ name: "trackId", description: "Target MIDI track ID from list_tracks.", required: true }],
    build: ({ trackId }) => ({ description: "Write a guarded drum pattern clip.", messages: [
      userMessage(`Create a drum pattern in my Live Set.
1. get_song_grid_reference to read the current meter-aware step map.
2. list_clips for track ${trackId} and pick one empty clip slot (hasClip false) as the destination.
3. plan_drum_pattern with an explicit lane set (kick, snare, hats on MIDI notes that suit the track), then create_drum_pattern_clip with trackId ${trackId} and that clip ID. ${confirmWorkflow}`)]
    })
  },

  "harmonize-clip": {
    name: "harmonize-clip",
    description: "Analyze a MIDI clip against the current Live key and correct or revoice it into scale.",
    arguments: [
      { name: "trackId", description: "Track ID from list_tracks.", required: true },
      { name: "clipId", description: "Clip ID from list_clips or list_arrangement_clips.", required: true }
    ],
    build: ({ trackId, clipId }) => ({ description: "Analyze and correct one MIDI clip.", messages: [
      userMessage(`Harmonize the MIDI clip ${clipId} on track ${trackId}.
1. analyze_midi_clip_scale for ${clipId} - read per-note scale degrees and chromatic outliers.
2. If outliers exist, correct_midi_clip_to_scale with the explicit direction and a reviewed dry run.
3. Optionally inspect analyze_midi_clip_chords, then propose plan_midi_diatonic_chord_quality or plan_midi_chord_voice_leading and apply with apply_midi_diatonic_chord_quality. ${confirmWorkflow}`)]
    })
  },

  "build-producer-chain": {
    name: "build-producer-chain",
    description: "Build a producer track chain from a named blueprint using factory browser loads and verify it.",
    arguments: [{ name: "target", description: "Blueprint target such as bass, vocals, synth, mix-bus, or mastering.", required: true }],
    build: ({ target }) => ({ description: "Assemble and verify one producer chain.", messages: [
      userMessage(`Build the "${target}" producer chain.
1. get_producer_chain_blueprint for target ${target} - note its exact browser paths and stage order.
2. create_track (or an existing track ID) as the destination, then load_browser_item for each stage in order onto that track.
3. inspect_producer_chain for ${target} on the track and report matchesRequiredOrder and any profile mismatches. ${confirmWorkflow}
Loading may replace an existing instrument: check the tool's loadBehavior warning before confirming.`)]
    })
  },

  "arrangement-rework": {
    name: "arrangement-rework",
    description: "Inspect and edit MIDI notes on a placed Arrangement clip with guarded transforms.",
    arguments: [
      { name: "trackId", description: "Track ID from list_tracks.", required: true },
      { name: "clipId", description: "Arrangement clip ID from list_arrangement_clips.", required: true }
    ],
    build: ({ trackId, clipId }) => ({ description: "Rework one Arrangement MIDI clip.", messages: [
      userMessage(`Rework the Arrangement MIDI clip ${clipId} on track ${trackId}.
1. list_arrangement_clips for track ${trackId} and confirm the clip's startBeats and lengthBeats.
2. get_midi_clip_notes_extended for ${clipId} - the response carries location "arrangement" and timeline identity.
3. Propose edits with transform_midi_notes (quantize, legato, or duplicate) or set_midi_note_properties, then apply each through its dry-run plan and confirmation token. ${confirmWorkflow}`)]
    })
  }
};

export function listPrompts() {
  return Object.values(promptContracts).map(({ name, description, arguments: args }) => ({
    name, description, arguments: args
  }));
}

export function getPrompt(name, args = {}) {
  const contract = promptContracts[name];
  if (!contract) throw Object.assign(new Error(`unknown prompt ${name}`), { code: -32602 });
  const required = contract.arguments.filter(({ required: isRequired }) => isRequired);
  const missing = required.filter(({ name: argument }) => args?.[argument] === undefined || args?.[argument] === null || args?.[argument] === "");
  if (missing.length) {
    throw Object.assign(new Error(`missing required prompt argument(s): ${missing.map(({ name: key }) => key).join(", ")}`), { code: -32602 });
  }
  return contract.build(args ?? {});
}
