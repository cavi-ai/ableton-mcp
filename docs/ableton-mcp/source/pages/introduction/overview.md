# Ableton MCP overview

Ableton MCP {{PRODUCT_VERSION}} gives MCP clients local control of Ableton Live. It has three parts:

- **CaviMcpBridge**: a Live Remote Script. It runs inside Live and serves a Unix domain socket.
- **The MCP server**: a stdio server that turns MCP tool calls into bridge requests.
- **The `ableton-mcp` CLI**: installs the bridge, checks the connection, and calls tools, resources and prompts from a shell.

Everything runs on the local machine. The bridge opens no TCP port. The server makes no network requests.

## What it covers

- **Reads**: transport, tempo, key and scale, quantization, the groove pool, cue points, tracks, scenes, clips, notes, clip envelopes, devices and their parameters, mixer and routing state, freeze state, rack hierarchies, and the Live browser.
- **Guarded mutations**: the same surfaces, plus track, scene and clip lifecycle, device loading and parameters, MIDI note editing and generation, undo and redo, and panic.
- **Music helpers**: scale-aware chords, basslines, melodies, voicings, arpeggios, strums, drum patterns and variations, humanization, and velocity curves. They are planned against the observed Live Set.
- **Audio analysis**: loudness, true peak, spectrum, pitch, transients and tuning of local audio files, using `ffmpeg`.
- **An optional NKS preset catalog**: search, tags and favorites for presets discovered from local plug-in libraries.

The server publishes 22 resources and five prompt templates: `session-overview`, `produce-drum-pattern`, `harmonize-clip`, `build-producer-chain` and `arrangement-rework`. [Tools](../reference/tools.md) lists every tool.

## Boundaries

Live's Remote Script API limits what can be controlled. In Live 12.4.5:

- Arrangement automation envelopes are not exposed.
- Per-note pitch bend, pressure and slide are not exposed.
- Group Tracks cannot be created or ungrouped.
- Grooves cannot be created or deleted through the public Groove Pool API.
- `Track.is_frozen` has no setter.

The server reports each boundary. `get_automation_capabilities` and `get_live_state.nativeApiSupport` list the exact supported surface. The server fails closed instead of simulating a write that Live does not support.

These docs were generated for release {{RELEASE_TAG}} from commit `{{RELEASE_COMMIT}}`.
