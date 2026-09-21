// child_process: what a program can observe of a child it runs. Must print exactly what Node.js prints.
const cp = require("child_process");
const out = [];
const say = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

const ok = cp.spawnSync("sh", ["-c", "echo out; echo err >&2; exit 3"]);
say("sync", ok.status, ok.signal, String(ok.stdout).trim(), String(ok.stderr).trim(), Buffer.isBuffer(ok.stdout));
const enc = cp.spawnSync("sh", ["-c", "printf héllo"], { encoding: "utf8" });
say("encoding", typeof enc.stdout, enc.stdout);
const binary = cp.spawnSync("sh", ["-c", "printf '\\377\\376A\\000B'"]);
say("bytes", [...binary.stdout]);
const input = cp.spawnSync("cat", { input: "fed in" });
say("input", String(input.stdout));
const killed = cp.spawnSync("sh", ["-c", "kill -9 $$"]);
say("signal", killed.status, killed.signal);
const missing = cp.spawnSync("graak-no-such-program", []);
say("missing", missing.status, missing.error && missing.error.code);
try {
  cp.execSync("exit 5", { stdio: "pipe" });
} catch (e) {
  say("execSync", e.status);
}
say("execFileSync", cp.execFileSync("echo", ["a", "b"], { encoding: "utf8" }).trim());
say("shell", String(cp.spawnSync("echo $((1+2))", { shell: true }).stdout).trim());
say("env", String(cp.spawnSync("sh", ["-c", "echo $GRAAK_CHILD"], { env: { ...process.env, GRAAK_CHILD: "set" } }).stdout).trim());
say("cwd", String(cp.spawnSync("pwd", { cwd: "/" }).stdout).trim());

const child = cp.spawn("cat");
let got = "";
child.stdout.on("data", (d) => (got += d));
child.stdin.write("through ");
child.stdin.end("cat");
child.on("close", (code, signal) => {
  say("spawn", code, signal, got);
  const gone = cp.spawn("graak-no-such-program");
  gone.on("error", (e) => {
    say("spawn missing", e.code);
    for (const l of out) console.log(l);
  });
});
