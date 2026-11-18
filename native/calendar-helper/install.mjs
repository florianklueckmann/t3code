import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

function install() {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installer has no Effect runtime.
  if (NodeOS.platform() !== "darwin") throw new Error("The T3 Calendar Helper is macOS-only.");

  const source = NodeURL.fileURLToPath(new URL(".", import.meta.url));
  const appName = "T3 Calendar Helper.app";
  const applications = NodePath.join(NodeOS.homedir(), "Applications");
  const destination = NodePath.join(applications, appName);

  const loginKeychain = output("/usr/bin/security", ["login-keychain"]).replace(/^"|"$/g, "");
  const identities = output("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    loginKeychain,
  ]);
  const matches = [...identities.matchAll(/^\s*\d+\) ([A-F0-9]{40}) "Apple Development:/gm)];
  if (matches.length !== 1) {
    throw new Error("Expected one valid Apple Development signing identity in the login keychain.");
  }
  const identity = matches[0][1];

  run("/usr/bin/swift", ["test", "--package-path", source]);
  run("/usr/bin/swift", ["build", "-c", "release", "--package-path", source]);
  const binaryPath = output("/usr/bin/swift", [
    "build",
    "-c",
    "release",
    "--package-path",
    source,
    "--show-bin-path",
  ]);

  const staging = NodeFS.mkdtempSync(NodePath.join(source, ".build", "bundle-"));
  const bundle = NodePath.join(staging, appName);
  const contents = NodePath.join(bundle, "Contents");
  NodeFS.mkdirSync(NodePath.join(contents, "MacOS"), { recursive: true });
  NodeFS.copyFileSync(NodePath.join(source, "Info.plist"), NodePath.join(contents, "Info.plist"));
  NodeFS.copyFileSync(
    NodePath.join(binaryPath, "CalendarHelper"),
    NodePath.join(contents, "MacOS", "CalendarHelper"),
  );

  const signed = NodeChildProcess.spawnSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--entitlements",
      NodePath.join(source, "CalendarHelper.entitlements"),
      "--sign",
      identity,
      bundle,
    ],
    { timeout: 25_000, killSignal: "SIGKILL" },
  );
  if (signed.status !== 0) {
    throw new Error(
      signed.error?.code === "ETIMEDOUT"
        ? "codesign timed out. Run this command in the logged-in session and allow keychain access."
        : "codesign failed. Check access to the Apple Development private key in the login keychain.",
    );
  }
  run("/usr/bin/codesign", ["--verify", "--strict", bundle]);
  NodeFS.mkdirSync(applications, { recursive: true });
  run("/usr/bin/swift", [NodePath.join(source, "install-bundle.swift"), bundle, destination]);
  console.log(`Installed ${destination}`);
}

function run(command, args) {
  NodeChildProcess.execFileSync(command, args, { stdio: "inherit" });
}

function output(command, args) {
  return NodeChildProcess.execFileSync(command, args, { encoding: "utf8" }).trim();
}

try {
  install();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
