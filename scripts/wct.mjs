// Run a wallet-cli command with a hard timeout (macOS has no `timeout`).
// Usage: node scripts/wct.mjs 12000 genuine-check
import { spawn } from "node:child_process";
const ms = Number(process.argv[2]);
const args = process.argv.slice(3);
const c = spawn("wallet-cli", args, { stdio: ["ignore", "pipe", "pipe"] });
let out = "", err = "";
c.stdout.on("data", d => out += d);
c.stderr.on("data", d => err += d);
const t = setTimeout(() => { c.kill("SIGKILL"); console.log("TIMEOUT after " + ms + "ms"); process.exit(3); }, ms);
c.on("close", code => {
  clearTimeout(t);
  const body = (out + err).trim();
  try { console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 900)); }
  catch { console.log(body.slice(0, 900) || "(no output)"); }
  console.log("exit=" + code);
  process.exit(code ?? 1);
});
