#!/usr/bin/env python3
"""
Confirm a static reward-function target dynamically.

HUB-002 produced 47 static targets and stopped there deliberately: "47
targets, not 47 defects." Confirming one means constructing a completion that
satisfies the flagged pattern without doing the task, and checking whether
the grader still pays out. This is that check, generalized.

It does not assume `verifiers`/`datasets`/any of an environment's real
dependencies are installed, because a reward function is almost always a
pure function of (completion, answer) with no need for the rest of the
package. The function is located by name via AST and its exact source
segment is exec'd in an isolated namespace -- the environment package itself
is never imported, so this works even when its dependencies are absent.

See docs/assurance/findings/HUB-003-build-optimization-reward-gaming.md for
the first confirmed result, against tohan/catan-resource-trading-simulator.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import inspect
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable


class FunctionNotFound(Exception):
    pass


def find_function_source(env_dir: Path, func_name: str) -> tuple[Path, str]:
    """Search every .py file under env_dir for a def/async def named
    func_name (top-level or nested in a class) and return (file, its exact
    source segment) for the first match. Decorators are not included -- this
    extracts the raw callable, not whatever a registration decorator wraps
    it into, which is what scoring it standalone requires."""
    for path in sorted(env_dir.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            source = path.read_text()
            tree = ast.parse(source, filename=str(path))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
                segment = ast.get_source_segment(source, node)
                if segment is not None:
                    return path, segment
    raise FunctionNotFound(f'no def/async def "{func_name}" found under {env_dir}')


def load_reward_fn(env_dir: Path, func_name: str) -> Callable[..., Any]:
    """Load a named reward function without importing the environment
    package. If the function body actually depends on a name this namespace
    doesn't provide, that fails loudly as a NameError rather than silently."""
    _, source = find_function_source(env_dir, func_name)
    namespace: dict[str, Any] = {"re": re, "Any": Any}
    exec(compile(source, f"<{func_name}>", "exec"), namespace)
    return namespace[func_name]


async def _call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    result = fn(*args, **kwargs)
    if inspect.isawaitable(result):
        result = await result
    return result


def score_completions(fn: Callable[..., Any], answer: str, completions: dict[str, str]) -> dict[str, float]:
    """Run one reward function against {label: completion text}, wrapping
    each as the one-turn chat transcript `verifiers`-style rewards expect."""

    async def run() -> dict[str, float]:
        out: dict[str, float] = {}
        for label, text in completions.items():
            transcript = [{"role": "assistant", "content": text}]
            out[label] = await _call(fn, transcript, answer)
        return out

    return asyncio.run(run())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("env_dir", type=Path, help="a directory from `prime env pull`")
    parser.add_argument("func_name", help="the reward function's name, e.g. build_optimization_reward")
    parser.add_argument("answer", help="the ground-truth `answer` string for one dataset row")
    parser.add_argument("completions", type=Path, help="a JSON file of {label: completion text} to score")
    args = parser.parse_args()

    fn = load_reward_fn(args.env_dir, args.func_name)
    completions = json.loads(args.completions.read_text())
    scores = score_completions(fn, args.answer, completions)

    width = max(len(label) for label in scores)
    for label, score in scores.items():
        print(f"{score:.4f}  {label:<{width}}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
