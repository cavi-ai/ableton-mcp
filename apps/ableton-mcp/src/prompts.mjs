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
    description: "Survey the current Live Set: set file, tempo, key and scale, tracks, scenes, and undo availability.",
    arguments: [],
    build: () => ({ description: "Read-only survey of the current Live Set.", messages: [
      userMessage(`Survey my current Ableton Live Set using these MCP tools, in this order:
1. get_live_state - report the set file path, tempo, playback state, and nativeApiSupport.
2. get_song_musical_context - report key (root and scale), time signature, quantization, groove pool, swing, and Arrangement loop.
3. list_tracks - list every track with its type, mixer basics, and group membership.
4. list_scenes - report scene count and per-scene launch quantization.
5. get_history_state - report undo/redo availability.
Finish with a short producer-oriented summary: what the set looks like musically, anything that looks unfinished, and two concrete next steps using other available tools. ${confirmWorkflow}`)]
    })
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
