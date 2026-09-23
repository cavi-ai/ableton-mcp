# Preset catalog

The NKS preset catalog is optional. It is a local SQLite database of presets discovered in your plug-in libraries. It backs `search_presets`, `get_preset`, the preset metadata tools, and the `nks://catalog/*` resources. Without it, preset search returns an empty collection and everything else works.

## Point the plug-in configs at your libraries

`config/plugins/*.json` holds one file per product:

```json
{
  "productSlug": "serum-2",
  "vendor": "Xfer Records",
  "product": "Serum 2",
  "factoryRoots": ["~/Library/Audio/Presets/Serum Presets/Presets"],
  "extensions": [".fxp"],
  "enabled": true
}
```

Set `factoryRoots` to the folders that hold your factory presets. A leading `~/` expands to your home directory. Empty roots discover nothing. Discovery adapters exist for `serum-2` (`.fxp` files; `User` folders and hidden files are skipped) and `omnisphere` (patches embedded in the library's `.db` files).

## Build the catalog

```bash
npm run catalog:inventory
```

For every enabled product, this discovers presets, then writes `reports/nks/manifest.json` and `reports/nks/catalog.sqlite`. Pass `--product <slug>` to inventory one product. `--config-dir`, `--manifest` and `--catalog` override the default paths.

Runs are incremental. A preset whose source fingerprint hasn't changed is reported as `unchanged` and keeps its record. An enabled product without a discovery adapter is an error.

A preset the run no longer finds on disk is flagged `missing: true` and counted as `missing`. Its catalog row, tags, favorite state and artwork stay in place. `search_presets` and the product counts skip it, and `get_preset` still returns it with the flag. When the file is back on the next run, the flag is cleared and the preset returns to search with its tags. A misconfigured or empty `factoryRoots` therefore hides presets rather than deleting your metadata. Fix the path and run the inventory again.

Vendor presets stay on your machine. The repository ignores `reports/`, and nothing is uploaded.

## Use it from the server

```bash
ABLETON_MCP_CATALOG_PATH="$PWD/reports/nks/catalog.sqlite" npm run cli -- call search_presets --args '{"query":"bass"}' --json
```

Set the same variable in your MCP client's server entry.

## Tags and favorites

User tags and favorites are stored in their own tables. Vendor preset records are never altered. `get_preset_metadata` returns the current revision. `set_preset_metadata` requires that revision plus the standard dry-run and confirmation steps before it replaces tags or favorite state. `search_presets` can filter by favorite state and require all supplied tags.

Live browser items have a separate local tag store: `get_browser_item_metadata`, `set_browser_item_metadata` and `search_browser_item_metadata`. It lives at `ABLETON_MCP_BROWSER_METADATA_PATH`. Live's own color Collections are not changed.
