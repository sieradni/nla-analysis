"""Does the relationship between x and y change over time?

The pooled fit is a trap. In the drift-sensor fixture a single line through everything reports a
respectable slope with a narrow band, and it is wrong: the slope changes at a recalibration. A fit
that averages two regimes is not a fit, it is an average, and it hides the one thing worth knowing.

This recipe splits the series in time and asks whether two lines describe it better than one.

Two things it is careful about, because both are how this kind of analysis usually misleads:

1. **Searching for a changepoint and then testing at the point you found inflates the significance.**
   The test statistic was chosen by looking at the data, so the textbook p-value is too small. When
   the split is found automatically the p-value comes from a permutation test instead: the null is
   "the pairing of (x, y) with time carries no information", and the same search runs on every
   permutation, which reproduces the selection effect and cancels it.

2. **A changepoint is not a cause.** It says when the relationship changed, never why. The narrative
   reports where the change lands and what it is bounded by, and stops there.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any

import numpy as np
from scipy import stats

SCHEMA = {
    "name": "drift",
    "summary": "Tests whether the relationship between two fields changes over time",
    "params": [
        {"name": "x", "type": "field", "default": "x", "label": "independent field"},
        {"name": "y", "type": "field", "default": "y", "label": "dependent field"},
        {"name": "degree", "type": "int", "default": 1, "min": 1, "max": 3},
        {
            "name": "split",
            "type": "text",
            "default": "auto",
            "label": "an ISO time to split at, or auto to let the data choose",
        },
        {"name": "level", "type": "float", "default": 0.95, "min": 0.5, "max": 0.999},
        {
            "name": "permutations",
            "type": "int",
            "default": 499,
            "min": 99,
            "max": 4999,
            "label": "permutations for the auto split; ignored when a split is given",
        },
    ],
    "outputs": ["segments", "verdict", "diagnostics"],
}

PERMUTATION_SEED = 20261019
GRID_POINTS = 60
DEFAULT_LEVEL = 0.95
# An F statistic is clamped away from a division by zero rather than allowed to become infinity,
# which is not valid JSON and would break the reader.
RSS_FLOOR = 1e-12


def _describe_p(value: float) -> str:
    """A p-value is never zero, so never print one as if it were.

    Returns the whole clause, because "p = < 0.0001" is not a sentence anyone should write.
    """
    if value < 5e-5:
        return "p < 0.0001"
    return f"p = {value:.4f}".rstrip("0").rstrip(".")


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return singular if count == 1 else (plural if plural is not None else singular + "s")


def _triples(
    input_data: dict[str, Any], x_field: str, y_field: str
) -> tuple[np.ndarray, list[str], np.ndarray, np.ndarray, list[str | None], int]:
    """Points that carry a usable time and two finite numbers, sorted by time.

    The stamps come back in the same order as the numbers they belong to. Sorting the raw timestamp
    strings separately would disagree with the parsed order -- different ISO spellings of the same
    moment do not sort the same way -- and the reported split would then name the wrong point.
    """
    raw = input_data.get("points")
    if not isinstance(raw, list) or not raw:
        raise ValueError("no points were supplied")

    times: list[float] = []
    stamps: list[str] = []
    xs: list[float] = []
    ys: list[float] = []
    ids: list[str | None] = []
    skipped = 0

    for point in raw:
        values = point.get("values") if isinstance(point, dict) else None
        stamp = point.get("t") if isinstance(point, dict) else None
        if not isinstance(values, dict) or not isinstance(stamp, str):
            skipped += 1
            continue
        parsed = _parse_time(stamp)
        if parsed is None:
            skipped += 1
            continue
        x = values.get(x_field)
        y = values.get(y_field)
        if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            skipped += 1
            continue
        if not (math.isfinite(float(x)) and math.isfinite(float(y)) and math.isfinite(parsed)):
            skipped += 1
            continue
        times.append(parsed)
        stamps.append(stamp)
        xs.append(float(x))
        ys.append(float(y))
        identity = point.get("id") if isinstance(point, dict) else None
        ids.append(identity if isinstance(identity, str) and identity else None)

    if len(times) < 2:
        raise ValueError(f'fewer than two points carry a time and numeric "{x_field}" and "{y_field}"')

    order = np.argsort(np.asarray(times), kind="stable")
    ordered_times = np.asarray(times, dtype=float)[order]
    ordered_stamps = [stamps[index] for index in order]
    # The ids travel with their point through the same ordering, so a chart mark still names the
    # record it came from after the series has been sorted by time.
    ordered_ids = [ids[index] for index in order]
    return (
        ordered_times,
        ordered_stamps,
        np.asarray(xs, dtype=float)[order],
        np.asarray(ys, dtype=float)[order],
        ordered_ids,
        skipped,
    )


def _parse_time(value: str) -> float | None:
    """Seconds since the epoch, or None. Accepts the canonical form bench writes and anything else
    ISO 8601, with or without an offset, because a log may contain records from before that rule."""
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _fit(x: np.ndarray, y: np.ndarray, degree: int) -> tuple[np.ndarray, float]:
    design = np.vander(x, degree + 1, increasing=True)
    beta, *_ = np.linalg.lstsq(design, y, rcond=None)
    residuals = y - design @ beta
    return beta, float(residuals @ residuals)


def _split_rss(x: np.ndarray, y: np.ndarray, degree: int, min_segment: int) -> list[tuple[int, float]]:
    out: list[tuple[int, float]] = []
    for k in range(min_segment, x.size - min_segment + 1):
        _, left = _fit(x[:k], y[:k], degree)
        _, right = _fit(x[k:], y[k:], degree)
        out.append((k, left + right))
    return out


def _chow_f(rss_pooled: float, rss_split: float, extra_parameters: int, dof: int) -> float:
    denominator = max(rss_split, RSS_FLOOR) / dof
    return ((rss_pooled - rss_split) / extra_parameters) / denominator


def _axis(field: str, units: dict[str, str]) -> dict[str, str]:
    axis: dict[str, str] = {"label": field}
    if field in units:
        axis["unit"] = units[field]
    return axis


def run(input_data: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    x_field = str(params.get("x") or "x")
    y_field = str(params.get("y") or "y")
    degree = int(params.get("degree") or 1)
    split_param = str(params.get("split") or "auto")
    level = float(params.get("level") or DEFAULT_LEVEL)
    permutations = int(params.get("permutations") or 499)

    if not 1 <= degree <= 3:
        raise ValueError("degree must be between 1 and 3")
    if not 0.5 <= level < 1.0:
        raise ValueError("level must be at least 0.5 and below 1")
    if permutations < 99:
        raise ValueError("permutations must be at least 99 for a meaningful test")

    units: dict[str, str] = {}
    for field in input_data.get("fields") or []:
        if isinstance(field, dict) and isinstance(field.get("name"), str) and isinstance(field.get("unit"), str):
            units[field["name"]] = field["unit"]

    times, stamps, x, y, ids, skipped = _triples(input_data, x_field, y_field)
    n = int(x.size)
    parameters_per_segment = degree + 1
    extra_parameters = parameters_per_segment
    dof = n - 2 * parameters_per_segment
    min_segment = degree + 2

    x_axis = _axis(x_field, units)
    y_axis = _axis(y_field, units)
    points = [
        {"x": float(a), "y": float(b), **({} if identity is None else {"id": identity})}
        for a, b, identity in zip(x, y, ids)
    ]

    diagnostics: dict[str, Any] = {
        "n": n,
        "degree": degree,
        "dof": dof,
        "min_segment": min_segment,
        "level": level,
        "skipped": skipped,
    }

    def refuse(narrative: str, caption: str, verdict: str = "insufficient") -> dict[str, Any]:
        return {
            "caption": caption,
            "data": {"segments": [], "curve_drawn": False},
            "chart": {
                "x": x_axis,
                "y": y_axis,
                "points": points,
                "footer": f"n = {n} · segments need {2 * min_segment} points · {verdict}",
                "evidence": {
                    "points": n,
                    "noCurve": "segments",
                    "needed": 2 * min_segment,
                },
            },
            "verdict": verdict,
            "diagnostics": diagnostics,
            "narrative": narrative,
        }

    if dof < 1 or n < 2 * min_segment:
        needed = max(2 * min_segment - n, 0)
        diagnostics["more_points_needed"] = needed + max(1 - dof, 0)
        return refuse(
            f"Comparing two regimes needs at least {2 * min_segment} points "
            f"({min_segment} on each side of the split) and {n} are present. "
            f"Add {diagnostics['more_points_needed']} more before asking whether the relationship changed.",
            f"Too few points to compare two regimes: {n} present, {2 * min_segment} needed.",
        )

    _, rss_pooled = _fit(x, y, degree)
    candidates = _split_rss(x, y, degree, min_segment)
    scored = [
        (k, _chow_f(rss_pooled, rss, extra_parameters, dof), rss) for k, rss in candidates
    ]
    best_k, best_f, best_rss = max(scored, key=lambda item: item[1])

    if split_param != "auto":
        # A split the caller chose is not a choice made from the data, so the textbook test applies.
        cut = _parse_time(split_param)
        if cut is None:
            raise ValueError(f'split must be "auto" or an ISO time, got "{split_param}"')
        chosen = [k for k, _ in candidates if times[k] >= cut]
        if not chosen:
            return refuse(
                f"No split at {split_param} leaves at least {min_segment} points on both sides; "
                f"the test would be unidentifiable. No curve drawn.",
                f"That split leaves fewer than {min_segment} points on one side; no test is possible.",
            )
        k = chosen[0]
        rss_split = next(rss for candidate_k, _, rss in scored if candidate_k == k)
        f_statistic = _chow_f(rss_pooled, rss_split, extra_parameters, dof)
        p_value = float(stats.f.sf(f_statistic, extra_parameters, dof))
        method = "chow"
        split_source = "given"
        best_k, best_f, best_rss = k, f_statistic, rss_split
    else:
        # Selecting the split by looking at the data means the raw p-value is optimistic. The
        # permutation test re-runs the same search under the null, which pays that cost back.
        rng = np.random.default_rng(PERMUTATION_SEED)
        at_least = 0
        for _ in range(permutations):
            order = rng.permutation(n)
            shuffled_x, shuffled_y = x[order], y[order]
            extreme = 0.0
            for k, rss in _split_rss(shuffled_x, shuffled_y, degree, min_segment):
                extreme = max(extreme, _chow_f(rss_pooled, rss, extra_parameters, dof))
            if extreme >= best_f:
                at_least += 1
        p_value = (at_least + 1) / (permutations + 1)
        method = "permutation"
        split_source = "auto"

    diagnostics.update(
        {
            "rss_pooled": rss_pooled,
            "rss_split": best_rss,
            "f": best_f,
            "p": p_value,
            "test": method,
            "split_source": split_source,
            "split_index": int(best_k),
            "permutations": permutations if method == "permutation" else 0,
            "permutation_seed": PERMUTATION_SEED if method == "permutation" else None,
        }
    )

    def segment(slice_start: int, slice_end: int) -> dict[str, Any]:
        segment_x, segment_y = x[slice_start:slice_end], y[slice_start:slice_end]
        beta, rss = _fit(segment_x, segment_y, degree)
        segment_dof = int(segment_x.size) - parameters_per_segment
        segment_variance = rss / segment_dof if segment_dof > 0 else 0.0
        covariance = segment_variance * np.linalg.inv(
            np.vander(segment_x, parameters_per_segment, increasing=True).T
            @ np.vander(segment_x, parameters_per_segment, increasing=True)
        )
        stderr = np.sqrt(np.clip(np.diag(covariance), 0.0, None))
        critical = float(stats.t.ppf(1 - (1 - level) / 2, max(segment_dof, 1)))
        return {
            "beta": beta,
            "dof": segment_dof,
            "count": int(segment_x.size),
            "x_min": float(segment_x.min()),
            "x_max": float(segment_x.max()),
            "slope": float(beta[1]) if parameters_per_segment > 1 else None,
            "slope_low": float(beta[1] - critical * stderr[1]) if parameters_per_segment > 1 else None,
            "slope_high": float(beta[1] + critical * stderr[1]) if parameters_per_segment > 1 else None,
        }

    before = segment(0, int(best_k))
    after = segment(int(best_k), n)
    # The split sits between two observations; name it by the last one before the boundary.
    split_time = stamps[int(best_k) - 1][:10]

    percent = int(round(level * 100))
    if p_value >= 0.05:
        verdict = "contradicted"
    elif p_value < 0.01:
        verdict = "supported"
    else:
        verdict = "tentative"

    slope_before = before["slope"]
    slope_after = after["slope"]
    interval_before = f"[{before['slope_low']:.4g}, {before['slope_high']:.4g}]"
    interval_after = f"[{after['slope_low']:.4g}, {after['slope_high']:.4g}]"

    sentences: list[str] = []
    if verdict == "contradicted":
        sentences.append(
            f"No evidence that the relationship changes with time: the best split "
            f"({split_time}) gives F = {best_f:.2f}, {_describe_p(p_value)}"
            + (f" over {permutations} permutations" if method == "permutation" else "")
            + ". One slope describes the whole series."
        )
    else:
        sentences.append(
            f"The slope is {slope_before:.4g} {interval_before} before {split_time} and "
            f"{slope_after:.4g} {interval_after} after it ({percent}% intervals, "
            f"{before['count']} and {after['count']} points)."
        )
        sentences.append(
            f"A single slope through both regimes is rejected at {_describe_p(p_value)}"
            + (
                f", by permutation over {permutations} reshuffles because the split was chosen from "
                f"the data"
                if method == "permutation"
                else " by a Chow test at the split you specified"
            )
            + f" (F = {best_f:.2f})."
        )
    if skipped:
        skipped_text = f"{skipped} {_plural(skipped, 'point')}"
        sentences.append(f"{skipped_text} {_plural(skipped, 'was', 'were')} skipped for missing or non-finite values.")
    sentences.append("A changepoint says when the relationship changed, not why.")

    chart_series: list[dict[str, Any]] = []
    if verdict != "contradicted":
        for index, (part, label) in enumerate(
            ((before, f"before {split_time}"), (after, f"after {split_time}"))
        ):
            grid = np.linspace(part["x_min"], part["x_max"], GRID_POINTS)
            curve = np.vander(grid, parameters_per_segment, increasing=True) @ part["beta"]
            chart_series.append(
                {
                    "points": [{"x": float(g), "y": float(c)} for g, c in zip(grid, curve)],
                    "label": label,
                    "muted": index == 1,
                }
            )

    chart: dict[str, Any] = {
        "x": x_axis,
        "y": y_axis,
        "points": points,
        "footer": f"n = {n} · 2 regimes of {parameters_per_segment} parameters · DOF {dof} · {verdict}",
        "evidence": {
            "points": n,
            "regimes": 2,
            "parameters": parameters_per_segment,
            "dof": dof,
        },
    }
    if chart_series:
        chart["lines"] = chart_series
    else:
        grid = np.linspace(float(x.min()), float(x.max()), GRID_POINTS)
        beta, _ = _fit(x, y, degree)
        curve = np.vander(grid, parameters_per_segment, increasing=True) @ beta
        chart["lines"] = [
            {"points": [{"x": float(g), "y": float(c)} for g, c in zip(grid, curve)], "label": "one slope"}
        ]

    if verdict == "contradicted":
        caption = (
            "No evidence of a change over time: one slope describes the whole series "
            f"({_describe_p(p_value)})."
        )
    else:
        caption = (
            f"Slope {slope_before:.4g} [{before['slope_low']:.4g}, {before['slope_high']:.4g}] before "
            f"{split_time}, {slope_after:.4g} [{after['slope_low']:.4g}, {after['slope_high']:.4g}] after; "
            f"one slope rejected at {_describe_p(p_value)}."
        )

    return {
        "caption": caption,
        "data": {
            "segments": [
                {
                    "label": f"before {split_time}",
                    "count": before["count"],
                    "slope": slope_before,
                    "slope_low": before["slope_low"],
                    "slope_high": before["slope_high"],
                },
                {
                    "label": f"after {split_time}",
                    "count": after["count"],
                    "slope": slope_after,
                    "slope_low": after["slope_low"],
                    "slope_high": after["slope_high"],
                },
            ],
            "split_time": split_time,
            "curve_drawn": True,
        },
        "chart": chart,
        "verdict": verdict,
        "diagnostics": diagnostics,
        "narrative": " ".join(sentences),
    }

