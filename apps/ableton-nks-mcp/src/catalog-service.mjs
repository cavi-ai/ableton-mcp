export class CatalogService {
  constructor(catalog) {
    this.catalog = catalog;
  }

  search({ productSlug, query = "", limit = 50 }) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.catalog.search({ productSlug, query }).slice(0, boundedLimit);
  }

  get(presetId) {
    const preset = this.catalog.get(presetId);
    if (!preset) throw new Error(`unknown preset ${presetId}`);
    return preset;
  }

  products() {
    return this.catalog.products();
  }

  artwork(id) {
    const artwork = this.catalog.getArtwork(id);
    if (!artwork) throw new Error(`unknown artwork ${id}`);
    return artwork;
  }

  artworkForPreset(presetId) {
    const artwork = this.catalog.artworkForPreset(presetId);
    if (!artwork) throw new Error(`no artwork assigned to preset ${presetId}`);
    return artwork;
  }
}
