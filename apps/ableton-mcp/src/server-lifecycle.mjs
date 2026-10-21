import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readdir, readFile, writeFile, rename, unlink, lstat, realpath } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { createRuntimeIdentity } from "./runtime-identity.mjs";

const workerEntrypoint = fileURLToPath(new URL("./server.mjs", import.meta.url));
const directoryFor = env => env.ABLETON_MCP_SERVER_DIRECTORY || join(homedir(), ".cavi", "ableton-mcp", "servers");
const closed = child => new Promise(resolve => child.once("close", resolve));
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = closed(child);
  child.stdin.end();
  const terminate = setTimeout(() => child.kill("SIGTERM"), 2000);
  const force = setTimeout(() => child.kill("SIGKILL"), 4000);
  try { await done; } finally { clearTimeout(terminate); clearTimeout(force); }
}

// The host owns this stable process. Only its worker is replaced; requests that
// may have reached Live are never replayed across a worker failure or restart.
export async function serveManaged({ env = process.env, input = process.stdin, output = process.stdout, stderr = process.stderr } = {}) {
  const directory = directoryFor(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077)) ||
      (process.getuid && info.uid !== process.getuid())) throw new Error("server directory must be private and owned by the current user");
  const token = randomBytes(32).toString("hex"), filename = join(directory, `${process.pid}.json`);
  const pending = new Map(), internal = new Map(), decoder = new StringDecoder("utf8");
  let worker, restarting = false, ended = false, closing = false, partial = "", initialize;
  let identity, endpoint, publishQueue = Promise.resolve(), outputQueue = Promise.resolve(), resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const publish = () => {
    const value = { pid: process.pid, workerPid: worker.pid, port: endpoint, token, serverIdentity: identity };
    publishQueue = publishQueue.then(async () => {
      if (closing) return;
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    });
    return publishQueue;
  };
  const start = entrypoint => {
    const child = spawn(process.execPath, [entrypoint], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.pipe(stderr, { end: false });
    child.stdin.on("error", error => { if (!restarting && !closing) rejectDone(error); });
    child.once("error", rejectDone);
    child.once("close", code => {
      for (const { reject } of internal.values()) reject(new Error("replacement server exited before initialization"));
      internal.clear();
      if (!restarting && !closing) {
        if (ended && code === 0) resolveDone();
        else rejectDone(new Error("server worker exited; inspect pending operations before reconnecting"));
      }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      outputQueue = outputQueue.then(async () => {
        const reply = JSON.parse(line), waiter = internal.get(reply.id);
        if (waiter) { internal.delete(reply.id); waiter.resolve(reply); return; }
        const count = pending.get(reply.id) || 0;
        if (count > 1) pending.set(reply.id, count - 1); else pending.delete(reply.id);
        if (reply.result?._meta?.["ai.cavi/runtime"]) {
          identity = reply.result._meta["ai.cavi/runtime"]; await publish();
        }
        if (!output.write(line + "\n")) { child.stdout.pause(); output.once("drain", () => child.stdout.resume()); }
      }).catch(rejectDone);
    });
    return child;
  };
  const forward = chunk => {
    partial += decoder.write(chunk);
    let end;
    while ((end = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, end); partial = partial.slice(end + 1);
      try { const request = JSON.parse(line);
        if (Object.hasOwn(request, "id")) pending.set(request.id, (pending.get(request.id) || 0) + 1);
        if (request.method === "initialize") initialize = request.params;
      } catch { /* The worker returns the normal protocol error. */ }
    }
    if (!worker.stdin.write(chunk)) { input.pause(); worker.stdin.once("drain", () => { if (!restarting) input.resume(); }); }
  };
  const eof = () => { ended = true; worker.stdin.end(); };
  const control = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization || ""), expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== "POST" || request.url !== "/restart" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end(); return;
    }
    if (restarting || closing || ended || pending.size || partial.trim()) {
      response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "server has active requests or is closing; restart after completion" })); return;
    }
    let body = "", ownsRestart = false;
    try {
      for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error("restart request too large"); }
      const entrypoint = await realpath(JSON.parse(body).entrypoint);
      if (basename(entrypoint) !== "server.mjs") throw new Error("restart requires a packaged server entrypoint");
      const candidate = createRuntimeIdentity(join(dirname(entrypoint), "../../.."));
      if (candidate.name !== "@cavi-ai/ableton-mcp") throw new Error("restart requires the Ableton MCP package");
      // Recheck after parsing: a host request can arrive while the HTTP body is read.
      if (pending.size || partial.trim() || ended || restarting) throw new Error("server has active requests; restart after completion");
      restarting = true; ownsRestart = true; input.pause();
      await stop(worker); worker = start(entrypoint);
      const id = `restart-${randomUUID()}`;
      let timer;
      const reply = await new Promise((resolve, reject) => {
        timer = setTimeout(() => { internal.delete(id); reject(new Error("replacement server initialization timed out")); }, 10000);
        internal.set(id, { resolve, reject });
        worker.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: initialize || {
          protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ableton-mcp-restart", version: "1" }
        } }) + "\n");
      }).finally(() => clearTimeout(timer));
      if (reply.error || JSON.stringify(reply.result?._meta?.["ai.cavi/runtime"]) !== JSON.stringify(candidate))
        throw new Error("replacement server identity does not match the requested package");
      identity = candidate; await publish();
      worker.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      restarting = false; input.resume();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: process.pid, workerPid: worker.pid, serverIdentity: identity }));
    } catch (error) {
      response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
      if (ownsRestart) { closing = true; rejectDone(error); }
    }
  });
  const interrupted = () => rejectDone(new Error("server transport closed; inspect pending operations before reconnecting"));
  try {
    await new Promise((resolve, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", resolve); });
    endpoint = control.address().port; worker = start(workerEntrypoint); await publish();
    input.on("data", forward); input.once("end", eof); output.once("error", interrupted); output.once("close", interrupted);
    process.once("SIGTERM", interrupted); process.once("SIGINT", interrupted); input.resume();
    await done;
  } finally {
    closing = true; input.off("data", forward); input.off("end", eof); input.pause();
    output.off("error", interrupted); output.off("close", interrupted);
    process.off("SIGTERM", interrupted); process.off("SIGINT", interrupted);
    control.closeAllConnections(); await new Promise(resolve => control.close(resolve));
    if (worker) await stop(worker);
    await outputQueue;
    await publishQueue;
    await unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function restartManaged({ env = process.env, pid } = {}) {
  const directory = directoryFor(env);
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code !== "ENOENT") throw error; files = []; }
  if (files.length) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077)) ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe server directory");
  }
  const records = [];
  for (const file of files.filter(name => /^\d+\.json$/.test(name))) {
    const path = join(directory, file), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077)) ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe server registration");
    const record = JSON.parse(await readFile(path, "utf8"));
    if (pid !== undefined && record.pid !== pid) continue;
    if (!Number.isInteger(record.pid) || `${record.pid}.json` !== file || record.pid <= 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(record.token)) throw new Error("invalid server registration");
    try { process.kill(record.pid, 0); } catch (error) { if (error.code === "ESRCH") continue; throw error; }
    records.push(record);
  }
  if (!records.length) throw new Error("no managed server found; the host must start this version with serve first");
  if (records.length > 1) throw new Error("multiple managed servers; select --pid");
  const servers = [];
  for (const record of records) {
    const response = await fetch(`http://127.0.0.1:${record.port}/restart`, { method: "POST", signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${record.token}`, "content-type": "application/json" }, body: JSON.stringify({ entrypoint: workerEntrypoint }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "server restart refused");
    servers.push(result);
  }
  return { restarted: true, servers };
}
