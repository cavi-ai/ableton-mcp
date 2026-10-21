import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export class McpAcceptanceClient {
  constructor({ command = process.execPath, args = [fileURLToPath(new URL("../../apps/ableton-mcp/src/cli.mjs", import.meta.url)), "serve"],
    env = process.env, timeoutMs = 210000, closeTimeoutMs = 2000 } = {}) {
    this.timeoutMs = timeoutMs; this.closeTimeoutMs = closeTimeoutMs;
    this.pending = new Map(); this.sentRequests = 0; this.stderr = ""; this.closed = false;
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const fail = error => { error.outcome ??= "unknown";
      for (const { reject } of this.pending.values()) reject(error); this.pending.clear(); };
    this.child.stdin.on("error", fail);
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-16000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("error", fail);
    this.lines.on("line", line => {
      try {
        const message = JSON.parse(line), pending = this.pending.get(message.id);
        if (!pending) return;
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else pending.resolve(message.result);
      } catch (error) { fail(new Error(`invalid MCP response: ${error.message}`)); }
    });
    this.exited = new Promise(resolve => {
      this.child.once("error", error => { this.closed = true; fail(error); resolve(); });
      this.child.once("close", (code, signal) => { this.closed = true;
        fail(new Error(`MCP server exited ${code ?? signal}: ${this.stderr}`)); this.lines.close(); resolve(); });
    });
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("MCP server exited"));
    const id = ++this.sentRequests;
    return new Promise((resolve, reject) => {
      const finish = callback => value => { clearTimeout(timer); this.pending.delete(id); callback(value); };
      const timer = setTimeout(() => {
        if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled",
          params: { requestId: id, reason: "acceptance request timeout" } }) + "\n");
        finish(reject)(Object.assign(new Error(`MCP request timed out: ${method}; inspect Live before continuing`), { outcome: "unknown" }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => { if (error) finish(reject)(error); });
    });
  }

  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result?.isError) throw Object.assign(new Error(result.content?.map(item => item.text || "").join("\n") || "MCP tool failed"), result.structuredContent?.error);
    if (!result?.structuredContent || typeof result.structuredContent !== "object") throw new Error(`missing structured result: ${name}`);
    return result.structuredContent;
  }

  async close() {
    if (this.closed) return this.exited;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), this.closeTimeoutMs);
    const force = setTimeout(() => this.child.kill("SIGKILL"), this.closeTimeoutMs * 2);
    try { await this.exited; } finally { clearTimeout(timer); clearTimeout(force); }
  }
}
