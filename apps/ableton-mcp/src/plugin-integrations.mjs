const opaqueAutomation = product => ({
  surface: "opaque-plugin-window",
  directControlAvailable: false,
  reason: `Live does not expose ${product}'s internal preset browser or loaded preset name through the control-surface API.`
});

const profiles = [
  {
    id: "serum-2", productSlug: "serum-2", displayName: "Serum 2", vendor: "Xfer Records",
    aliases: ["Serum", "Serum 2"], browserQuery: "Serum 2", preferredFormat: "VST3",
    presetNavigation: {
      entryPoint: "Click the preset name in Serum 2's top bar to open the preset browser.",
      browseBy: ["bank", "category", "subcategory", "author"],
      search: "Use the preset browser search field; clear it before changing browse filters.",
      load: "Select a preset row in the browser to load it, then close the browser or return to the synth page.",
      previousNext: "Use the previous/next arrows beside the preset name for adjacent presets in the active browser result set.",
      verify: "Read the preset name shown in Serum 2's top bar after loading.",
      automation: opaqueAutomation("Serum 2")
    }
  },
  {
    id: "omnisphere", productSlug: "omnisphere", displayName: "Omnisphere", vendor: "Spectrasonics",
    aliases: ["Omnisphere"], browserQuery: "Omnisphere", preferredFormat: "VST3",
    presetNavigation: {
      entryPoint: "Click Omnisphere's patch-name display or Browser control to open the patch browser for the active part.",
      browseBy: ["directory", "category", "type", "genre", "author"],
      search: "Use the browser search field after choosing the target directory; clear the query to restore the full filtered result set.",
      load: "Double-click a patch row to load it into the active part.",
      previousNext: "Use the patch previous/next controls to step through the current filtered result set.",
      verify: "Read the active part's patch-name display after loading.",
      automation: opaqueAutomation("Omnisphere")
    }
  },
  {
    id: "vps-avenger", productSlug: "vps-avenger", displayName: "VPS Avenger", vendor: "Vengeance",
    aliases: ["Avenger", "VPS Avenger"], browserQuery: "VPS Avenger", preferredFormat: "VST3",
    presetNavigation: {
      entryPoint: "Click the preset name in Avenger's top bar to open its preset browser.",
      browseBy: ["expansion", "category", "tag", "author"],
      search: "Use the preset browser search field within the selected expansion or category, then clear it before changing browse scope.",
      load: "Select a preset in the browser result list to load it.",
      previousNext: "Use the arrows beside the preset name to move through the active browser result set.",
      verify: "Read the preset name in Avenger's top bar after loading.",
      automation: opaqueAutomation("Avenger")
    }
  }
];

export function getPluginIntegrationProfile(device) {
  if (device?.className !== "PluginDevice") return undefined;
  const name = (device.name || "").trim().toLowerCase();
  return profiles.find(profile => profile.aliases.some(alias => alias.toLowerCase() === name));
}
