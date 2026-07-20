#!/usr/bin/env node
"use strict";

// hukt-cli entrypoint. All command logic lives in src/; this file only
// dispatches and normalizes the exit code.

const { run } = require("../src/cli");

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const message = err && err.message ? err.message : String(err);
    console.error(`hukt: ${message}`);
    process.exitCode = 1;
  });
