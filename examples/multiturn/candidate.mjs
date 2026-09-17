#!/usr/bin/env node
// Candidate: accumulates conversation history and resolves on the last turn.
// Reads the turn task file ({task/input, context.history, context.turn}).
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const history = task.context?.history ?? [];
const turn = task.context?.turn ?? 1;
const total = Array.isArray(task.turns) ? task.turns.length : history.length + 1;

const seen = [...history.map((m) => `${m.role}: ${m.content}`), `user: ${task.input ?? ""}`].join(" | ");
let message;
if (/never arrived|missing/i.test(seen) && turn >= total) {
  message = "escalated: order #42 missing";
} else if (/broken/i.test(seen) && /refund/i.test(seen) && turn >= total) {
  message = "resolved: refund issued";
} else {
  message = `noted (turn ${turn})`;
}
const done = turn >= total;
process.stdout.write(JSON.stringify({ message, done }));
