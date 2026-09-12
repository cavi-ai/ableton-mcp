const globalRoles = { global: ["device on", "on/off"] };

const profiles = [
  { id: "simpler", name: "Simpler", type: "instrument", family: "sampler", match: ["simpler", "originalsimpler"], roles: { ...globalRoles, sample: ["sample", "start", "end", "loop"], pitch: ["transpose", "detune", "pitch"], filter: ["filter", "freq", "resonance"], amplitude: ["volume", "gain", "attack", "decay", "sustain", "release"] } },
  { id: "sampler", name: "Sampler", type: "instrument", family: "sampler", match: ["sampler", "multi sampler", "multisampler"], roles: { ...globalRoles, sample: ["sample", "zone", "loop", "start", "end"], pitch: ["transpose", "detune", "pitch"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope", "modulation"], amplitude: ["volume", "attack", "decay", "sustain", "release"] } },
  { id: "drum-rack", name: "Drum Rack", type: "instrument", family: "rack", match: ["drum rack", "instrumentgroupdevice"], roles: { ...globalRoles, macro: ["macro"], chain: ["chain", "selector"], mix: ["volume", "pan", "send"] } },
  { id: "analog", name: "Analog", type: "instrument", family: "synthesizer", match: ["analog", "ultraanalog"], roles: { ...globalRoles, oscillator: ["osc", "shape", "octave", "semitone", "detune"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope"], amplitude: ["amp", "volume", "attack", "decay", "sustain", "release"] } },
  { id: "drift", name: "Drift", type: "instrument", family: "synthesizer", match: ["drift"], roles: { ...globalRoles, oscillator: ["osc", "shape", "wave", "octave", "detune"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope", "mod"], amplitude: ["amp", "volume", "attack", "decay", "sustain", "release"] } },
  { id: "operator", name: "Operator", type: "instrument", family: "fm-synthesizer", match: ["operator"], roles: { ...globalRoles, oscillator: ["osc", "operator", "coarse", "fine", "level"], algorithm: ["algorithm"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope"], amplitude: ["volume", "attack", "decay", "sustain", "release"] } },
  { id: "wavetable", name: "Wavetable", type: "instrument", family: "wavetable-synthesizer", match: ["wavetable"], roles: { ...globalRoles, oscillator: ["osc", "wavetable", "position", "transpose", "detune"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope", "matrix", "mod"], amplitude: ["volume", "attack", "decay", "sustain", "release"] } },
  { id: "eq-eight", name: "EQ Eight", type: "audio_effect", family: "equalizer", match: ["eq eight", "eq8"], roles: { ...globalRoles, frequency: ["freq", "frequency"], gain: ["gain"], resonance: ["q", "resonance"], mode: ["filter type", "mode", "stereo"] } },
  { id: "delay", name: "Delay", type: "audio_effect", family: "delay", match: ["delay"], roles: { ...globalRoles, time: ["time", "sync", "division"], feedback: ["feedback"], filter: ["filter", "freq"], modulation: ["modulation", "lfo"], mix: ["dry/wet", "mix"] } },
  { id: "echo", name: "Echo", type: "audio_effect", family: "delay", match: ["echo"], roles: { ...globalRoles, time: ["time", "sync", "division"], feedback: ["feedback"], filter: ["filter", "freq"], modulation: ["modulation", "wobble", "noise"], mix: ["dry/wet", "mix"] } },
  { id: "reverb", name: "Reverb", type: "audio_effect", family: "reverb", match: ["reverb"], roles: { ...globalRoles, time: ["decay", "time", "size", "pre-delay"], tone: ["filter", "freq", "damping", "diffusion"], modulation: ["modulation", "chorus"], mix: ["dry/wet", "mix"] } },
  { id: "hybrid-reverb", name: "Hybrid Reverb", type: "audio_effect", family: "reverb", match: ["hybrid reverb"], roles: { ...globalRoles, algorithm: ["algorithm", "convolution", "ir"], time: ["decay", "time", "size", "pre-delay"], tone: ["filter", "freq", "damping"], modulation: ["modulation"], mix: ["dry/wet", "mix", "blend"] } }
];

const publicProfile = ({ match, roles, ...profile }) => ({ ...profile, parameterRoles: Object.keys(roles) });
const normalize = (value) => String(value || "").trim().toLowerCase();

export function listFactoryDeviceProfiles() {
  return profiles.map(publicProfile);
}

export function getFactoryDeviceProfile(identity = {}) {
  const values = [identity.name, identity.className, identity.classDisplayName].map(normalize).filter(Boolean);
  const profile = profiles.find((candidate) => candidate.match.some((name) => values.includes(name)));
  return profile ? publicProfile(profile) : undefined;
}

export function groupDeviceParameters(profile, parameters = []) {
  if (!profile) return { other: [...parameters] };
  const source = profiles.find(({ id }) => id === profile.id);
  const groups = Object.fromEntries(Object.keys(source.roles).map((role) => [role, []]));
  groups.other = [];
  for (const parameter of parameters) {
    const name = normalize(`${parameter.originalName || ""} ${parameter.name || ""}`);
    const role = Object.entries(source.roles).find(([, terms]) => terms.some((term) => name.includes(term)))?.[0];
    groups[role || "other"].push(parameter);
  }
  return groups;
}
