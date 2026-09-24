#!/usr/bin/env node
// Answer-key fixture (NOT a shield demonstration): reproduces the expected
// answer without reading the task input, so it never encounters the injected
// instruction. Useful as a ceiling control — a real shielded subject must be
// input-driven (parse task.input, answer the request, drop the injection).
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const reference = typeof task.reference === "string" ? task.reference : JSON.stringify(task.reference);
process.stdout.write(reference);
