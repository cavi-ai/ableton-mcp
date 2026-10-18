export class CatalogService {
  constructor(catalog) {
    this.catalog = catalog;
  }

  status() {
    const configured = Boolean(this.catalog) && this.catalog.configured !== false;
    return { configured, ...(!configured ? {
      setup: { environmentVariable: "ABLETON_MCP_CATALOG_PATH", restartServer: true },
      fallback: { discoveryTool: "list_browser_roots", searchTool: "search_browser_items" }
    } : {}) };
  }

  #configured() {
    if (!this.status().configured) throw new Error(
      "preset catalog is not configured; set ABLETON_MCP_CATALOG_PATH to an existing catalog and restart the server. " +
      "For Live browser sounds, use list_browser_roots and search_browser_items."
    );
    return this.catalog;
  }

  search({ productSlug, query = "", favorite, tags = [], limit = 50 }) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    if (!this.status().configured) return [];
    return this.catalog.search({ productSlug, query, favorite, tags }).slice(0, boundedLimit);
  }

  get(presetId) {
    const preset = this.#configured().get(presetId);
    if (!preset) throw new Error(`unknown preset ${presetId}`);
    return preset;
  }

  products() {
    if (!this.status().configured) return [];
    return this.catalog.products();
  }

  productStateCounts(productSlug) {
    return typeof this.catalog.productStateCounts === "function" ? this.catalog.productStateCounts(productSlug) : null;
  }

  artwork(id) {
    const artwork = this.#configured().getArtwork(id);
    if (!artwork) throw new Error(`unknown artwork ${id}`);
    return artwork;
  }

  artworkForPreset(presetId) {
    const artwork = this.#configured().artworkForPreset(presetId);
    if (!artwork) throw new Error(`no artwork assigned to preset ${presetId}`);
    return artwork;
  }

  metadata(presetId) {
    return this.#configured().metadata(presetId);
  }

  planMetadataUpdate(presetId, expectedRevision, changes) {
    return this.#configured().planMetadataUpdate(presetId, expectedRevision, changes);
  }

  setMetadata(presetId, expectedRevision, changes) {
    return this.#configured().setMetadata(presetId, expectedRevision, changes);
  }
}
