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

## Boundaries

- A device preset is not a complete track or shared-bus system.
- Native UI saving is not yet a reusable MCP/CLI save adapter.
- Track-template, rack/FX-chain, third-party hidden-state, and full-Project recall each require their own workflow and acceptance evidence.
- Automation should handle its own test-set save/discard prompts; they are not an ownership or permission question.
