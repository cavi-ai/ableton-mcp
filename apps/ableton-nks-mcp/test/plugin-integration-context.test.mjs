import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { getPluginIntegrationProfile } from "../src/plugin-integrations.mjs";

test("supported synth aliases resolve to stable product integration profiles", () => {
  assert.deepEqual(getPluginIntegrationProfile({ name: "Serum 2", className: "PluginDevice" }), {
    id: "serum-2", productSlug: "serum-2", displayName: "Serum 2", vendor: "Xfer Records",
    aliases: ["Serum", "Serum 2"], browserQuery: "Serum 2", preferredFormat: "VST3"
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
  assert.match(result.limitations[0], /hidden plug-in state/i);
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
