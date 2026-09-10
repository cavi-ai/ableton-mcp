import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultRemoteScriptRoots, resolveRuntimeConfig } from "../src/paths.mjs";

test("macOS discovery includes current Ableton User Library and app-support roots", () => {
  const roots = defaultRemoteScriptRoots({ platform: "darwin", home: "/Users/test" });
  assert.deepEqual(roots, [
    "/Users/test/Music/Ableton/User Library/Remote Scripts",
    "/Users/test/Library/Preferences/Ableton"
  ]);
});

test("runtime configuration defaults the socket and treats the catalog as optional", () => {
  const config = resolveRuntimeConfig({}, { platform: "darwin", home: "/Users/test", tmpdir: "/var/folders/user-temp" });
  assert.equal(config.socketPath, "/tmp/cavi-ableton-mcp.sock");
  assert.equal(config.catalogPath, undefined);
});
