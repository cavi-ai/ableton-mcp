import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { getPluginIntegrationProfile } from "../src/plugin-integrations.mjs";

test("supported synth aliases resolve to stable product integration profiles", () => {
  const serum = getPluginIntegrationProfile({ name: "Serum 2", className: "PluginDevice" });
  assert.deepEqual({ ...serum, presetNavigation: undefined }, {
    id: "serum-2", productSlug: "serum-2", displayName: "Serum 2", vendor: "Xfer Records",
    aliases: ["Serum", "Serum 2"], browserQuery: "Serum 2", preferredFormat: "VST3",
    presetNavigation: undefined
  });
  assert.equal(getPluginIntegrationProfile({ name: "Omnisphere", className: "PluginDevice" }).productSlug, "omnisphere");
  assert.equal(getPluginIntegrationProfile({ name: "VPS Avenger", className: "PluginDevice" }).productSlug, "vps-avenger");
  assert.equal(getPluginIntegrationProfile({ name: "Serum 2 FX", className: "PluginDevice" }), undefined);
  assert.equal(getPluginIntegrationProfile({ name: "Serum 2", className: "InstrumentDevice" }), undefined);
});

test("plugin integration context joins installed variants, Live exposure, and NKS coverage", async () => {
  const device = { id: "track-0:device-0", name: "Serum 2", className: "PluginDevice",
    classDisplayName: "Serum 2", type: "instrument", active: true };
  const parameters = [
    { id: "parameter-0", name: "Device On", originalName: "Device On", enabled: true },
    { id: "parameter-1", name: "Cutoff", originalName: "Cutoff", enabled: true },
    { id: "parameter-2", name: "Macro 1", originalName: "Macro 1", enabled: false }
  ];
  const catalog = {
    search: () => [], get: () => undefined,
    products: () => [{ productSlug: "serum-2", count: 10311 }]
  };
  const bridge = { async request(method, args) {
    if (method === "list_devices") return { stateVersion: 7, trackId: "track-0", devices: [device] };
    if (method === "list_device_parameters") return { stateVersion: 7, trackId: "track-0", deviceId: device.id, parameters };
    if (method === "search_browser_items") {
      assert.deepEqual(args, { root: "plugins", path: [], query: "Serum 2", maxDepth: 6, limit: 50 });
      return { stateVersion: 7, root: "plugins", path: [], query: "Serum 2", results: [
        { name: "Serum 2", path: ["AUv2", "Xfer Records", "Serum 2"], loadable: true },
        { name: "Serum 2", path: ["VST", "Serum 2"], loadable: true },
        { name: "Serum 2", path: ["VST3", "Xfer Records", "Serum 2"], loadable: true }
      ] };
    }
    throw new Error(`unexpected method ${method}`);
  } };
  const service = new ToolService({ bridge, catalog });
  const result = await service.call("get_plugin_integration_context", {
    trackId: "track-0", deviceId: device.id
  });
  assert.equal(result.stateVersion, 7);
  assert.equal(result.profile.productSlug, "serum-2");
  assert.deepEqual(result.installedVariants.map(({ format }) => format), ["AUv2", "VST", "VST3"]);
  assert.equal(result.installedVariants.find(({ format }) => format === "VST").vendor, null);
  assert.equal(result.recommendedVariant.format, "VST3");
  assert.deepEqual(result.parameterExposure, {
    total: 3, configuredControlIds: ["parameter-1", "parameter-2"],
    writableControlIds: ["parameter-1"], configureInLiveRequired: false,
    hiddenPluginStateReadable: false
  });
  assert.deepEqual(result.nksCatalog, { configured: true, productSlug: "serum-2", presetCount: 10311 });
  assert.equal(result.capabilities.parameterRead, true);
  assert.equal(result.capabilities.parameterWrite, true);
  assert.equal(result.capabilities.hiddenStateRead, false);
  assert.equal(result.capabilities.nativePresetRecall, false);
  assert.deepEqual(result.presetNavigation, {
    entryPoint: "Click the preset name in Serum 2's top bar to open the preset browser.",
    browseBy: ["bank", "category", "subcategory", "author"],
    search: "Use the preset browser search field; clear it before changing browse filters.",
    load: "Select a preset row in the browser to load it, then close the browser or return to the synth page.",
    previousNext: "Use the previous/next arrows beside the preset name for adjacent presets in the active browser result set.",
    verify: "Read the preset name shown in Serum 2's top bar after loading.",
    automation: {
      surface: "opaque-plugin-window",
      directControlAvailable: false,
      reason: "Live does not expose Serum 2's internal preset browser or loaded preset name through the control-surface API."
    }
  });
});

test("plugin integration context reports installed but unconfigured Omnisphere without overstating control", async () => {
  const device = { id: "track-0:device-0", name: "Omnisphere", className: "PluginDevice",
    classDisplayName: "Omnisphere", type: "instrument", active: true };
  const service = new ToolService({ catalog: { search: () => [], get: () => undefined, products: () => [] },
    bridge: { async request(method) {
      if (method === "list_devices") return { stateVersion: 4, devices: [device] };
      if (method === "list_device_parameters") return { stateVersion: 4, parameters: [
        { id: "parameter-0", name: "Device On", originalName: "Device On", enabled: true }
      ] };
      if (method === "search_browser_items") return { stateVersion: 4, results: [
        { name: "Omnisphere", path: ["VST3", "Spectrasonics", "Omnisphere"], loadable: true }
      ] };
      throw new Error(`unexpected method ${method}`);
    } } });
  const result = await service.call("get_plugin_integration_context", {
    trackId: "track-0", deviceId: device.id
  });
  assert.equal(result.parameterExposure.configureInLiveRequired, true);
  assert.equal(result.capabilities.parameterWrite, false);
  assert.deepEqual(result.nksCatalog, { configured: false, productSlug: "omnisphere", presetCount: 0 });
  assert.deepEqual(result.presetNavigation.browseBy, ["directory", "category", "type", "genre", "author"]);
  assert.match(result.presetNavigation.load, /double-click/i);
  assert.match(result.limitations[0], /hidden plug-in state/i);
});

test("Avenger profile describes its expansion-aware preset navigation without claiming native recall", () => {
  const profile = getPluginIntegrationProfile({ name: "VPS Avenger", className: "PluginDevice" });
  assert.deepEqual(profile.presetNavigation.browseBy, ["expansion", "category", "tag", "author"]);
  assert.match(profile.presetNavigation.entryPoint, /preset name/i);
  assert.equal(profile.presetNavigation.automation.directControlAvailable, false);
});

test("plugin integration context is exposed as a read-only MCP tool", async () => {
  const service = { async call(name) {
    assert.equal(name, "get_plugin_integration_context");
    return { profile: { productSlug: "vps-avenger" } };
  } };
  const reply = await createRouter(service)({ id: 1, method: "tools/call", params: {
    name: "get_plugin_integration_context", arguments: { trackId: "track-0", deviceId: "track-0:device-0" }
  } });
  assert.equal(reply.result.structuredContent.profile.productSlug, "vps-avenger");
});
