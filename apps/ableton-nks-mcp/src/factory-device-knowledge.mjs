const globalRoles = { global: ["device on", "on/off"] };

const profiles = [
  { id: "simpler", name: "Simpler", type: "instrument", family: "sampler", match: ["simpler", "originalsimpler"], roles: { ...globalRoles, sample: ["sample", "start", "end", "loop"], pitch: ["transpose", "detune", "pitch"], filter: ["filter", "freq", "resonance"], amplitude: ["volume", "gain", "attack", "decay", "sustain", "release"] } },
  { id: "sampler", name: "Sampler", type: "instrument", family: "sampler", match: ["sampler", "multi sampler", "multisampler"], roles: { ...globalRoles, sample: ["sample", "zone", "loop", "start", "end"], pitch: ["transpose", "detune", "pitch"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope", "modulation"], amplitude: ["volume", "attack", "decay", "sustain", "release"] } },
  { id: "drum-rack", name: "Drum Rack", type: "instrument", family: "rack", match: ["drum rack", "drumgroupdevice"], roles: { ...globalRoles, macro: ["macro"], chain: ["chain", "selector"], mix: ["volume", "pan", "send"] } },
  { id: "analog", name: "Analog", type: "instrument", family: "synthesizer", match: ["analog", "ultraanalog"], roles: { ...globalRoles, oscillator: ["osc", "shape", "octave", "semitone", "detune"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope"], amplitude: ["amp", "volume", "attack", "decay", "sustain", "release"] } },
  { id: "drift", name: "Drift", type: "instrument", family: "synthesizer", match: ["drift"], roles: { ...globalRoles, oscillator: ["osc", "shape", "wave", "octave", "detune"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope", "mod"], amplitude: ["amp", "volume", "attack", "decay", "sustain", "release"] } },
  { id: "operator", name: "Operator", type: "instrument", family: "fm-synthesizer", match: ["operator"], roles: { ...globalRoles, oscillator: ["osc", "operator", "coarse", "fine", "level"], algorithm: ["algorithm"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope"], amplitude: ["volume", "attack", "decay", "sustain", "release"] } },
  { id: "wavetable", name: "Wavetable", type: "instrument", family: "wavetable-synthesizer", match: ["wavetable"], roles: { ...globalRoles, oscillator: ["osc", "wavetable", "position", "transpose", "detune"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope", "matrix", "mod"], amplitude: ["volume", "attack", "decay", "sustain", "release"] } },
  { id: "eq-eight", name: "EQ Eight", type: "audio_effect", family: "equalizer", match: ["eq eight", "eq8"], roles: { ...globalRoles, frequency: ["freq", "frequency"], gain: ["gain"], resonance: ["q", "resonance"], mode: ["filter type", "mode", "stereo"] } },
  { id: "delay", name: "Delay", type: "audio_effect", family: "delay", match: ["delay"], roles: { ...globalRoles, time: ["time", "sync", "division"], feedback: ["feedback"], filter: ["filter", "freq"], modulation: ["modulation", "lfo"], mix: ["dry/wet", "mix"] } },
  { id: "echo", name: "Echo", type: "audio_effect", family: "delay", match: ["echo"], roles: { ...globalRoles, time: ["time", "sync", "division"], feedback: ["feedback"], filter: ["filter", "freq"], modulation: ["modulation", "wobble", "noise"], mix: ["dry/wet", "mix"] } },
  { id: "reverb", name: "Reverb", type: "audio_effect", family: "reverb", match: ["reverb"], roles: { ...globalRoles, time: ["decay", "time", "size", "pre-delay"], tone: ["filter", "freq", "damping", "diffusion"], modulation: ["modulation", "chorus"], mix: ["dry/wet", "mix"] } },
  { id: "hybrid-reverb", name: "Hybrid Reverb", type: "audio_effect", family: "reverb", match: ["hybrid reverb"], roles: { ...globalRoles, algorithm: ["algorithm", "convolution", "ir"], time: ["decay", "time", "size", "pre-delay"], tone: ["filter", "freq", "damping"], modulation: ["modulation"], mix: ["dry/wet", "mix", "blend"] } }
  ,{ id: "auto-shift", name: "Auto Shift", type: "audio_effect", family: "pitch-correction", match: ["auto shift", "autoshift"], roles: { ...globalRoles, expression: ["midi >", "pb range", "latch", "scale aware", "glide", "attack time", "release time"], modulation: ["lfo", "vibrato"], correction: ["quantizer", "smooth", "strength", "root", "scale"], pitch: ["pitch st.", "pitch scale deg.", "pitch fine"], formant: ["formant"], mix: ["input gain", "dry/wet"] } }
  ,{ id: "glue-compressor", name: "Glue Compressor", type: "audio_effect", family: "compressor", match: ["glue compressor", "gluecompressor"], roles: { ...globalRoles, sidechain: ["s/c"], dynamics: ["threshold", "range", "ratio", "peak clip"], timing: ["attack", "release"], gain: ["output"], mix: ["dry/wet"] } }
  ,{ id: "limiter", name: "Limiter", type: "audio_effect", family: "limiter", match: ["limiter"], roles: { ...globalRoles, timing: ["release", "auto", "lookahead"], stereo: ["link", "routing"], mode: ["mode", "maximize"], dynamics: ["ceiling", "threshold"], gain: ["input gain", "output"] } }
  ,{ id: "instrument-rack", name: "Instrument Rack", type: "instrument", family: "rack", match: ["instrument rack", "instrumentgroupdevice"], roles: { ...globalRoles, macro: ["macro"], chain: ["chain", "selector"], mix: ["volume", "pan", "send"] } }
  ,{ id: "audio-effect-rack", name: "Audio Effect Rack", type: "audio_effect", family: "rack", match: ["audio effect rack", "audioeffectgroupdevice"], roles: { ...globalRoles, macro: ["macro"], chain: ["chain", "selector"], mix: ["volume", "pan", "send"] } }
  ,{ id: "midi-effect-rack", name: "MIDI Effect Rack", type: "midi_effect", family: "rack", match: ["midi effect rack", "midieffectgroupdevice"], roles: { ...globalRoles, macro: ["macro"], chain: ["chain", "selector"] } }
  ,{ id: "arpeggiator", name: "Arpeggiator", type: "midi_effect", family: "note-generator", match: ["arpeggiator", "midiarpeggiator"], roles: { ...globalRoles, pattern: ["style", "offset", "repeats"], timing: ["sync", "rate", "groove", "gate"], velocity: ["velocity", "vel."], trigger: ["retrigger", "ret. interval", "hold"], pitch: ["transpose", "tranpose", "transp.", "scale"] } }
  ,{ id: "compressor", name: "Compressor", type: "audio_effect", family: "compressor", match: ["compressor", "compressor2"], roles: { global: ["device on"], sidechain: ["s/c"], dynamics: ["threshold", "ratio", "knee"], timing: ["attack", "release", "lookahead"], detector: ["model", "env mode"], gain: ["output", "makeup"], mix: ["dry/wet"] }, notes: ["Use native display values for threshold and ratio; raw values are not necessarily dB or ratios.", "Model exposes Peak, RMS, and Expand. Read fresh parameter enabled states after changing mode.", "Sidechain parameter controls do not select the external sidechain source; device sidechain routing is a separate workflow."] }
  ,{ id: "gate", name: "Gate", type: "audio_effect", family: "gate", match: ["gate"], roles: { global: ["device on"], sidechain: ["s/c"], dynamics: ["threshold", "return", "floor"], timing: ["attack", "hold", "release", "lookahead"], mode: ["flipmode"] }, notes: ["Read native display values: Threshold, Hold, and Release use normalized raw values, while Attack exposes milliseconds and Return/Floor expose dB.", "FlipMode and LookAhead expose discrete native valueItems; do not assume their numeric values represent time or a boolean.", "Sidechain parameter controls are separate from source selection. The observed Gate device does not expose native sidechain routing; check get_device_sidechain_routing rather than inferring support from S/C parameters."] }
];

const publicProfile = ({ match, roles, ...profile }) => ({ ...profile, parameterRoles: Object.keys(roles) });
const normalize = (value) => String(value || "").trim().toLowerCase();

export function listFactoryDeviceProfiles() {
  return profiles.map(publicProfile);
}

export function getFactoryDeviceProfile(identity = {}) {
  const values = [identity.className, identity.classDisplayName, identity.name].map(normalize).filter(Boolean);
  for (const value of values) {
    const profile = profiles.find((candidate) => candidate.match.includes(value));
    if (profile) return publicProfile(profile);
  }
  return undefined;
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
