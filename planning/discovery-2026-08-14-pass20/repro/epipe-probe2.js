// EXACT app write pattern: spawn, then ONE synchronous `send(initialize)`.
// No interval, no second write — this is `discoverStdioMcpTools` verbatim.
const { spawn } = require("node:child_process");
let uncaught = 0, runs = 0;
process.on("uncaughtException", (e) => { uncaught++; console.log("UNCAUGHT:", e.code, String(e.message).slice(0,80)); });
function once(cmdArgs) {
  return new Promise((res) => {
    const child = spawn("node", cmdArgs, { stdio: ["pipe","pipe","pipe"], env: { ...process.env, MCP_CREDENTIAL: "SUPERSECRET-7801-abc" } });
    child.on("error", () => {});
    child.stderr?.on("data", () => {});
    child.on("exit", () => { try { child.kill(); } catch {} setTimeout(res, 5); });
    try { child.stdin?.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}}) + "\n"); } catch {}
    runs++;
  });
}
(async () => {
  const cmd = ["-e", "console.error('CRED=' + process.env.MCP_CREDENTIAL); process.exit(2)"];
  for (let i = 0; i < 120; i++) await once(cmd);
  console.log("done; runs =", runs, "uncaught =", uncaught);
})();
