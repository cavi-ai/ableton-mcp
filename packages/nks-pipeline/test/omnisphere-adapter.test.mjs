import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverOmnisphereFactoryPresets } from "../src/adapters/omnisphere.mjs";

test("Omnisphere adapter discovers embedded factory patches and ignores metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnisphere-"));
  await mkdir(join(root, "Factory"));
  const header = `<FileSystem>\n<FILE name="Pads/Warm Sky.prt_omn" offset="0" size="3"/>\n<FILE name="Preferences.xml" offset="3" size="2"/>\n<FILE name="Bass/Deep One.prt_omn" offset="5" size="4"/>\n</FileSystem>\n`;
  await writeFile(join(root, "Factory", "Omnisphere Library.db"), Buffer.concat([
    Buffer.from(header), Buffer.from("abcXXdeep")
  ]));
  const records = await discoverOmnisphereFactoryPresets({
    enabled: true,
    productSlug: "omnisphere",
    vendor: "Spectrasonics",
    factoryRoots: [join(root, "Factory")],
    extensions: [".db"]
  });
  assert.deepEqual(records.map((record) => record.name), ["Deep One", "Warm Sky"]);
  assert.deepEqual(records.map((record) => record.subBank), ["Bass", "Pads"]);
  assert.equal(records.every((record) => record.sourceFingerprint.startsWith("sha256:")), true);
  assert.notEqual(records[0].sourceFingerprint, records[1].sourceFingerprint);
});
