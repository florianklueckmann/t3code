import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  desktopDir,
  resolveDevProtocolClient,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/electron/WindowsForegroundFocusWorker.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/snapShot/GlobalShiftShortcutWorker.cjs",
  "dist-electron/snapShot/RegionSnapShotWorker.cjs",
  "dist-electron/snapShot/SnapShotAccessibilityWorker.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  {
    directory: "dist-electron/electron",
    files: new Set(["WindowsForegroundFocusWorker.cjs"]),
  },
  {
    directory: "dist-electron/snapShot",
    files: new Set([
      "GlobalShiftShortcutWorker.cjs",
      "RegionSnapShotWorker.cjs",
      "SnapShotAccessibilityWorker.cjs",
    ]),
  },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const maxCrashRetries = 3;
const stableRunMs = 10_000;
const childTreeGracePeriodMs = 1_200;
const remoteDebuggingPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();
const parentPid = process.ppid;
const parentWatchIntervalMs = 1_000;

NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/build-browser-secret.mjs")],
  { stdio: "inherit" },
);

const resources = {
  baseDir: desktopDir,
  files: requiredFiles,
  tcpHost: devServer.hostname,
  tcpPort: port,
};
await waitForResources(resources);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const devProtocolClient = resolveDevProtocolClient();
if (devProtocolClient) {
  childEnv.T3CODE_DESKTOP_APP_USER_MODEL_ID = devProtocolClient.appBundleId;
  childEnv.T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED = "1";
}

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restarting = false;
let crashRetries = 0;
const watchers = [];

function killChildTreeByPid(pid, signal) {
  if (hostPlatform === "win32" || typeof pid !== "number") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function cleanupStaleDevApps() {
  if (hostPlatform === "win32") {
    return;
  }

  const escapedDesktopDir = desktopDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  NodeChildProcess.spawnSync(
    "pkill",
    ["-f", "--", `(^| )--t3code-dev-root=${escapedDesktopDir}( |$)`],
    {
      stdio: "ignore",
    },
  );
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = remoteDebuggingPort
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : [];
  const launchArgs = devProtocolClient
    ? electronArgs
    : [...electronArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
  const electronCommand = resolveElectronLaunchCommand(launchArgs);
  const app = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
  });

  currentApp = app;
  const stableTimer = setTimeout(() => {
    crashRetries = 0;
  }, stableRunMs).unref();
  const stopped = (reason, retry) => {
    clearTimeout(stableTimer);
    if (currentApp !== app) return;
    currentApp = null;
    if (shuttingDown || retry === "none") return;
    if (retry === "crash") {
      if (crashRetries >= maxCrashRetries) {
        console.error(`[desktop-dev] ${reason}; stopped after ${maxCrashRetries} retries.`);
        return;
      }
      crashRetries += 1;
    }
    scheduleRestart(reason);
  };

  app.once("error", (error) => {
    stopped(`could not launch Electron: ${error.message}`, "crash");
  });
  app.once("exit", (code, signal) => {
    const reason = `Electron PID ${app.pid ?? "unknown"} exited with ${signal ?? code}`;
    stopped(reason, signal === null && code === 0 ? "none" : code === 75 ? "requested" : "crash");
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    app.kill("SIGTERM");
    killChildTreeByPid(app.pid, "TERM");
    cleanupStaleDevApps();

    setTimeout(() => {
      if (settled) {
        return;
      }

      app.kill("SIGKILL");
      killChildTreeByPid(app.pid, "KILL");
      cleanupStaleDevApps();
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart(reason) {
  if (shuttingDown || restarting) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(async () => {
    restartTimer = null;
    restarting = true;
    try {
      console.info(`[desktop-dev] Restarting Electron: ${reason}`);
      await stopApp();
      if (shuttingDown) return;
      await waitForResources(resources);
      if (!shuttingDown) startApp();
    } catch (error) {
      console.error("[desktop-dev] Electron restart failed", error);
    } finally {
      restarting = false;
    }
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart(`build output changed: ${directory}/${filename}`);
      },
    );

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (hostPlatform === "win32") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], {
    stdio: "ignore",
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

startWatchers();
cleanupStaleDevApps();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
// A parent killed without forwarding a signal leaves us reparented (to a subreaper on Linux, not
// necessarily PID 1), and nothing else would ever stop the restart loop. This only notices the
// death of our direct parent, so vite.config.ts launches us without a shell in between. Windows
// never reparents, and reading process.ppid there snapshots the process table.
if (hostPlatform !== "win32") {
  setInterval(() => {
    if (process.ppid !== parentPid) {
      void shutdown(129);
    }
  }, parentWatchIntervalMs).unref();
}
