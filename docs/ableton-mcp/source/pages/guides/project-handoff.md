# Collect Project samples for handoff

Use `prepare-project-handoff` through `get_producer_workflow` to prepare the current Set for backup or collaboration. The workflow saves intended edits, inspects saved sample references, uses Live’s native **Collect All and Save**, and checks the copied samples. Sharing or uploading the Project requires separate intent.

## Inspect the saved Set

`get_project_media` in the `all` profile reads nonempty `SampleRef` entries from the saved Live 12 Set, including references in clips and sample devices. It resolves Project-relative, Set-relative and absolute file paths, reports missing or ambiguous sources, and hashes actual file contents. `savedSnapshotMatchesLive` requires matching native document identity and a clean Save state; otherwise the inventory describes the saved file rather than current unsaved work. Inspection does not activate Live or send UI input.

Save into a dedicated Project first. The nearest `Ableton Project Info` directory identifies that Project. Inspection supports gzip-compressed Live 12 Sets within 64 MiB compressed and decompressed size, 4096 nonempty sample references, and bounded XML nesting. Unsupported structures, document-type/entity declarations and files changing during inspection are refused. File hashes can take time for large sample libraries. The saved file format is not a public Live API; unsupported schema changes require renewed validation before collection can proceed.

## Collect and verify

`collect_project_media` requires macOS English Live, Accessibility/Automation access, one expected Live instance, a clean named Set, stopped playback/recording, and fresh `expectedStateVersion` and `expectedSetFingerprint`. Planning binds the saved Set, Project identity, sample references and source contents without UI input. Missing or ambiguous samples must be resolved first. The tool does not replace them or remove their references.

Confirmed execution activates the exact document and opens **Collect All and Save**. It selects all four native categories: elsewhere, other Projects, User Library and Factory Packs. This can copy large libraries and saves the Set in its existing Project. It changes Live’s collection choices and does not choose a new destination. A smaller collection scope needs deliberate preparation in Live.

`sampleCollectionVerified:true` requires an idle native UI, a clean saved Set in the same Project, the same ordered sample references and matching file sizes and SHA-256 contents, with every source now available through a Project-relative reference resolving inside the Project. A symlink pointing outside the Project does not meet this check. Read `get_project_media` again before accepting the handoff.

Plug-ins and licenses must be installed separately. Max for Live devices can have additional dependencies, and opaque plug-in sample libraries are not certified by saved sample references. `completePortabilityVerified` remains false. Other Sets within the Project need their own collection and compatibility checks. This workflow does not establish audible equivalence or recipient compatibility.

Copy the entire Project, including `Ableton Project Info`, when transferring it. Do not copy only the `.als` file. These native collection and transfer behaviors are described in [Ableton’s Collect All and Save guide](https://help.ableton.com/hc/en-us/articles/209775645-Collect-All-and-Save).

If the result is uncertain, inspect Live and the actual files before further input. Only an unchanged dialog owned before collection is cancelled on a pre-command failure. An accepted or unknown collection is never replayed, undone, cancelled mid-copy or cleaned up automatically. Preserve originals and manual edits.
