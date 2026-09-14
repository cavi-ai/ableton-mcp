# Shared instrument audio buses

A dedicated audio track can process multiple instrument tracks together. Children retain their own instruments, MIDI clips, and local effects; their audio outputs feed the bus. This is not a native Group Track or a shared multitimbral instrument.

## Build through MCP

1. Create an audio bus with `create_track` and a unique name. Retain the returned ID; do not infer IDs from names or positions.
2. Read `get_track_routing`. With `set_track_routing`, select the observed `No Input` input choice and monitoring `in`; keep the bus output on Main or its intended downstream destination.
3. Load effects using `load_browser_item` and exact browser paths. Verify `list_devices` after loading; reorder with `move_device` when needed.
4. Create MIDI children and load their instruments. Inspect each load plan: loading can replace an existing instrument/rack. Use an empty child or a staging track for additional layers.
5. Read each child's routing. Resolve exactly one output choice matching the unique bus name; reject ambiguity. Set that observed output type ID, read again, and select the observed `Track In` channel if necessary. Choice IDs may be labels, not persistent object IDs; re-read after renaming or structural changes.
6. Verify all child outputs, bus input/monitoring/output, and device order. Inspect downstream routing; never route a bus back into a child or upstream bus.

Every mutation defaults to dry-run. Supply a fresh `expectedStateVersion`, review the plan, then execute using its single-use `confirmationToken` and `planHash`. Readback is required: UI changes do not necessarily advance the native bridge counter.

## Processing order

Utility → EQ Eight → Compressor → Saturator is one bass-bus starting configuration: gain/stereo management, tone shaping before dynamics, combined dynamics, then harmonics. It is not a universal mastering prescription. Saturation before compression changes the signal driving compression. Use native display values and bounds, leave headroom, and compare audibly at matched level.

Keep sound-specific processing on children when it should not affect every layer. Return sends provide parallel effects; returns and serial buses are different workflows. Audio-bus routing is also different from sending child MIDI into one shared instrument.

## Verification and recall limits

Native routing/device readback proves configured topology, not audible signal flow, clipping safety, mix quality, or rendering equivalence. Verify playback/meters or captured output separately. Saving a Live Set preserves its tracks and routing, but general track-template save/recall and native Group Track creation are not provided by this workflow.
