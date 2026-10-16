const confirmWorkflow = [
  "Treat every mutation as two steps: first call the tool without dryRun to receive its dry-run plan and a single-use confirmationToken, review the plan hash, then repeat the call with dryRun: false plus that confirmationToken and planHash to execute.",
  "Reuse the stateVersion reported by the immediately preceding read for expectedStateVersion; retry from fresh reads whenever a stale-state error occurs."
].join(" ");

const userMessage = (text) => ({ role: "user", content: { type: "text", text } });

export const promptContracts = {
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
    description: "Orient to the current Set and displayed clip, separating configured scale from musical evidence and uncertainty.",
    arguments: [],
    build: () => ({ description: "Read-only survey of the current Live Set.", messages: [
      userMessage(`Orient me to my current Ableton Live Set without making changes.
1. Call get_session_orientation. If I requested another Set, use open_live_set only through its reviewed confirmation flow, verify the opened path, then orient again. Do not switch Sets just to inspect them.
2. Summarize the file, tempo, meter, playback and recording state, track structure and actual displayed clip. Distinguish selection.detailClip from the highlighted slot and selected track. Use the displayed clip's owner for musical and instrument discussion.
3. Separate the configured key and scale in musicalContext from focus.tonalEvidence. get_song_musical_context also reports configuration, not a detected key. Explain relative-key and modal ambiguity. Support fractions are compatibility measurements, never probabilities or proof of a tonic. Do not claim that selected-clip evidence establishes the entire song's key. Audio, drums, recording, note-limit and no-clip statuses mean no tonal inference; ask for relevant material only if needed.
4. Describe observed instruments and pitch content without inventing genre, arrangement completeness, track roles, audio quality or what the user heard. Ask about musical intent when observations leave alternatives open.
Finish with a brief musical summary and two relevant next actions. Offer explore-selected-instrument for sound exploration or develop-selected-midi-clip for note alternatives. Keep all edits and playback outside this survey. ${confirmWorkflow}`)]
    })
  },

  "explore-selected-instrument": {
    name: "explore-selected-instrument",
    description: "Understand the selected part and compare instrument directions with the user before changing sounds.",
    arguments: [{ name: "request", description: "Sound direction or instruments to explore.", required: true }],
    build: ({ request }) => ({ description: "Collaborative instrument exploration.", messages: [
      userMessage(`Help me explore instruments for this request: ${request}
1. get_session_orientation: establish the exact part, its owner track, current devices, configured scale and scoped tonal evidence. Resolve ambiguity with the user instead of inventing a key or substituting the selected track for another displayed clip. If there is no displayed MIDI clip, ask which part to use; if recording or frozen, explain the limitation before changes.
2. Keep the original instrument and notes while discussing two or three sound directions. Use list_devices and get_device_hierarchy for the exact owner. Call get_plugin_integration_context only for an identified supported Serum 2/Omnisphere/VPS Avenger device; use get_factory_device_context for native instruments. Then search_browser_items or search_browser_roots to find actually available instruments. Do not assume an NKS catalog preset is loadable into Live or that a browser name identifies a verified preset. Explain which candidates fit the user's intention and why; measurements do not prove sound quality.
3. Let the user choose a candidate and comparison method before any mutation. Device-chain parameter snapshots do not preserve complete instruments, topology or opaque plug-in state. Do not promise reversible instrument A/B from those snapshots or delete the original instrument to make room. If the user requests replacement on this track, first offer a separate saved working Set. save_live_set saves the current named Set and cannot perform Save As: ask the user to create a working copy with Live's Save Live Set As, then re-read get_session_orientation, verify the user-agreed new path, and use guarded save_live_set to verify that checkpoint before loading anything. Keep the original file untouched and explain that returning to it may discard later edits. If a checkpoint cannot be verified, stop before replacement and explain the missing recovery path.
4. Before loading, read get_midi_clip_notes_extended and get_clip_timing for the exact part as the preservation baseline; orientation's aggregate pitch evidence cannot prove note preservation. For an authorized load, read load_browser_item's dry-run plan, replacement warning and exact target. Confirm only the user's chosen candidate on the agreed owner. Read back list_devices, notes and timing after the load; compare the complete note/timing baseline and report any difference. If the user edits the part between those reads, re-read and resolve the difference rather than overwriting it. If loading fails or the user cancels, read the current state; never silently retry or use global undo after manual edits.
5. Offer audition only when requested or already authorized. Check get_transport_recording_context and branch on focus.location. For a Session part, explain which clip launch replaces current playback and use launch_clip with explicit launchQuantization. For an Arrangement part, never pass its ID to launch_clip: ask the user to position/start Arrangement playback or use a separately authorized transport workflow. Do not arm, solo, reroute or change monitoring silently. Stop Session clips with stop_clip or playback with transport_stop when requested. Ask what the user hears and wants changed; re-read before refinements. Do not claim the user heard audio based on readback.
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
