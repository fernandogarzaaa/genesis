#!/usr/bin/env node
// Fixture: two-turn subject. Replies "ack" on turn 1, final answer + done on
// turn 2 (or the only turn). Reads the turn task envelope.
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const history = task.context?.history ?? [];
const assistants = history.filter((m) => m.role === "assistant").length;
if (assistants === 0) {
  process.stdout.write(JSON.stringify({ message: "ack", done: false }));
} else {
  process.stdout.write(JSON.stringify({ message: "final", done: true }));
}
