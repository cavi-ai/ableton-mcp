const profiles = [
  { id: "serum-2", productSlug: "serum-2", displayName: "Serum 2", vendor: "Xfer Records",
    aliases: ["Serum", "Serum 2"], browserQuery: "Serum 2", preferredFormat: "VST3" },
  { id: "omnisphere", productSlug: "omnisphere", displayName: "Omnisphere", vendor: "Spectrasonics",
    aliases: ["Omnisphere"], browserQuery: "Omnisphere", preferredFormat: "VST3" },
  { id: "vps-avenger", productSlug: "vps-avenger", displayName: "VPS Avenger", vendor: "Vengeance",
    aliases: ["Avenger", "VPS Avenger"], browserQuery: "VPS Avenger", preferredFormat: "VST3" }
];

export function getPluginIntegrationProfile(device) {
  if (device?.className !== "PluginDevice") return undefined;
  const name = (device.name || "").trim().toLowerCase();
  return profiles.find(profile => profile.aliases.some(alias => alias.toLowerCase() === name));
}
