# Version and support

These docs describe Ableton MCP {{PRODUCT_VERSION}}, release {{RELEASE_TAG}}, built from commit `{{RELEASE_COMMIT}}`.

The server and the bridge ship together and share a version. `doctor` refuses a bridge that reports a different version, so reinstall the bridge after every upgrade.

The supported environment is macOS with Ableton Live 12 and Node.js 22.13 or newer. This release was verified against Live 12.4.5. Other Live 12 releases may add or remove Remote Script API surface; `get_automation_capabilities` and `get_live_state.nativeApiSupport` report what the running Live exposes.

To upgrade, check out the release tag, run `npm ci`, then run `npm run cli -- install` and restart Live.

When you report a problem, include:

- the Ableton MCP version,
- the Live version and edition,
- the macOS version,
- the Node.js version,
- `doctor --json` output, and
- the failing tool call with its error.

Don't include Live Sets, samples, presets, or anything else you don't have the right to share.
