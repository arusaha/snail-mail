import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const binary = resolve("releases/SnailMailTray.exe");
test(
  "tray runs without a console, prevents duplicates, restarts and stops only its child",
  {
    skip: process.platform !== "win32" || !existsSync(binary),
    timeout: 45000,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "snail-tray-test-"));
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "server"));
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    writeFileSync(join(root, "data/config.json"), JSON.stringify({ port }));
    writeFileSync(
      join(root, "server/index.mjs"),
      `
    import { createServer } from 'node:http';
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    if(process.env.SNAIL_TRAY_MANAGED !== '1' || process.env.PORT || process.env.SNAIL_DATA_DIR) process.exit(2);
    const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}).listen(${port},'127.0.0.1');
    const input=createInterface({input:process.stdin});
    const stop=()=>{appendFileSync('data/stops.txt',process.pid+'\\n');server.close(()=>process.exit(0));};
    input.on('line',line=>{if(line==='snail-mail:shutdown') stop();}); input.on('close',stop);
  `,
    );
    const launch = (args = []) =>
      spawn(binary, ["--root", root, "--node", process.execPath, ...args], {
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          PORT: "1",
          SNAIL_DATA_DIR: "unused-test-override",
        },
      });
    const control = async (arg) => {
      const p = launch([arg]);
      return (await once(p, "exit"))[0];
    };
    let child = launch();
    const waitFor = async (fn) => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        try {
          const v = fn();
          if (v) return v;
        } catch {}
        await delay(150);
      }
      throw new Error("Tray lifecycle did not reach expected state");
    };
    const status = () =>
      JSON.parse(readFileSync(join(root, "data/tray-status.json"), "utf8"));
    t.after(async () => {
      if (child.exitCode === null) {
        const done = once(child, "exit");
        await control("--quit");
        await Promise.race([done, delay(6000)]);
        if (child.exitCode === null) {
          child.kill();
          await done;
        }
      }
      // Verify the recursive cleanup target is exactly the test-created temp folder.
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("snail-tray-test-"));
      rmSync(root, { recursive: true, force: true });
    });
    const first = await waitFor(() => {
      const s = status();
      return s.state === "Server running" && s;
    });
    assert.equal(first.consoleAttached, false);
    assert.equal(first.trayPid, child.pid);
    const duplicate = launch();
    assert.equal((await once(duplicate, "exit"))[0], 0);
    assert.equal(status().serverPid, first.serverPid);
    assert.equal(await control("--restart"), 0);
    const second = await waitFor(() => {
      const s = status();
      return (
        s.state === "Server running" && s.serverPid !== first.serverPid && s
      );
    });
    assert.equal(second.trayPid, first.trayPid);
    assert.ok(
      readFileSync(join(root, "data/stops.txt"), "utf8").includes(
        String(first.serverPid),
      ),
    );
    const done = once(child, "exit");
    assert.equal(await control("--quit"), 0);
    assert.equal((await done)[0], 0);
    assert.equal(status().state, "Stopped");
    assert.ok(
      readFileSync(join(root, "data/stops.txt"), "utf8").includes(
        String(second.serverPid),
      ),
    );
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
  },
);
