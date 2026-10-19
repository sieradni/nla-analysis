"""Recipe runner: newline-delimited JSON in, newline-delimited JSON out.

The TypeScript side owns the user interface and the event log; this process only computes. The
contract is deliberately narrow:

    {"kind": "ping"}                      -> {"ok": true, "data": {"python": "3.13.0", "numpy": "..."}}
    {"kind": "catalog"}                   -> {"ok": true, "data": [<recipe schema>, ...]}
    {"kind": "run", "id", "recipe", "params", "input"}
                                          -> {"ok": true, "data", "chart", "verdict", "diagnostics",
                                                                   "narrative"}
                                          -> {"ok": false, "error": {"code", "message", "hint"}}

Rules that keep this process safe to embed:

* stdout carries nothing but response objects -- one per line, flushed. Anything a recipe prints to
  stdout is captured and returned as a warning instead of corrupting the stream.
* A recipe that raises is reported as an error envelope. The runner never dies on bad input, because
  a crashed runner would take the charts down with it.
* No network, no file writes. Recipes are pure functions of (input, params).
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import sys
import traceback
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
SKIP = {"runner.py"}

# The protocol is newline-delimited. On Windows, text-mode stdout would turn every \n into \r\n and
# put carriage returns into the stream, so pin it to LF.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(newline="\n")


def emit(payload: dict[str, Any], request_id: Any = None) -> None:
    """Write one response. The request id is echoed back or the caller cannot match the answer to
    its question -- without it, every request looks like it timed out."""
    if isinstance(request_id, str):
        payload = {**payload, "id": request_id}
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def failure(code: str, message: str, hint: str | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if hint:
        error["hint"] = hint
    return {"ok": False, "error": error}


def load_recipes() -> dict[str, tuple[dict[str, Any], Callable[..., Any]]]:
    """Discover recipe modules: any sibling .py exposing both SCHEMA and run()."""
    found: dict[str, tuple[dict[str, Any], Callable[..., Any]]] = {}
    for path in sorted(HERE.glob("*.py")):
        if path.name in SKIP or path.name.startswith("_"):
            continue
        spec = importlib.util.spec_from_file_location(f"bench_recipe_{path.stem}", path)
        if spec is None or spec.loader is None:
            continue
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        schema = getattr(module, "SCHEMA", None)
        run = getattr(module, "run", None)
        if not isinstance(schema, dict) or not callable(run):
            continue
        described = dict(schema)
        # Line endings are not part of a recipe's identity: Python runs a CRLF file exactly as it
        # runs an LF one, and a checkout can legitimately hold either. Normalise before hashing so
        # a run recorded on one machine does not read as stale on another.
        described["hash"] = hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
        described["source"] = path.name
        found[described["name"]] = (described, run)
    return found


def environment() -> dict[str, str]:
    info = {"python": sys.version.split()[0]}
    for module in ("numpy", "scipy"):
        try:
            info[module] = __import__(module).__version__
        except Exception:  # pragma: no cover - reported, not fatal
            info[module] = "missing"
    return info


def handle_run(
    recipes: dict[str, tuple[dict[str, Any], Callable[..., Any]]],
    request: dict[str, Any],
) -> dict[str, Any]:
    name = request.get("recipe")
    if not isinstance(name, str):
        return failure("bad_request", "run requires a recipe name")

    entry = recipes.get(name)
    if entry is None:
        known = ", ".join(sorted(recipes)) or "none"
        return failure("unknown_recipe", f'no recipe named "{name}"', f"available: {known}")

    schema, run = entry
    params = request.get("params") or {}
    if not isinstance(params, dict):
        return failure("bad_request", "params must be an object")

    captured = io.StringIO()
    try:
        with redirect_stdout(captured):
            result = run(request.get("input") or {}, params)
    except Exception as error:
        return failure(
            "recipe_failed",
            f"{type(error).__name__}: {error}",
            "the recipe raised; the log is unaffected",
        )

    if not isinstance(result, dict):
        return failure("recipe_failed", f"recipe {name} returned {type(result).__name__}, not an object")

    envelope: dict[str, Any] = {"ok": True}
    envelope.update(result)
    envelope["recipe"] = name
    envelope["recipe_hash"] = schema["hash"]

    noise = captured.getvalue().strip()
    if noise:
        warnings = list(envelope.get("warnings") or [])
        warnings.append(f"recipe wrote to stdout: {noise[:400]}")
        envelope["warnings"] = warnings

    return envelope


def main() -> int:
    recipes = load_recipes()
    broken: dict[str, str] = {}
    for path in sorted(HERE.glob("*.py")):
        if path.name in SKIP or path.name.startswith("_"):
            continue
        if not any(schema.get("source") == path.name for schema, _ in recipes.values()):
            broken[path.name] = "no SCHEMA + run() pair"

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit(failure("bad_request", f"not valid JSON: {error.msg}"))
            continue
        if not isinstance(request, dict):
            emit(failure("bad_request", "each request must be a JSON object"))
            continue

        request_id = request.get("id")
        kind = request.get("kind", "run")
        try:
            if kind == "ping":
                emit({"ok": True, "data": environment()}, request_id)
            elif kind == "catalog":
                emit(
                    {
                        "ok": True,
                        "data": [schema for schema, _ in recipes.values()],
                        "warnings": [
                            f"{name}: {reason} (ignored)" for name, reason in sorted(broken.items())
                        ],
                    },
                    request_id,
                )
            elif kind == "run":
                emit(handle_run(recipes, request), request_id)
            else:
                emit(failure("bad_request", f'unknown request kind "{kind}"'), request_id)
        except Exception as error:  # last line of defence: never die mid-stream
            emit(
                failure("runner_error", f"{type(error).__name__}: {error}", traceback.format_exc()[-500:]),
                request_id,
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
