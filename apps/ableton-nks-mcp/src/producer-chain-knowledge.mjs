const fx = (profileId, name, role, rationale, optional = false) => ({
  profileId, root: "audio_effects", path: [name], role, rationale, optional
});

const chain = (id, summary, stages) => ({ id, topology: "single-chain", summary, stages });
const ordered = (stages) => stages.map((stage, index) => ({ order: index + 1, ...stage }));

const blueprints = [
  chain("bass", "Controlled low end with corrective filtering, dynamics, harmonics and final level safety.", ordered([
    fx("utility", "Utility", "gain-and-width", "Establish gain, polarity and bass mono before dynamics."),
    fx("eq-eight", "EQ Eight", "corrective-eq", "Remove unusable lows and address resonances before compression."),
    fx("compressor", "Compressor", "dynamics", "Control note-to-note level and optionally receive kick sidechain."),
    fx("saturator", "Saturator", "harmonics", "Add upper harmonics for translation on smaller speakers.", true),
    fx("limiter", "Limiter", "safety", "Catch exceptional peaks without replacing mix-balance work.", true)
  ])),
  chain("drums", "Bus processing that preserves transients while controlling tone, punch and peak level.", ordered([
    fx("utility", "Utility", "gain", "Set headroom before nonlinear processing."),
    fx("eq-eight", "EQ Eight", "corrective-eq", "Remove rumble and solve broad tonal buildup."),
    fx("drum-buss", "Drum Buss", "character", "Shape drive, transients and low-end boom."),
    fx("glue-compressor", "Glue Compressor", "bus-compression", "Add controlled cohesion after transient shaping."),
    fx("limiter", "Limiter", "safety", "Catch occasional bus peaks.", true)
  ])),
  chain("vocals", "Corrective vocal chain with controlled dynamics, sibilance-safe tone and optional ambience sends.", ordered([
    fx("utility", "Utility", "gain", "Set recording gain and polarity before processing."),
    fx("eq-eight", "EQ Eight", "corrective-eq", "Remove rumble and reduce persistent resonant buildup."),
    fx("compressor", "Compressor", "leveling", "Control phrase dynamics before additive color."),
    fx("saturator", "Saturator", "color", "Add density and harmonics at conservative drive.", true),
    fx("channel-eq", "Channel EQ", "broad-tone", "Apply broad final tone moves after dynamics.", true)
  ])),
  chain("guitar", "Gain-staged guitar processing from cleanup through amp/cabinet tone and final control.", ordered([
    fx("utility", "Utility", "gain", "Set input level for predictable amp response."),
    fx("pedal", "Pedal", "drive", "Apply pre-amplifier drive or boost.", true),
    fx("amp", "Amp", "amplifier", "Create the primary amplifier tone."),
    fx("cabinet", "Cabinet", "speaker", "Apply speaker and microphone coloration after Amp."),
    fx("eq-eight", "EQ Eight", "post-eq", "Remove post-cabinet harshness or low buildup."),
    fx("compressor", "Compressor", "leveling", "Control final performance dynamics.", true)
  ])),
  chain("keys", "Transparent keys chain for register control, dynamics and optional width.", ordered([
    fx("utility", "Utility", "gain-and-width", "Set headroom and stereo width."),
    fx("eq-eight", "EQ Eight", "register-eq", "Make intentional space around bass, vocals and drums."),
    fx("compressor", "Compressor", "dynamics", "Control peaks while preserving articulation.", true),
    fx("chorus-ensemble", "Chorus-Ensemble", "width", "Add movement or width when arrangement space permits.", true)
  ])),
  chain("synth", "General synth chain for gain, spectral placement, movement and controlled density.", ordered([
    fx("utility", "Utility", "gain-and-width", "Set level and stereo intent at the source."),
    fx("eq-eight", "EQ Eight", "spectral-placement", "Remove conflicting bands based on arrangement role."),
    fx("auto-filter", "Auto Filter", "movement", "Provide automatable filtering and modulation.", true),
    fx("saturator", "Saturator", "density", "Add harmonics and perceived consistency.", true),
    fx("compressor", "Compressor", "dynamics", "Control peaks or receive rhythmic sidechain.", true)
  ])),
  chain("mix-bus", "Conservative mix-bus chain ordered for metering-safe gain, broad tone, cohesion and peak safety.", ordered([
    fx("utility", "Utility", "gain", "Create headroom before bus processing."),
    fx("eq-eight", "EQ Eight", "broad-eq", "Apply only broad corrective tonal moves."),
    fx("glue-compressor", "Glue Compressor", "cohesion", "Use modest gain reduction for bus cohesion."),
    fx("saturator", "Saturator", "color", "Add subtle harmonic density.", true),
    fx("limiter", "Limiter", "safety", "Catch peaks for monitoring; avoid hiding mix problems.", true)
  ])),
  chain("mastering", "Factory-device mastering starting point; measure loudness and peaks before committing settings.", ordered([
    fx("utility", "Utility", "input-gain", "Set calibrated headroom and mono checks."),
    fx("eq-eight", "EQ Eight", "corrective-eq", "Address broad tonal balance before dynamics."),
    fx("glue-compressor", "Glue Compressor", "cohesion", "Apply conservative program compression."),
    fx("saturator", "Saturator", "harmonics", "Add optional density before final limiting.", true),
    fx("limiter", "Limiter", "final-level", "Set the final peak ceiling and loudness stage.")
  ])),
  chain("reverb-return", "Shared ambience return with filtering before reverb and output control after it.", ordered([
    fx("eq-eight", "EQ Eight", "input-filter", "Keep low end and harsh bands out of the reverb excitation."),
    fx("hybrid-reverb", "Hybrid Reverb", "ambience", "Generate the shared room, plate or designed space."),
    fx("utility", "Utility", "return-level", "Control final return gain and width.")
  ])),
  chain("delay-return", "Shared echo return with filtering, delay generation and final peak control.", ordered([
    fx("eq-eight", "EQ Eight", "input-filter", "Band-limit repeats before feedback processing."),
    fx("echo", "Echo", "delay", "Generate synchronized or free-time repeats."),
    fx("utility", "Utility", "return-level", "Control return gain and stereo width."),
    fx("limiter", "Limiter", "feedback-safety", "Catch unexpected feedback peaks.", true)
  ])),
  {
    id: "layered-bass-system", topology: "shared-instrument-bus",
    summary: "Separate sub, body and texture instruments routed into one processed audio bus.",
    children: [
      { role: "sub", instrumentProfileId: "operator", root: "instruments", path: ["Operator"], routing: "bus" },
      { role: "body", instrumentProfileId: "wavetable", root: "instruments", path: ["Wavetable"], routing: "bus" },
      { role: "texture", instrumentProfileId: "drift", root: "instruments", path: ["Drift"], routing: "bus" }
    ],
    stages: ordered([
      fx("utility", "Utility", "bus-gain-and-mono", "Establish shared headroom and mono-compatible low end."),
      fx("eq-eight", "EQ Eight", "layer-separation", "Resolve overlap between sub, body and texture layers."),
      fx("compressor", "Compressor", "bus-dynamics", "Control the combined envelope or receive kick sidechain."),
      fx("saturator", "Saturator", "bus-harmonics", "Unify layers with shared harmonic character.", true),
      fx("limiter", "Limiter", "bus-safety", "Catch exceptional summed peaks.", true)
    ])
  },
  {
    id: "layered-synth-system", topology: "shared-instrument-bus",
    summary: "Separate transient, body and atmosphere instruments routed into one synth bus.",
    children: [
      { role: "transient", instrumentProfileId: "drift", root: "instruments", path: ["Drift"], routing: "bus" },
      { role: "body", instrumentProfileId: "wavetable", root: "instruments", path: ["Wavetable"], routing: "bus" },
      { role: "atmosphere", instrumentProfileId: "sampler", root: "instruments", path: ["Sampler"], routing: "bus" }
    ],
    stages: ordered([
      fx("utility", "Utility", "bus-gain-and-width", "Set combined level and stereo scope."),
      fx("eq-eight", "EQ Eight", "layer-separation", "Resolve masking between layers."),
      fx("compressor", "Compressor", "bus-dynamics", "Control the summed envelope."),
      fx("chorus-ensemble", "Chorus-Ensemble", "shared-movement", "Add optional common movement.", true),
      fx("saturator", "Saturator", "shared-color", "Add optional common harmonic character.", true)
    ])
  }
];

const clone = (value) => JSON.parse(JSON.stringify(value));

export function listProducerChainBlueprints() {
  return blueprints.map(({ id, topology, summary }) => ({ id, topology, summary }));
}

export function getProducerChainBlueprint(target) {
  const blueprint = blueprints.find(({ id }) => id === target);
  if (!blueprint) throw new Error(`unknown producer chain target ${target}`);
  return clone({
    ...blueprint,
    execution: {
      loadTool: "load_browser_item",
      routeTool: blueprint.topology === "shared-instrument-bus" ? "route_tracks_to_bus" : null,
      verifyTools: ["list_devices", "get_track_routing", "get_track_mixer"],
      instruction: "Load stages in ascending order onto an empty staging track, inspect observed device order after every load, and use guarded routing tools for shared-bus children. Optional stages require source-specific evidence."
    },
    limitation: "A deterministic factory-device starting point, not automatic mixing or mastering. Measure the source, inspect native parameters, audition changes, and preserve headroom before committing settings."
  });
}

export function verifyProducerChain(target, devices) {
  const blueprint = getProducerChainBlueprint(target);
  if (!Array.isArray(devices)) throw new TypeError("devices must be an array");
  const stagesById = new Map(blueprint.stages.map((stage) => [stage.profileId, stage]));
  const observed = [];
  const unexpectedDevices = [];
  const seen = new Set();
  for (const device of devices) {
    const profileId = getFactoryDeviceProfile(device)?.id;
    if (!profileId || !stagesById.has(profileId) || seen.has(profileId)) {
      unexpectedDevices.push(device);
      continue;
    }
    seen.add(profileId);
    observed.push({ profileId, deviceId: device.id, order: stagesById.get(profileId).order });
  }
  const missingRequired = blueprint.stages.filter((stage) => !stage.optional && !seen.has(stage.profileId));
  const optionalOmitted = blueprint.stages.filter((stage) => stage.optional && !seen.has(stage.profileId));
  const inversions = new Set();
  for (let left = 0; left < observed.length; left++) {
    for (let right = left + 1; right < observed.length; right++) {
      if (observed[left].order > observed[right].order) {
        inversions.add(left);
        inversions.add(right);
      }
    }
  }
  const outOfOrder = observed.filter((_, index) => inversions.has(index));
  return {
    target,
    matchesRequiredOrder: missingRequired.length === 0 && outOfOrder.length === 0 && unexpectedDevices.length === 0,
    observed,
    missingRequired,
    optionalOmitted,
    outOfOrder,
    unexpectedDevices
  };
}
import { getFactoryDeviceProfile } from "./factory-device-knowledge.mjs";
