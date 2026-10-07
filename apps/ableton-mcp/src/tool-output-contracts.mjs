// Live readbacks and guarded mutation receipts are extensible objects. Bundled
// references have stable fields that can be validated more specifically.
const result = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: true
});
const text = { type: "string" };
const integers = { type: "array", items: { type: "integer" } };
const strings = { type: "array", items: text };
const scale = result({ name: text, family: text, intervals: {
  type: "array", minItems: 1, items: { type: "integer", minimum: 0, maximum: 11 }
} });
const blueprint = result({ id: text, topology: text, summary: text });

export const toolOutputContracts = {
  list_live_scales: result({ scales: { type: "array", items: scale } }),
  get_live_scale_reference: result({ scale: result({ ...scale.properties,
    rootNote: { type: "integer", minimum: 0, maximum: 11 }, rootName: text,
    pitchClasses: integers, noteNames: strings, degrees: integers
  }) }),
  list_producer_chain_blueprints: result({ blueprints: { type: "array", items: blueprint } }),
  get_producer_chain_blueprint: result({ blueprint }),
  list_factory_device_profiles: result({ profiles: { type: "array", items: result({
    id: text, name: text, type: text, family: text, notes: strings, parameterRoles: strings
  }, ["id", "name", "type", "family", "parameterRoles"]) } })
};

export const extensibleToolResult = { type: "object", additionalProperties: true };
