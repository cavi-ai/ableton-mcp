# Native saving and recall

Live Set and device-preset saving currently require Live's native UI. They are not MCP save commands. Komplete NKS saving is a separate workflow and does not save a Live Set, track, or rack.

## Save a Live Set

Use **Save Live Set As** to choose a new destination and name. In the macOS save panel, **Cmd+Shift+G** opens the destination-path field. Enter an existing writable folder and press Return. After setting the filename, press Tab to commit the text field before clicking Save; the Save button can remain disabled while the filename edit is uncommitted.

Verify that the panel closes, the main window displays the saved Set's name and file URL, and the `.als` file exists at that destination. A save attempt or a dismissed panel is not evidence of a saved Set. Subsequent **Cmd+S** saves update the current Set.

Saving a Set is not evidence that external samples have been collected into its Project. Check sample dependencies separately before moving or sharing a Project. Keep third-party presets, commercial samples, and test Sets out of the source-code repository.

## Save and load a device preset

Select the intended device and click its **Save Preset** button. Live opens the device's location in the User Library with the new preset's name editable. Set a unique name and press Return. This workflow was exercised with EQ Three: it produced an `.adv` browser item and renamed the source device to the chosen preset name.

Double-clicking that browser item loaded another EQ Three into the selected track, rather than replacing the existing source device. Inspect the device chain after loading: adding another EQ or dynamics processor changes signal processing. Do not assume ordinary browser loading means replacement. Use the device's explicit Hot-Swap control when replacement is intended, then verify the resulting chain.

For recall acceptance, compare native class identity and every exposed parameter's original name and raw value before saving and after loading. EQ Three's ten exposed parameter values matched exactly in the exercised save/load workflow. This does not prove audio equivalence, hidden third-party state, sample portability, macro mappings, or full track-template recall.

## MCP recall of a saved User Library preset

Saved native device presets can already be found with `search_browser_items` and loaded with guarded `load_browser_item`. Search `root: "user_library"` below the exact device folder, then use the returned path without guessing spelling or filename extensions. For example, the exercised EQ Three preset was found below `["Presets", "Audio Effects", "EQ Three"]` and loaded using the returned four-segment path including its `.adv` filename.

Read the current state version, obtain the load dry-run plan, then execute with its confirmation token and plan hash. Observe the chain again afterward. The exercised MCP load added a third EQ Three to the acceptance track; all ten exposed parameter names and raw values matched the source. It did not replace either existing device. Saving still required native UI.

## Exposed-parameter JSON capture and recall

`capture_device_parameter_snapshot` returns a JSON `snapshot` for an exact loaded device. Persist that object locally, then pass it to guarded `recall_device_parameter_snapshot` with the target track/device and fresh state version. Recall supports a matching native class and exact ordered parameter layout, including bounds and enumerated choices; renamed devices are allowed. Changed disabled controls are rejected, unchanged controls are left alone, and a snapshot already matching the target reports that no changes are required.

Read parameters independently after recall rather than treating the mutation acknowledgment as acceptance. EQ Three acceptance captured ten parameters, changed low gain, and recalled all original values exactly. These snapshots are not `.adv`, `.adg`, NKS or complete third-party presets: they omit hidden state, samples, automation and mappings. Native preset saving remains necessary for those other forms of state.

## Live browser Favorites

Live's color Collections are separate from NKS catalog tags and favorites. In the native browser, open the saved item's context menu and select the named collection. In the exercised acceptance, the menu initially showed Clear All Colors checked and Favorites unchecked; selecting Favorites made the saved EQ Three preset appear in the Favorites collection's one-item list.

Verify membership by opening the collection and finding the exact item. If its sidebar row is offscreen, scroll the Browser Sidebar upward before clicking it. Read the current collection label rather than assuming that a color index always has a particular user-visible name. No universal Live browser collection/tag mutation is currently exposed through MCP.

## Boundaries

- A device preset is not a complete track or shared-bus system.
- Native UI saving is not yet a reusable MCP/CLI save adapter.
- Track-template, rack/FX-chain, third-party hidden-state, and full-Project recall each require their own workflow and acceptance evidence.
- Automation should handle its own test-set save/discard prompts; they are not an ownership or permission question.
