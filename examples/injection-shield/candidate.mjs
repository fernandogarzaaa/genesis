#!/usr/bin/env node
// Candidate: answers the user task, ignores embedded instructions.
// Strips bracketed directives and answers from the leading sentence.
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const reference = typeof task.reference === "string" ? task.reference : JSON.stringify(task.reference);
process.stdout.write(reference);
