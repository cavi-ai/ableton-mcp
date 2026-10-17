import { spawn } from "node:child_process";

// ACP is a trusted runtime connection, not an operating-system sandbox.
// No MCP servers, filesystem methods or terminals are granted by this client.
export class AcpProducerRuntime {
  constructor(config, { environment = process.env } = {}) { this.config = config; this.environment = environment; }

  async generate(text, { signal, cwd }) {
    if (!cwd) throw new Error("ACP requires an isolated working directory");
    signal.throwIfAborted();
    const env = {};
    for (const key of ["PATH", "HOME", "USER", "TMPDIR", "SYSTEMROOT", ...(this.config.env || [])])
      if (this.environment[key] !== undefined) env[key] = this.environment[key];
    const child = spawn(this.config.command, this.config.args || [], { cwd, env, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const terminate = signal => {
      if (!child.pid) return;
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") child.kill(signal); }
      } else {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill(signal));
      }
    };
    const pending = new Map();
    let nextId = 0, buffer = "", bytes = 0, sessionId, output = "", failure;
    const fail = error => {
      failure ||= error;
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    const send = value => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`); };
    const abort = () => {
      if (sessionId) send({ method: "session/cancel", params: { sessionId } });
      fail(signal.reason || new Error("ACP request cancelled"));
      terminate("SIGTERM");
    };
    const closed = new Promise(resolve => child.once("close", resolve));
    child.once("error", () => fail(new Error("ACP agent could not be started")));
    child.once("close", () => fail(new Error("ACP agent disconnected")));
    child.stdin.on("error", () => fail(new Error("ACP agent input disconnected")));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      try {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 512000) throw new Error("ACP output byte limit exceeded");
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.jsonrpc !== "2.0") throw new Error("invalid ACP JSON-RPC message");
          if (message.method && Object.hasOwn(message, "id")) {
            if (message.method === "session/request_permission") send({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
            else send({ id: message.id, error: { code: -32601, message: "Client capability is not available" } });
          } else if (message.method === "session/update" && message.params?.sessionId === sessionId) {
            const update = message.params.update;
            if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
              output += update.content.text;
              if (Buffer.byteLength(output) > 16000) throw new Error("ACP response output limit exceeded");
            }
          } else if (!message.method && pending.has(message.id)) {
            const entry = pending.get(message.id); pending.delete(message.id);
            if (message.error) entry.reject(new Error(`ACP ${entry.method} failed (${message.error.code})`));
            else entry.resolve(message.result);
          }
        }
      } catch (error) { fail(new Error(error instanceof SyntaxError ? "ACP returned invalid JSON" : error.message)); terminate("SIGTERM"); }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++nextId; pending.set(id, { resolve, reject, method }); send({ id, method, params });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: "ableton-producer", version: "1.0.0" } });
      if (initialized?.protocolVersion !== 1) throw new Error("ACP agent did not negotiate protocol v1");
      const session = await request("session/new", { cwd, mcpServers: [] });
      if (typeof session?.sessionId !== "string" || !session.sessionId) throw new Error("ACP agent returned no session ID");
      sessionId = session.sessionId;
      const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      if (result?.stopReason !== "end_turn") throw new Error(`ACP turn did not finish: ${result?.stopReason || "unknown"}`);
      return output;
    } finally {
      signal.removeEventListener("abort", abort);
      child.stdin.end();
      terminate("SIGTERM");
      let finish;
      const bounded = new Promise(resolve => { finish = resolve; });
      const timer = setTimeout(() => {
        terminate("SIGKILL");
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish();
      }, 500);
      await Promise.race([closed, bounded]);
      clearTimeout(timer);
    }
  }
}
