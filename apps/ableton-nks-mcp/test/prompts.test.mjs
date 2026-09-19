import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { getPrompt, listPrompts } from "../src/prompts.mjs";

test("MCP discovery lists every prompt with schema-shaped arguments", async () => {
  const route = createRouter({ call: async () => ({}) });
  const listed = await route({ id: 1, method: "prompts/list" });
  const names = listed.result.prompts.map(prompt => prompt.name).sort();
  assert.deepEqual(names, ["arrangement-rework", "build-producer-chain", "harmonize-clip",
    "produce-drum-pattern", "session-overview"]);
  for (const prompt of listed.result.prompts) {
    assert.ok(prompt.description);
    for (const argument of prompt.arguments) {
      assert.ok(argument.name && argument.description, `${prompt.name} argument shape`);
    }
  }
});

test("prompts/get renders arguments into user messages and validates required args", async () => {
  const route = createRouter({ call: async () => ({}) });
  const missing = await route({ id: 1, method: "prompts/get", params: { name: "harmonize-clip", arguments: {} } });
  assert.equal(missing.error?.code, -32602);
  assert.match(missing.error.message, /trackId/);
  const rendered = await route({ id: 2, method: "prompts/get", params: {
    name: "harmonize-clip", arguments: { trackId: "track-2", clipId: "track-2:arrangement-clip-0" } } });
  const text = rendered.result.messages[0].content.text;
  assert.equal(rendered.result.messages[0].role, "user");
  assert.match(text, /track-2:arrangement-clip-0/);
  assert.match(text, /analyze_midi_clip_scale/);
  assert.match(text, /dry-run plan/);
  const survey = await getPrompt("session-overview");
  assert.equal(survey.messages.length, 1);
  assert.match(survey.messages[0].content.text, /get_song_musical_context/);
});

test("prompts/get rejects unknown prompt names", async () => {
  assert.throws(() => getPrompt("nonexistent"), /unknown prompt/);
});