#!/usr/bin/env node
/**
 * Source ZIP packer for InfraCore GEO.
 *
 * Creates a password-protected ZIP with the project sources for
 * development or internal handover. End users should receive the
 * packaged Electron desktop app from dist/.
 */

import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

const INCLUDE = [
  "electron",
  "ifc example",
  "index.html",
  "package-lock.json",
  "package.json",
  "README.md",
  "server",
  "server.js",
  "src",
  "start-app.bat"
];

function getArg(name) {
  const args = process.argv.slice(2);
  const short = `-${name[0]}`;
  const long = `--${name}`;
  const index = args.findIndex((arg) => arg === long || arg === short);
  return index !== -1 ? args[index + 1] ?? null : null;
}

function prompt(question, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) process.stdout.write(question);

  return new Promise((resolve) => {
    if (hidden) {
      rl.stdoutMuted = true;
      rl._writeToOutput = (text) => {
        if (!rl.stdoutMuted) process.stdout.write(text);
      };
    }

    rl.question(hidden ? "" : question, (answer) => {
      if (hidden) process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

function find7zip() {
  const candidates = [
    "7z",
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe"
  ];

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" i`, { stdio: "ignore" });
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

async function main() {
  let version = getArg("version") || getArg("v");
  if (!version) version = await prompt("Version (z.B. 1.2.0): ");
  version = version.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error("Ungueltige Version. Erwartet: MAJOR.MINOR.PATCH");
    process.exit(1);
  }

  let password = getArg("password") || getArg("p");
  if (!password) password = await prompt("Passwort: ", true);
  if (!password) {
    console.error("Passwort darf nicht leer sein.");
    process.exit(1);
  }

  const sevenZip = find7zip();
  if (!sevenZip) {
    console.error("7-Zip nicht gefunden. Bitte 7-Zip installieren.");
    process.exit(1);
  }

  const pkgPath = join(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const previousVersion = pkg.version;
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`package.json: ${previousVersion} -> v${version}`);

  const stagingBase = join(ROOT, ".pack-staging");
  const folderName = `infracore-geo-v${version}`;
  const stagingDir = join(stagingBase, folderName);
  if (existsSync(stagingBase)) rmSync(stagingBase, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  console.log("\nKopiere Dateien:");
  for (const name of INCLUDE) {
    const source = join(ROOT, name);
    if (!existsSync(source)) {
      console.log(`  Uebersprungen: ${name}`);
      continue;
    }
    cpSync(source, join(stagingDir, name), { recursive: true });
    console.log(`  -> ${name}`);
  }

  writeFileSync(join(stagingDir, "VERSION"), `${version}\n`, "utf8");
  console.log("  -> VERSION");

  const releasesDir = join(ROOT, "releases");
  mkdirSync(releasesDir, { recursive: true });
  const zipName = `infracore-geo-v${version}.zip`;
  const zipPath = join(releasesDir, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);

  const bin = sevenZip.includes(" ") ? `"${sevenZip}"` : sevenZip;
  const command = `${bin} a -tzip -p"${password}" -mem=AES256 "${zipPath}" "${folderName}" -r`;

  try {
    execSync(command, { cwd: stagingBase, stdio: "inherit" });
  } catch (error) {
    rmSync(stagingBase, { recursive: true, force: true });
    console.error(`Fehler beim Packen: ${error.message}`);
    process.exit(1);
  }

  rmSync(stagingBase, { recursive: true, force: true });

  const sizeKb = Math.round(statSync(zipPath).size / 1024);
  console.log(`\nFertig: releases/${zipName} (${sizeKb} KB)`);
  console.log("Hinweis: Dies ist ein Quellpaket. Fuer Endanwender bitte die Electron-Desktop-App aus dist/ verteilen.");
}

main().catch((error) => {
  console.error(`Unerwarteter Fehler: ${error.message}`);
  process.exit(1);
});
