import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
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
  const { identity, team } = signingIdentity(loginKeychain);
  const bundleId = output("/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    NodePath.join(source, "Info.plist"),
  ]);
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error("Invalid Calendar Helper bundle ID.");
  const requirement = [
    "=designated =>",
    "identifier " + JSON.stringify(bundleId),
    "and anchor apple generic",
    "and certificate 1[field.1.2.840.113635.100.6.2.1] exists",
    "and certificate leaf[subject.OU] = " + JSON.stringify(team),
  ].join(" ");

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
      "--requirements",
      requirement,
      "--keychain",
      loginKeychain,
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
  NodeFS.rmSync(staging, { recursive: true });
  console.log(`Installed ${destination}`);
}

function signingIdentity(loginKeychain) {
  const identities = output("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    loginKeychain,
  ]);
  const candidates = new Set(
    [...identities.matchAll(/^\s*\d+\) ([A-F0-9]{40}) "Apple Development:/gm)].map(
      (match) => match[1],
    ),
  );
  const override = process.env.T3_CALENDAR_SIGNING_IDENTITY?.trim().toUpperCase();
  if (candidates.size === 0) {
    throw new Error("The login keychain has no valid Apple Development signing identity.");
  }
  if (override && !candidates.has(override)) {
    throw new Error(
      "T3_CALENDAR_SIGNING_IDENTITY must be the SHA-1 hash of a valid Apple Development identity in the login keychain.",
    );
  }
  if (!override && candidates.size > 1) {
    throw new Error(
      "Multiple valid Apple Development identities found. Set T3_CALENDAR_SIGNING_IDENTITY to the chosen identity's SHA-1 hash.",
    );
  }
  const identity = override || candidates.values().next().value;
  const certificates = output("/usr/bin/security", ["find-certificate", "-a", "-p", loginKeychain]);
  for (const pem of certificates.matchAll(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  )) {
    const certificate = new NodeCrypto.X509Certificate(pem[0]);
    if (certificate.fingerprint.replaceAll(":", "") !== identity) continue;
    const team = certificate.toLegacyObject().subject.OU;
    if (typeof team === "string" && /^[A-Z0-9]{10}$/.test(team)) return { identity, team };
    break;
  }
  throw new Error("Could not read the team ID from the selected Apple Development certificate.");
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
