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
package. The function is located by name via AST; its exact source segment,
plus the transitive closure of same-file module-level helper functions and
constants it references, is executed in a disposable Docker container
(--net=none, read-only FS, memory/CPU/pids limits, wall-clock timeout) --
never in the auditor process. The old in-process `exec` namespace was name
separation only, NOT a security boundary, and must not be mistaken for one.

See docs/assurance/findings/HUB-003-build-optimization-reward-gaming.md and
HUB-004-carcassonne-placement-reward-defects.md for confirmed results.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import inspect
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

DOCKER_IMAGE = "python:3.12-slim"
DOCKER_TIMEOUT_S = 60
DOCKER_MEMORY = "256m"
DOCKER_CPUS = "1.0"


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


def _referenced_names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}


def _module_level_definitions(tree: ast.Module) -> dict[str, ast.AST]:
    """Map name -> defining node for every top-level function and simple
    constant assignment in a module. Deliberately excludes classes and
    anything not directly `exec`-able in isolation -- a reward function
    that depends on one of those still fails with a NameError, same as
    before this existed."""
    out: dict[str, ast.AST] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out[node.name] = node
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    out[target.id] = node
    return out


def _resolve_dependencies(tree: ast.Module, source: str, entry: ast.AST) -> list[str]:
    """A reward function calling a same-file helper (`can_place`,
    `get_piece_cells`, a module-level `PIECES` dict, ...) is common -- more
    common than the single-function extraction this tool started with could
    handle. This walks the entry node's referenced names, resolves any that
    match a module-level definition, and recurses into each one's own
    references, so the exec namespace carries the whole reachable same-file
    closure rather than just the one named function."""
    definitions = _module_level_definitions(tree)
    resolved: dict[str, str] = {}
    queue = list(_referenced_names(entry))
    seen_names = set(queue)

    while queue:
        name = queue.pop()
        if name in resolved or name not in definitions:
            continue
        dep_node = definitions[name]
        segment = ast.get_source_segment(source, dep_node)
        if segment is None:
            continue
        resolved[name] = segment
        for ref in _referenced_names(dep_node):
            if ref not in seen_names:
                seen_names.add(ref)
                queue.append(ref)

    return list(resolved.values())


def load_reward_fn(
    env_dir: Path, func_name: str, *, allow_unsafe_local: bool = False
) -> Callable[..., Any]:
    """Load a named reward function WITHOUT executing inspected code.

    By default this only EXTRACTS source (pure AST, no exec) and returns a
    caller that replays it inside Docker (see score_completions_docker).
    Passing allow_unsafe_local=True restores the legacy in-process exec for
    offline dev only — it runs third-party code in the auditor process with
    full builtins and must never be used on untrusted environments.
    """
    if not allow_unsafe_local:
        raise RuntimeError(
            "load_reward_fn without allow_unsafe_local=True no longer execs code. "
            "Use extract_reward_source() + score_completions_docker() instead."
        )
    import warnings

    warnings.warn(
        "allow_unsafe_local execs inspected third-party code in-process: "
        "name separation only, NOT a sandbox. Docker is required for real use.",
        stacklevel=2,
    )
    path, source_segment = find_function_source(env_dir, func_name)
    module_source = path.read_text()
    tree = ast.parse(module_source, filename=str(path))
    entry = next(
        n for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == func_name
    )

    namespace: dict[str, Any] = {"re": re, "json": json, "math": math, "Any": Any, "Optional": Optional}
    for dep_source in _resolve_dependencies(tree, module_source, entry):
        exec(compile(dep_source, f"<{func_name}-dependency>", "exec"), namespace)
    exec(compile(source_segment, f"<{func_name}>", "exec"), namespace)
    return namespace[func_name]


def extract_reward_source(env_dir: Path, func_name: str) -> tuple[list[str], str]:
    """Pure-static extraction: (dependency segments, entry segment). No exec."""
    _, source_segment = find_function_source(env_dir, func_name)
    # Re-parse the defining module for dependency closure.
    for path in sorted(env_dir.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            module_source = path.read_text()
            tree = ast.parse(module_source, filename=str(path))
        except (SyntaxError, UnicodeDecodeError):
            continue
        entry = next(
            (n for n in ast.walk(tree)
             if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == func_name),
            None,
        )
        if entry is not None and ast.get_source_segment(module_source, entry) == source_segment:
            return _resolve_dependencies(tree, module_source, entry), source_segment
    # Fallback: search again (segment match by equality can miss formatting).
    path, _ = find_function_source(env_dir, func_name)
    module_source = path.read_text()
    tree = ast.parse(module_source, filename=str(path))
    entry = next(
        n for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == func_name
    )
    return _resolve_dependencies(tree, module_source, entry), source_segment


def build_probe_script(deps: list[str], entry: str, func_name: str, answer: str, completions: dict[str, str]) -> str:
    """Assemble a self-contained scoring script for the container."""
    payload = json.dumps({"func": func_name, "answer": answer, "completions": completions})
    parts = [
        "import asyncio, inspect, json, math, re, sys",
        "from typing import Any, Optional",
        *deps,
        entry,
        f"_PAYLOAD = {payload!r}",
        "async def _call(fn, *a, **k):\n    r = fn(*a, **k)\n    return await r if inspect.isawaitable(r) else r",
        "async def _main():\n"
        "    p = json.loads(_PAYLOAD)\n"
        "    fn = globals()[p['func']]\n"
        "    out = {}\n"
        "    for label, text in p['completions'].items():\n"
        "        t = [{'role': 'assistant', 'content': text}]\n"
        "        out[label] = await _call(fn, t, p['answer'])\n"
        "    sys.stdout.write(json.dumps(out))",
        "asyncio.run(_main())",
    ]
    return "\n\n".join(parts)


def score_completions_docker(
    env_dir: Path,
    func_name: str,
    answer: str,
    completions: dict[str, str],
    *,
    image: str = DOCKER_IMAGE,
    timeout_s: int = DOCKER_TIMEOUT_S,
    memory: str = DOCKER_MEMORY,
    cpus: str = DOCKER_CPUS,
    max_output_bytes: int = 65536,
) -> dict[str, float]:
    """Score completions inside a disposable Docker container. Required path."""
    if shutil.which("docker") is None:
        raise RuntimeError("docker is required to probe reward functions (no local-exec fallback)")
    deps, entry = extract_reward_source(env_dir, func_name)
    script = build_probe_script(deps, entry, func_name, answer, completions)
    with tempfile.TemporaryDirectory(prefix="genesis-probe-") as tmp:
        probe = Path(tmp) / "probe.py"
        probe.write_text(script, encoding="utf8")
        cmd = [
            "docker", "run", "--rm", "--net=none", "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
            "--memory", memory, "--cpus", cpus, "--pids-limit", "64",
            "-v", f"{probe}:/probe/probe.py:ro",
            image, "python", "/probe/probe.py",
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout_s)
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"probe container timed out after {timeout_s}s") from e
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf8", "replace")[:2000]
        raise RuntimeError(f"probe container failed (exit {proc.returncode}): {err}")
    out = (proc.stdout or b"")[:max_output_bytes].decode("utf8", "replace")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"probe container returned non-JSON output: {out[:500]}") from e
    return {k: float(v) for k, v in data.items()}


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
    parser.add_argument("--docker-image", default=DOCKER_IMAGE)
    parser.add_argument("--timeout-s", type=int, default=DOCKER_TIMEOUT_S)
    parser.add_argument("--memory", default=DOCKER_MEMORY)
    parser.add_argument("--cpus", default=DOCKER_CPUS)
    parser.add_argument("--allow-local-exec", action="store_true",
                        help="DEV ONLY: exec inspected code in-process (unsafe, never on untrusted envs)")
    args = parser.parse_args()

    completions = json.loads(args.completions.read_text())
    if args.allow_local_exec:
        fn = load_reward_fn(args.env_dir, args.func_name, allow_unsafe_local=True)
        scores = score_completions(fn, args.answer, completions)
    else:
        scores = score_completions_docker(
            args.env_dir, args.func_name, args.answer, completions,
            image=args.docker_image, timeout_s=args.timeout_s,
            memory=args.memory, cpus=args.cpus,
        )

    width = max(len(label) for label in scores)
    for label, score in scores.items():
        print(f"{score:.4f}  {label:<{width}}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
