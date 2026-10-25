"""flakefinder pytest fixture.

The same four deterministic shapes as the jest/go fixtures:
stable x2, always-fail, flaky-counter (file-driven parity), slow-pass.
"""

import time
from pathlib import Path

COUNTER_FILE = Path(__file__).resolve().parent / "counter.txt"


def _bump_counter() -> int:
    """Deterministic flake protocol: fail on odd counts.

    run 1 -> counter 1 (odd)  -> FAIL
    run 2 -> counter 2 (even) -> PASS
    run 3 -> counter 3 (odd)  -> FAIL  ... and so on
    """
    try:
        n = int(COUNTER_FILE.read_text(encoding="utf-8").strip() or "0")
    except (OSError, ValueError):
        n = 0  # missing file -> 0
    n += 1
    COUNTER_FILE.write_text(str(n), encoding="utf-8")
    return n


def test_stable_one():
    assert 1 + 1 == 2


def test_stable_two():
    assert "flake".upper() == "FLAKE"


def test_always_fail():
    assert False, "deterministic failure (fixture)"


def test_flaky_counter():
    n = _bump_counter()
    assert n % 2 == 0, f"flaky_counter saw odd count {n}"


def test_slow_pass():
    time.sleep(0.12)
    assert True
