#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import { realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform as currentPlatform } from "node:os";
import { defaultRemoteScriptRoots, resolveRuntimeConfig } from "./paths.mjs";
import { createConfiguredService } from "./runtime.mjs";
import { runStdio } from "./server.mjs";
import { UnixBridgeClient } from "./bridge-client.mjs";
import { validateToolArguments } from "./tool-validation.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const requiredCapabilities = JSON.parse(readFileSync(new URL("../../../ableton/Remote Scripts/CaviMcpBridge/capabilities.json", import.meta.url), "utf8"));

export function isMainModule(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); }
  catch { return false; }
}

export function parseCli(argv) {
  const command = argv.find((value) => !value.startsWith("-")) || "help";
  return { command, json: argv.includes("--json"), args: argv.slice(argv.indexOf(command) + 1).filter((value) => value !== "--json") };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function print(value, json, stdout) {
  stdout(json ? JSON.stringify(value) : Object.entries(value).map(([key, item]) => `${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`).join("\n"));
}

export async function runCli(argv, dependencies = {}) {
  const parsed = parseCli(argv);
  const fs = dependencies.fs || { cp, mkdir, rm };
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || currentPlatform();
  const home = dependencies.home || homedir();
  const stdout = dependencies.stdout || ((line) => process.stdout.write(`${line}\n`));
  const sourceRoot = dependencies.sourceRoot || repositoryRoot;
  const runtimeFactory = dependencies.runtimeFactory || createConfiguredService;
  if (parsed.command === "install") {
    const destinationRoot = option(parsed.args, "--destination") || defaultRemoteScriptRoots({ platform, home })[0];
    const destination = join(destinationRoot, "CaviMcpBridge");
    await fs.mkdir(destinationRoot, { recursive: true });
    await fs.cp(join(sourceRoot, "ableton", "Remote Scripts", "CaviMcpBridge"), destination, { recursive: true });
    const result = { installed: true, destination, next: "Enable CaviMcpBridge as a Control Surface in Ableton Live preferences." };
    print(result, parsed.json, stdout);
    return result;
  }
  if (parsed.command === "doctor") {
    const config = resolveRuntimeConfig(env, { platform, home });
    const bridgeProbe = dependencies.bridgeProbe || (() => new UnixBridgeClient(config.socketPath, { timeoutMs: 1000 }).request("get_live_state", {}));
    let bridgeState;
    let reason;
    let missingCapabilities = [...requiredCapabilities];
    try {
      bridgeState = await bridgeProbe();
      const advertised = Array.isArray(bridgeState.capabilities) ? bridgeState.capabilities : [];
      missingCapabilities = requiredCapabilities.filter((name) => !advertised.includes(name));
      if (bridgeState.bridgeVersion !== "0.1.0") reason = "outdated bridge: expected 0.1.0";
      else if (missingCapabilities.length) reason = `bridge is missing required capabilities: ${missingCapabilities.join(", ")}`;
    } catch (error) {
      reason = error.message;
    }
    const result = {
      ok: !reason,
      bridge: {
        socket: config.socketPath,
        connected: Boolean(bridgeState),
        version: bridgeState?.bridgeVersion,
        capabilities: bridgeState?.capabilities || [],
        missingCapabilities,
        ...(reason ? { reason } : {})
      },
      catalog: { configured: Boolean(config.catalogPath), path: config.catalogPath || null },
      remoteScriptRoots: defaultRemoteScriptRoots({ platform, home })
    };
    print(result, parsed.json, stdout);
    return result;
  }
  if (parsed.command === "uninstall") {
    const destinationRoot = option(parsed.args, "--destination") || defaultRemoteScriptRoots({ platform, home })[0];
    const destination = join(destinationRoot, "CaviMcpBridge");
    await fs.rm(destination, { recursive: true, force: false });
    const result = { removed: true, destination };
    print(result, parsed.json, stdout);
    return result;
  }
  if (parsed.command === "serve") {
    const runtime = runtimeFactory(env);
    try { await runStdio({ service: runtime.service }); } finally { runtime.close(); }
    return { served: true };
  }
  if (parsed.command === "status") {
    const runtime = runtimeFactory(env);
    try {
      const result = await runtime.service.call("get_live_state");
      print(result, parsed.json, stdout);
      return result;
    } finally { runtime.close(); }
  }
  if (parsed.command === "call") {
    const name = parsed.args[0];
    if (!name) throw new Error("call requires a tool name");
    const encodedArgs = option(parsed.args, "--args") || "{}";
    const args = validateToolArguments(name, JSON.parse(encodedArgs));
    const runtime = runtimeFactory(env, { persistentConfirmations: true });
    try {
      const result = await runtime.service.call(name, args);
      print(result, parsed.json, stdout);
      return result;
    } finally { runtime.close(); }
  }
  if (parsed.command === "resource") {
    const uri = parsed.args[0];
    if (!uri) throw new Error("resource requires a URI");
    const runtime = runtimeFactory(env);
    try {
      const result = await runtime.service.readResource(uri);
      print(result, parsed.json, stdout);
      return result;
    } finally { runtime.close(); }
  }
  const result = { commands: ["install", "uninstall", "doctor", "serve", "status", "call", "resource"], usage: "ableton-mcp <command> [--json]" };
  print(result, parsed.json, stdout);
  return result;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
