const globalRoles = { global: ["device on", "on/off"] };

const profiles = [
  { id: "eq-three", name: "EQ Three", type: "audio_effect", family: "equalizer", match: ["eq three", "filtereq3"], roles: { global: ["device on"], gain: ["gainlo", "gainmid", "gainhi"], crossover: ["freqlo", "freqhi"], bandEnabled: ["lowon", "midon", "highon"], slope: ["slope"] }, notes: ["GainLo, GainMid, GainHi, FreqLo and FreqHi expose normalized raw values; use native displayValue for dB and Hz.", "FreqLo and FreqHi are crossover controls, not independent parametric-band center frequencies.", "LowOn, MidOn and HighOn switch individual bands; Device On bypasses the whole effect. Read native Slope valueItems rather than treating its raw enum as a dB-per-octave value."] },
  { id: "utility", name: "Utility", type: "audio_effect", family: "gain-stereo", match: ["utility", "stereogain"], roles: { global: ["device on"], phase: ["left inv", "right inv"], bass: ["bass mono", "bass freq"], stereo: ["channel mode", "stereo width", "mono", "balance"], gain: ["output"], mute: ["mute"], filter: ["dc filter"] }, notes: ["Output and Bass Freq use normalized native values, not literal dB or Hz; use displayValue for physical units.", "Bass Mono is distinct from full-band Mono; read Bass Freq when configuring low-frequency stereo management.", "Channel Mode exposes native choices. Left/Right inversion controls invert polarity, not time alignment.", "Device Mute is separate from track mute; inspect both when diagnosing silence."] },
  { id: "saturator", name: "Saturator", type: "audio_effect", family: "saturation", match: ["saturator"], roles: { global: ["device on"], waveshaper: ["ws "], color: ["color"], filter: ["pre dc filter"], clipping: ["post clip mode", "threshold"], algorithm: ["type"], gain: ["drive", "output"], mix: ["dry/wet"] }, notes: ["Drive, Output, Threshold, and Color controls expose normalized raw values; use native displayValue rather than treating raw values as dB or Hz.", "Type and Post Clip Mode expose separate native valueItems. Read fresh choices instead of assuming algorithm or clipping enum values.", "WS Drive belongs to the Waveshaper controls, not input gain. Parameter enabled state alone does not prove that a shaping algorithm uses a control; inspect Type."] },
  { id: "simpler", name: "Simpler", type: "instrument", family: "sampler", match: ["simpler", "originalsimpler"], roles: { ...globalRoles, sample: ["sample", "start", "end", "loop"], pitch: ["transpose", "detune", "pitch"], filter: ["filter", "freq", "resonance"], amplitude: ["volume", "gain", "attack", "decay", "sustain", "release"] } },
  { id: "sampler", name: "Sampler", type: "instrument", family: "sampler", match: ["sampler", "multi sampler", "multisampler"], roles: { ...globalRoles, sample: ["sample", "zone", "loop", "start", "end"], pitch: ["transpose", "detune", "pitch"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope", "modulation"], amplitude: ["volume", "attack", "decay", "sustain", "release"] } },
  { id: "drum-rack", name: "Drum Rack", type: "instrument", family: "rack", match: ["drum rack", "drumgroupdevice"], roles: { ...globalRoles, macro: ["macro"], chain: ["chain", "selector"], mix: ["volume", "pan", "send"] } },
  { id: "analog", name: "Analog", type: "instrument", family: "synthesizer", match: ["analog", "ultraanalog"], roles: { ...globalRoles, oscillator: ["osc", "shape", "octave", "semitone", "detune"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope"], amplitude: ["amp", "volume", "attack", "decay", "sustain", "release"] } },
  { id: "drift", name: "Drift", type: "instrument", family: "synthesizer", match: ["drift"], roles: { ...globalRoles, oscillator: ["osc", "shape", "wave", "octave", "detune"], filter: ["filter", "freq", "resonance"], modulation: ["lfo", "envelope", "mod"], amplitude: ["amp", "volume", "attack", "decay", "sustain", "release"] } },
  { id: "operator", name: "Operator", type: "instrument", family: "fm-synthesizer", match: ["operator"], roles: {
    global: ["device on"], algorithm: ["algorithm"],
    oscillatorAEnvelope: [/^ae /], oscillatorBEnvelope: [/^be /], oscillatorCEnvelope: [/^ce /], oscillatorDEnvelope: [/^de /],
    pitchEnvelope: [/^pe /], filterEnvelope: [/^fe /], lfoEnvelope: [/^le /],
    oscillator: ["osc-", "coarse", "fine", "freq<vel", "quantize", "fix on", "fix freq"],
    filter: ["filter", "filt <"], modulation: ["lfo"], pitch: ["transpose", "pb range", "glide"],
    amplitude: ["volume"], stereo: ["panorama", "pan <", "spread"], envelopeTiming: ["time"], shaper: ["shaper"], tone: ["tone"]
  }, notes: ["Ae/Be/Ce/De are the four oscillator amplitude envelopes; Pe, Fe and Le are separate pitch, filter and LFO envelopes. Read their native mode, loop, retrigger and modulation controls as well as ADSR.", "Oscillator fixed frequency and velocity-to-frequency controls are not filter cutoff. Oscillator Quantize is frequency quantization, not MIDI note timing.", "Envelope times and oscillator fixed frequencies may use normalized raw values; inspect displayValue for milliseconds and Hz. Grouping does not prove a modulation destination is active."] },
  { id: "wavetable", name: "Wavetable", type: "instrument", family: "wavetable-synthesizer", match: ["wavetable", "instrumentvector"], roles: {
    global: ["device on"], amplitudeEnvelope: [/^amp /], modulationEnvelope2: [/^env 2 /], modulationEnvelope3: [/^env 3 /],
    oscillator: [/^osc /], subOscillator: [/^sub /], filter1: [/^flt 1 /], filter2: [/^flt 2 /],
    lfo1: [/^lfo 1 /], lfo2: [/^lfo 2 /], modulation: ["global mod amount", "matrix"],
    pitch: ["transpose", "glide"], unison: ["unison"], envelopeTiming: ["time"], amplitude: ["volume"]
  }, notes: ["InstrumentVector is Wavetable's native class, including renamed instances. Amp is the amplitude envelope; Env 2 and Env 3 are separate modulation envelopes, not amplitude ADSR controls.", "Read envelope slopes, initial/peak/final levels and loop modes alongside ADSR. LFO Attack Time belongs to that LFO, not the amplitude envelope.", "Oscillator and sub-oscillator transposition are distinct from global Transpose. Both filters expose independent native controls.", "Native parameter grouping does not expose wavetable browser selection or the modulation matrix assignments. Inspect displayValue for physical units; normalized values are not necessarily milliseconds or Hz."] },
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
  ,{ id: "auto-filter", name: "Auto Filter", type: "audio_effect", family: "filter", match: ["auto filter", "autofilter2"], roles: {
    global: ["device on"], sidechain: ["s/c"], filter: ["frequency", "resonance", "filter morph", "filter type", "filter slope", "morph slope", "circuit"],
    character: ["drive", "control", "pitch", "formant"], lfo: ["lfo"], envelope: ["env"], output: ["output", "soft clip"], mix: ["dry/wet"]
  }, notes: ["Frequency, resonance, morph, drive, envelope, and most LFO controls expose normalized raw values; use native displayValue for Hz, time, degrees, and percentages.", "Filter Type selects ten distinct models. Filter Slope and Morph Slope are separate native choices, and Circuit is a separate topology choice.", "LFO timing and quantization controls are mode-dependent. Read native enabled state and valueItems after changing LFO T Mode, S Mode, or Q Mode.", "Sidechain EQ and source controls are separate from the main filter. Native sidechain routing is configured through the dedicated device-sidechain workflow."] }
  ,{ id: "channel-eq", name: "Channel EQ", type: "audio_effect", family: "equalizer", match: ["channel eq", "channeleq"], roles: {
    global: ["device on"], highpass: ["highpass"], lowBand: ["low gain"], midBand: ["mid gain", "mid freq"], highBand: ["high gain"], output: ["output"]
  }, notes: ["Low, Mid, High, and Output expose normalized raw values; use native displayValue for dB. Mid Freq is normalized and should be read through displayValue for Hz.", "Highpass On is a dedicated low-cut switch. The low and high bands have fixed frequency behavior; only the mid band exposes a center-frequency control."] }
  ,{ id: "multiband-dynamics", name: "Multiband Dynamics", type: "audio_effect", family: "multiband-dynamics", match: ["multiband dynamics", "multibanddynamics"], roles: {
    global: ["device on"], crossover: ["crossover"], detector: ["soft knee", "peak/rms"], sidechain: ["s/c"],
    globalControl: ["amount", "time scaling"], bandOutput: ["output gain"], bandInput: ["input gain"], bandEnabled: ["band activator"],
    aboveThreshold: ["above threshold"], belowThreshold: ["below threshold"], aboveRatio: ["above ratio"], belowRatio: ["below ratio"],
    timing: ["attack time", "release time"], output: ["output"]
  }, notes: ["Crossover values are logarithmic native values; use displayValue for Hz. Attack and release values are also logarithmic; use displayValue for milliseconds.", "Above and Below Threshold and Ratio form separate upward/downward dynamics stages for each Low, Mid, and High band. Do not treat a raw ratio value as the displayed compression or expansion ratio.", "Amount and Time Scaling affect the complete processor. Band input and output gains, band activators, and the final Output are separate gain stages.", "Sidechain controls do not identify the external source. Use the dedicated device-sidechain routing workflow and read the current native routing choices."] }
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
    const role = Object.entries(source.roles).find(([, terms]) => terms.some((term) => term instanceof RegExp ? term.test(name) : name.includes(term)))?.[0];
    groups[role || "other"].push(parameter);
  }
  return groups;
}
