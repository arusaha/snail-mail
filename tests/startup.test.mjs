import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";

const binary = resolve(process.env.SNAIL_TRAY_BINARY || "releases/SnailMailTray.exe");
test("Windows startup setting persists and the tray toggle preserves the running server", {
  skip: process.platform !== "win32" || !existsSync(binary), timeout: 45000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "snail-startup-test-"));
  const appRoot = join(root, "App with spaces & punctuation");
  mkdirSync(join(appRoot, "data"), { recursive: true });
  mkdirSync(join(appRoot, "server"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("snail-startup-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  writeFileSync(join(appRoot, "data/config.json"), JSON.stringify({ port }));
  writeFileSync(join(appRoot, "server/index.mjs"), `
    import { createServer } from 'node:http';
    import { createInterface } from 'node:readline';
    const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}).listen(${port},'127.0.0.1');
    const input=createInterface({input:process.stdin});
    const stop=()=>server.close(()=>process.exit(0));
    input.on('line',line=>{if(line==='snail-mail:shutdown') stop();});input.on('close',stop);
  `);
  const harness = join(root, "StartupSmoke.exe");
  const compiler = join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const built = spawnSync(compiler, ["/nologo", "/target:exe", "/main:StartupSmoke", `/out:${harness}`,
    "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
    "/reference:System.Xml.Linq.dll", "/reference:Microsoft.CSharp.dll",
    resolve("windows/SnailMailTray.cs"), resolve("windows/StartupRegistration.cs"), resolve("tests/windows/StartupSmoke.cs")], { encoding: "utf8", windowsHide: true });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const { stdout } = await promisify(execFile)(harness, [appRoot, process.execPath, binary], { windowsHide: true, timeout: 35000 });
  assert.match(stdout, /Verified native startup/);
});
