"use strict";

// `hukt hook add <preset>` -- validate a preset and merge it into the local
// hook spec file (default ./hukt.json). The spec is the same shape the web
// Builder produces:
//   { "version": 1, "name": "composed-hook",
//     "presets": [{ "key": "royalty", "params": { "bps": "500" } }] }

const fs = require("fs");
const path = require("path");
const { CliError, printKv } = require("./util");
const { PRESET_KEYS, buildPresetEntry, findConflicts } = require("./presets");

const SPEC_VERSION = 1;
const DEFAULT_SPEC_PATH = "./hukt.json";

function specPathFor(flags) {
  return path.resolve(process.cwd(), flags.spec || DEFAULT_SPEC_PATH);
}

function emptySpec() {
  return { version: SPEC_VERSION, name: "composed-hook", presets: [] };
}

/** Load and structurally validate a spec file. */
function loadSpec(specPath) {
  let raw;
  try {
    raw = fs.readFileSync(specPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    throw new CliError(`${specPath} is not valid JSON`);
  }
  if (spec.version !== SPEC_VERSION) {
    throw new CliError(`${specPath}: unsupported spec version ${spec.version} (expected ${SPEC_VERSION})`);
  }
  if (!Array.isArray(spec.presets)) {
    throw new CliError(`${specPath}: "presets" must be an array`);
  }
  for (const entry of spec.presets) {
    if (!entry || typeof entry.key !== "string" || !PRESET_KEYS.includes(entry.key)) {
      throw new CliError(`${specPath}: unknown preset entry ${JSON.stringify(entry && entry.key)}`);
    }
    if (entry.params === undefined) entry.params = {};
    if (typeof entry.params !== "object" || Array.isArray(entry.params)) {
      throw new CliError(`${specPath}: preset ${entry.key} has malformed "params"`);
    }
  }
  return spec;
}

function saveSpec(specPath, spec) {
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
}

function printSpecState(specPath, spec) {
  printKv([
    ["Spec", specPath],
    ["Name", spec.name],
    ["Presets", spec.presets.length ? String(spec.presets.length) : "0"],
  ]);
  for (const entry of spec.presets) {
    const params = Object.entries(entry.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`  - ${entry.key}${params ? `  ${params}` : ""}`);
  }
  const conflicts = findConflicts(spec.presets.map((p) => p.key));
  for (const [a, b] of conflicts) {
    console.log(`  warning: ${a} and ${b} cannot coexist on one mint; 'hukt build' will refuse this spec`);
  }
}

async function cmdHookAdd(presetKey, flags) {
  if (!presetKey) {
    throw new CliError(`hook add requires a preset (one of: ${PRESET_KEYS.join(", ")})`);
  }
  if (flags.name !== undefined && String(flags.name).trim() === "") {
    throw new CliError("--name must not be empty");
  }
  const entry = buildPresetEntry(presetKey, flags);

  const specPath = specPathFor(flags);
  const spec = loadSpec(specPath) || emptySpec();
  if (flags.name) spec.name = String(flags.name).trim();

  const existing = spec.presets.findIndex((p) => p.key === entry.key);
  const action = existing >= 0 ? "updated" : "added";
  if (existing >= 0) {
    spec.presets[existing] = entry;
  } else {
    spec.presets.push(entry);
  }
  saveSpec(specPath, spec);

  console.log(`Preset '${entry.key}' ${action}.`);
  console.log("");
  printSpecState(specPath, spec);
  return 0;
}

module.exports = {
  DEFAULT_SPEC_PATH,
  cmdHookAdd,
  loadSpec,
  printSpecState,
  specPathFor,
};
