import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { clearDaemonPidFile, getDaemonStatus, writeDaemonPidFile } from "../src/control/daemon.js";
import { getMagiPaths } from "../src/paths.js";
import { makeTempRoot, type TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

describe("named daemon instances", () => {
  it("keeps desktop lifecycle files separate while sharing the Magi config root", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const desktopEnv = { ...temp.env, MAGI_DAEMON_INSTANCE: "desktop" };

    writeDaemonPidFile(paths, {
      pid: process.pid,
      port: 8769,
      bind: "127.0.0.1",
      allowAnyCwd: false
    });
    writeDaemonPidFile(
      paths,
      {
        pid: process.pid,
        port: 8770,
        bind: "127.0.0.1",
        allowAnyCwd: true
      },
      desktopEnv
    );

    expect(getDaemonStatus(paths)).toMatchObject({
      running: true,
      instance: "default",
      port: 8769,
      allowAnyCwd: false
    });
    expect(getDaemonStatus(paths, desktopEnv)).toMatchObject({
      running: true,
      instance: "desktop",
      port: 8770,
      allowAnyCwd: true
    });
    expect(existsSync(path.join(paths.stateRoot, "daemon", "magi.pid"))).toBe(true);
    expect(existsSync(path.join(paths.stateRoot, "daemon", "magi-desktop.pid"))).toBe(true);

    clearDaemonPidFile(paths, desktopEnv);

    expect(getDaemonStatus(paths).running).toBe(true);
    expect(getDaemonStatus(paths, desktopEnv).running).toBe(false);
  });

  it("rejects unsafe daemon instance names", () => {
    temp = makeTempRoot();
    const env = temp.env;
    const paths = getMagiPaths(env);
    expect(() => getDaemonStatus(paths, { ...env, MAGI_DAEMON_INSTANCE: "../other" })).toThrow(
      "MAGI_DAEMON_INSTANCE"
    );
  });

  it("does not let an exiting process clear a replacement instance PID file", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const desktopEnv = { ...temp.env, MAGI_DAEMON_INSTANCE: "desktop" };
    const replacementPid = process.pid + 100_000;

    writeDaemonPidFile(
      paths,
      { pid: replacementPid, port: 8770, bind: "127.0.0.1", allowAnyCwd: true },
      desktopEnv
    );

    expect(clearDaemonPidFile(paths, desktopEnv, process.pid)).toBe(false);
    expect(existsSync(path.join(paths.stateRoot, "daemon", "magi-desktop.pid"))).toBe(true);
  });
});
