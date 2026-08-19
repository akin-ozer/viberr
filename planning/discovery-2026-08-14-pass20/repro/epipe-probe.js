// Mimic discoverStdioMcpTools' send(): spawn a fast-exiting command with piped
// stdio and write the JSON-RPC handshake to its stdin, with NO 'error' listener
// on child.stdin (exactly like resources.server.ts's `send`).
const { spawn } = require("node:child_process");
let uncaught = 0;
process.on("uncaughtException", (e) => {
  uncaught++;
  console.log("UNCAUGHT:", e.code || "", String(e.message).slice(0, 120));
});
function send(child, msg) {
  try {
    child.stdin?.write(`${JSON.stringify(msg)}\n`);
  } catch {
    /* mirrors the app: sync catch only */
  }
}
function once() {
  return new Promise((res) => {
    const child = spawn("node", ["-e", "console.error('boom'); process.exit(2)"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MCP_CREDENTIAL: "SUPERSECRET-7801-abc" },
    });
    child.on("error", () => {});
    child.on("exit", () => {
      // the probe's finish() path also writes nothing more, but the timer below
      // keeps writing like a slow handshake would
    });
    send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const t = setInterval(() => send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" }), 10);
    setTimeout(() => {
      clearInterval(t);
      try { child.kill(); } catch {}
      res();
    }, 250);
  });
}
(async () => {
  for (let i = 0; i < 40; i++) await once();
  console.log("done; uncaught =", uncaught);
})();
