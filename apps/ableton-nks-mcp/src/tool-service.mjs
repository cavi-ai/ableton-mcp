import { assertExpectedState } from "./bridge-protocol.mjs";
import { ConfirmationStore, hashPlan } from "./confirmation-store.mjs";
import { CatalogService } from "./catalog-service.mjs";

export class ToolService {
  constructor({ bridge, catalog, confirmations = new ConfirmationStore() }) {
    this.bridge = bridge;
    this.catalog = new CatalogService(catalog);
    this.confirmations = confirmations;
  }

  async call(name, args = {}) {
    if (name === "search_presets") {
      return { presets: this.catalog.search(args) };
    }
    if (name === "get_preset") return { preset: this.catalog.get(args.presetId) };
    if (name === "get_live_state") return this.bridge.request("get_live_state", {});
    if (name === "list_tracks") return this.bridge.request("list_tracks", {});
    if (name === "list_devices") return this.bridge.request("list_devices", args);
    if (name === "list_device_parameters") {
      return this.bridge.request("list_device_parameters", args);
    }
    if (name === "set_device_parameters") return this.#setDeviceParameters(args);
    if (["load_nks_preset", "recall_macro_snapshot", "panic"].includes(name)) {
      return this.#genericMutation(name, args);
    }
    throw new Error(`unknown tool ${name}`);
  }

  async readResource(uri) {
    if (uri === "nks://catalog/products") return { products: this.catalog.products() };
    if (uri.startsWith("nks://catalog/presets/")) {
      return { preset: this.catalog.get(decodeURIComponent(uri.slice("nks://catalog/presets/".length))) };
    }
    if (uri.startsWith("nks://catalog/artwork/")) {
      return {
        artwork: this.catalog.artwork(
          decodeURIComponent(uri.slice("nks://catalog/artwork/".length))
        )
      };
    }
    if (uri === "ableton://live/status") return this.bridge.request("get_live_state", {});
    if (uri === "ableton://set/tracks") return this.bridge.request("list_tracks", {});
    const trackDevices = uri.match(/^ableton:\/\/track\/([^/]+)\/devices$/);
    if (trackDevices) return this.bridge.request("list_devices", { trackId: decodeURIComponent(trackDevices[1]) });
    const deviceParameters = uri.match(/^ableton:\/\/device\/([^/]+)\/parameters$/);
    if (deviceParameters) {
      const deviceId = decodeURIComponent(deviceParameters[1]);
      const trackId = deviceId.split(":device-")[0];
      return this.bridge.request("list_device_parameters", { trackId, deviceId });
    }
    throw new Error(`unknown resource ${uri}`);
  }

  async #setDeviceParameters(args) {
    const observed = await this.bridge.request("list_device_parameters", {
      trackId: args.trackId,
      deviceId: args.deviceId
    });
    assertExpectedState(args, observed);
    const allowed = new Map(observed.parameters.map((parameter) => [parameter.id, parameter]));
    const changes = args.changes.map((change) => {
      const parameter = allowed.get(change.id);
      if (!parameter) throw new Error(`parameter ${change.id} is not allowlisted`);
      return {
        id: change.id,
        value: Math.max(parameter.min, Math.min(parameter.max, Number(change.value)))
      };
    });
    const plan = {
      method: "set_device_parameters",
      trackId: args.trackId,
      deviceId: args.deviceId,
      expectedStateVersion: args.expectedStateVersion,
      changes
    };
    if (args.dryRun !== false) {
      return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    }
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
    const result = await this.bridge.request("set_device_parameters", plan);
    return {
      dryRun: false,
      requested: plan,
      observed: result,
      timestamp: new Date().toISOString(),
      rollback: "Recall the prior macro snapshot or restore the previous parameter values."
    };
  }

  async #genericMutation(name, args) {
    const plan = { method: name, ...args };
    delete plan.dryRun;
    delete plan.confirmationToken;
    delete plan.planHash;
    if (args.dryRun !== false) {
      return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    }
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
    const observed = await this.bridge.request(name, plan);
    return { dryRun: false, requested: plan, observed, timestamp: new Date().toISOString() };
  }
}
