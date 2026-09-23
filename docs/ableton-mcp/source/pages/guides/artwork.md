# NKS artwork

The artwork pipeline is optional. It renders Native Instruments browser artwork for presets in your catalog. It needs ImageMagick 7 (`magick`) and a manifest from `npm run catalog:inventory`.

It does not scrape vendor artwork or fill anything in automatically. You supply one master image per product; the pipeline renders deterministic product, bank, category and size variants from it.

## Inputs

- `config/artwork/products.json`: per-product display name, NI image key, and the path to your master image, for example `artwork/nks/masters/serum-2/product-master.png`.
- `config/artwork/categories.json`: how preset types map to artwork categories.
- `config/artwork/derivatives.json`: output names, formats and sizes for NI's image folders.

The `artwork/` and `reports/` folders are ignored by git. Masters, renders and staging never enter the repository.

## Steps

Run each step with `npm --workspace @cavi-ai/nks-pipeline run <script>`:

| Script | Reads | Writes |
|---|---|---|
| `artwork:matrix` | `reports/nks/manifest.json` | `reports/nks/artwork-matrix.json` |
| `artwork:render -- --product <slug>` | the matrix, masters, configs | `artwork/nks/rendered`, `banks`, `variants` |
| `artwork:contact-sheets -- --product <slug>` | the matrix | `reports/nks/artwork-contact-sheets` |
| `artwork:approve -- --product <slug>` | the matrix | approval of every validated record matching `--product` and `--bank`, recorded in `reports/nks/artwork-review.json`; run it after reviewing the contact sheets |
| `artwork:catalog` | the approved matrix | artwork rows in `reports/nks/catalog.sqlite` |
| `artwork:install` | product masters, `derivatives.json` | NI product images staged in `artwork/nks/staging/ni-image`; `-- --apply` copies them into `/Users/Shared/NI Resources/image` |

`artwork:install` is a dry run unless you pass `--apply`. It refuses any target other than `/Users/Shared/NI Resources/image`.

## Example master

`examples/artwork/generic-synth-master.png` is an original, vendor-neutral image for trying the renderer. Its provenance file records how it was made and its MIT license. No vendor artwork, logos or product masters are included in this repository.
