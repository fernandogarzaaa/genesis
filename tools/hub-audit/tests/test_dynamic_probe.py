"""
Tests for dynamic_probe.py's function extraction and scoring.

The synthetic reward function below reproduces the exact shape that made
HUB-003 real: a small, task-relevant component (keyed on the true answer)
alongside larger flat components a buzzword-stuffed completion can win
regardless of correctness.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from dynamic_probe import FunctionNotFound, find_function_source, load_reward_fn, score_completions

GAMEABLE_REWARD = '''
import re

async def gameable_reward(completion, answer, **kwargs):
    text = completion[-1]["content"].lower()
    score = 0.0
    if answer.lower() in text:
        score += 0.4
    if re.search(r"remain|left|after", text):
        score += 0.6
    return score
'''

SYNC_REWARD = '''
def sync_reward(completion, answer, **kwargs):
    text = completion[-1]["content"].lower()
    return 1.0 if answer.lower() in text else 0.0
'''


def write(root: Path, name: str, source: str) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
    return path


def test_find_function_source_locates_across_files(tmp_path: Path) -> None:
    write(tmp_path, "unrelated.py", "def not_it(): pass\n")
    write(tmp_path, "pkg/env.py", GAMEABLE_REWARD)

    path, segment = find_function_source(tmp_path, "gameable_reward")

    assert path.name == "env.py"
    assert segment.startswith("async def gameable_reward")


def test_find_function_source_locates_methods_inside_classes(tmp_path: Path) -> None:
    write(
        tmp_path,
        "env.py",
        """
class Task:
    async def answer_correct(self, completion, answer, **kwargs):
        return 1.0
""",
    )

    _, segment = find_function_source(tmp_path, "answer_correct")
    assert "async def answer_correct" in segment


def test_find_function_source_raises_when_absent(tmp_path: Path) -> None:
    write(tmp_path, "env.py", "def other(): pass\n")
    with pytest.raises(FunctionNotFound):
        find_function_source(tmp_path, "missing_reward")


def test_load_reward_fn_skips_environment_dependencies(tmp_path: Path) -> None:
    """The real motivation: environments import `verifiers`/`datasets` at
    module scope, which this must not need in order to score one function."""
    write(
        tmp_path,
        "env.py",
        f"""
import verifiers as vf
from datasets import Dataset

{GAMEABLE_REWARD}
""",
    )

    fn = load_reward_fn(tmp_path, "gameable_reward")
    assert fn.__name__ == "gameable_reward"


def test_score_completions_confirms_the_exploit_pattern(tmp_path: Path) -> None:
    write(tmp_path, "env.py", GAMEABLE_REWARD)
    fn = load_reward_fn(tmp_path, "gameable_reward")

    scores = score_completions(
        fn,
        answer="1 city, 1 road",
        completions={
            "blank": "no idea",
            "correct, natural phrasing": "you should build 1 city, 1 road",
            "wrong build, buzzword-stuffed": "after using your resources, brick and wool remain",
        },
    )

    assert scores["blank"] == 0.0
    # The task-relevant component fires when the answer literally appears...
    assert scores["correct, natural phrasing"] == pytest.approx(0.4)
    # ...but a wrong, keyword-stuffed completion collects a *larger* score
    # from the flat component alone, untethered to correctness.
    assert scores["wrong build, buzzword-stuffed"] == pytest.approx(0.6)
    assert scores["wrong build, buzzword-stuffed"] > scores["correct, natural phrasing"]


def test_score_completions_accepts_sync_reward_functions(tmp_path: Path) -> None:
    write(tmp_path, "env.py", SYNC_REWARD)
    fn = load_reward_fn(tmp_path, "sync_reward")

    scores = score_completions(fn, answer="yes", completions={"a": "yes, absolutely", "b": "no"})

    assert scores == {"a": 1.0, "b": 0.0}
