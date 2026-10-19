"""Least-squares polynomial fit of y against x, with an interval band and an explicit verdict.

This recipe exists to enforce one rule: when the model has as many free parameters as there are data
points, *every* member of the family fits exactly, so the curve carries no information. That case is
reported as `insufficient` and **no curve is drawn**. A parabola through three points is not a
finding, and an interface that draws one anyway is lying to whoever is reading it.

The same rule applies to a straight line through two points, which is the most common way this kind
of tool misleads someone on their first afternoon of use.

Outputs, in the envelope shape the CLI and the app both render:

    data         coefficient table, fitted series, and how the band should be read
    chart        points, line and band -- line and band absent when no curve is justified
    verdict      insufficient | tentative | supported | contradicted
    diagnostics  n, parameters, DOF, F statistic, p value, anything skipped
    narrative    one or two plain sentences, written for a human

Every number that leaves here is finite or null. A non-finite value would serialise as `Infinity`,
which is not valid JSON and would break the reader on the other side.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import stats

SCHEMA = {
    "name": "fit",
    "summary": "Least-squares polynomial fit of y against x, with an interval band and a verdict",
    "params": [
        {"name": "x", "type": "field", "default": "x", "label": "independent field"},
        {"name": "y", "type": "field", "default": "y", "label": "dependent field"},
        {"name": "degree", "type": "int", "default": 1, "min": 1, "max": 5},
        {"name": "level", "type": "float", "default": 0.95, "min": 0.5, "max": 0.999},
        {
            "name": "band",
            "type": "enum",
            "default": "confidence",
            "values": ["confidence", "prediction"],
            "label": "confidence band on the fit, or prediction band for a new point",
        },
    ],
    "outputs": ["coefficients", "band", "verdict", "diagnostics"],
}

GRID_POINTS = 120
DEFAULT_LEVEL = 0.95


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return singular if count == 1 else (plural if plural is not None else singular + "s")


def _ordinal(value: int) -> str:
    if 10 <= value % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(value % 10, "th")
    return f"{value}{suffix}"


def _series(input_data: dict[str, Any], x_field: str, y_field: str) -> tuple[np.ndarray, np.ndarray, int]:
    """Pull the two numeric columns, skipping anything that is not a finite number."""
    raw = input_data.get("points")
    if not isinstance(raw, list) or not raw:
        raise ValueError("no points were supplied")

    xs: list[float] = []
    ys: list[float] = []
    skipped = 0
    for point in raw:
        values = point.get("values") if isinstance(point, dict) else None
        if not isinstance(values, dict):
            skipped += 1
            continue
        x = values.get(x_field)
        y = values.get(y_field)
        if isinstance(x, bool) or isinstance(y, bool):
            skipped += 1
            continue
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            skipped += 1
            continue
        if not (math.isfinite(float(x)) and math.isfinite(float(y))):
            skipped += 1
            continue
        xs.append(float(x))
        ys.append(float(y))

    if not xs:
        raise ValueError(f'no points carry numeric "{x_field}" and "{y_field}"')
    return np.asarray(xs, dtype=float), np.asarray(ys, dtype=float), skipped


def _metadata(input_data: dict[str, Any], x_field: str, y_field: str) -> tuple[dict[str, str], str, str]:
    units: dict[str, str] = {}
    fields = input_data.get("fields")
    if isinstance(fields, list):
        for field in fields:
            if isinstance(field, dict) and isinstance(field.get("name"), str):
                unit = field.get("unit")
                if isinstance(unit, str):
                    units[field["name"]] = unit

    labels = input_data.get("labels") if isinstance(input_data.get("labels"), dict) else {}
    return units, str(labels.get(x_field, x_field)), str(labels.get(y_field, y_field))


def _axis(field: str, label: str, units: dict[str, str]) -> dict[str, str]:
    axis = {"label": label}
    if field in units:
        axis["unit"] = units[field]
    return axis


def _describe_p(value: float) -> str:
    """A p-value is never zero, so never print one as if it were.

    Returns the whole clause, because "p = < 0.0001" is not a sentence anyone should write.
    """
    if value < 5e-5:
        return "p < 0.0001"
    return f"p = {value:.4f}".rstrip("0").rstrip(".")


def _names(degree: int) -> list[str]:
    return ["intercept"] + [f"x^{power}" if power > 1 else "x" for power in range(1, degree + 1)]


def _points(x: np.ndarray, y: np.ndarray) -> list[dict[str, float]]:
    return [{"x": float(a), "y": float(b)} for a, b in zip(x, y)]


def _refusal(
    *,
    narrative: str,
    caption: str,
    x: np.ndarray,
    y: np.ndarray,
    x_axis: dict[str, str],
    y_axis: dict[str, str],
    diagnostics: dict[str, Any],
) -> dict[str, Any]:
    """The honest non-answer: points and an explanation, deliberately with no curve."""
    return {
        "caption": caption,
        "data": {"series": {"x": x.tolist(), "y": y.tolist()}, "coefficients": [], "curve_drawn": False},
        "chart": {
            "x": x_axis,
            "y": y_axis,
            "points": _points(x, y),
            "footer": (
                f"n = {diagnostics['n']} · {diagnostics['parameters']} parameters · "
                f"DOF {diagnostics['dof']} · insufficient · no curve drawn"
            ),
        },
        "verdict": "insufficient",
        "diagnostics": diagnostics,
        "narrative": narrative,
    }


def run(input_data: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    x_field = str(params.get("x") or "x")
    y_field = str(params.get("y") or "y")
    degree = int(params.get("degree") or 1)
    level = float(params.get("level") or DEFAULT_LEVEL)
    band_kind = str(params.get("band") or "confidence")

    if not 1 <= degree <= 5:
        raise ValueError("degree must be between 1 and 5")
    if not 0.5 <= level < 1.0:
        raise ValueError("level must be at least 0.5 and below 1")

    x, y, skipped = _series(input_data, x_field, y_field)
    n = int(x.size)
    parameters = degree + 1
    dof = n - parameters
    units, x_label, y_label = _metadata(input_data, x_field, y_field)
    x_axis = _axis(x_field, x_label, units)
    y_axis = _axis(y_field, y_label, units)

    diagnostics: dict[str, Any] = {
        "n": n,
        "parameters": parameters,
        "dof": dof,
        "degree": degree,
        "level": level,
        "band": band_kind,
        "skipped": skipped,
        "x_field": x_field,
        "y_field": y_field,
    }

    # --- Underdetermined: more unknowns than observations. -------------------------------
    if dof < 0:
        needed = parameters - n
        diagnostics["more_points_needed"] = needed
        return _refusal(
            narrative=(
                f"{n} {_plural(n, 'point')} cannot determine {parameters} parameters. "
                f"Add {needed} more {_plural(needed, 'point')} before a curve means anything, or lower "
                f"the degree to {max(0, n - 1)}."
            ),
            caption=(
                f"{n} {_plural(n, 'point')} cannot determine {parameters} parameters. "
                f"Add {needed} more {_plural(needed, 'point')}, or lower the degree to {max(0, n - 1)}."
            ),
            x=x, y=y, x_axis=x_axis, y_axis=y_axis, diagnostics=diagnostics,
        )

    design = np.vander(x, parameters, increasing=True)
    beta, *_ = np.linalg.lstsq(design, y, rcond=None)
    fitted = design @ beta
    residuals = y - fitted
    rss = float(residuals @ residuals)
    tss = float(((y - y.mean()) ** 2).sum())

    # --- Exact by construction: as many parameters as points. ----------------------------
    if dof == 0:
        return _refusal(
            narrative=(
                f"{n} {_plural(n, 'point')}, {parameters} parameters, zero degrees of freedom: this fit "
                f"is exact by construction, so it says nothing about the relationship. Add a "
                f"{_ordinal(n + 1)} point to constrain it, or lower the degree to {max(0, n - 2)}."
            ),
            caption=(
                f"Exact by construction: {n} points and {parameters} parameters. Add a "
                f"{_ordinal(n + 1)} point, or lower the degree to {max(0, n - 2)}."
            ),
            x=x, y=y, x_axis=x_axis, y_axis=y_axis, diagnostics=diagnostics,
        )

    # --- Identifiable: quantify, then judge. --------------------------------------------
    variance = rss / dof
    covariance = variance * np.linalg.inv(design.T @ design)
    stderr = np.sqrt(np.clip(np.diag(covariance), 0.0, None))
    t_critical = float(stats.t.ppf(1 - (1 - level) / 2, dof))

    constant_y = tss <= 0.0
    # Judged relative to the spread of y, not against absolute zero: a relationship computed in
    # floating point leaves a residue around 1e-28, which is an exact fit for every practical purpose
    # and deserves the same warning as an exact one.
    perfect_fit = rss <= max(tss, 1e-300) * 1e-10

    # A non-finite F would serialise as `Infinity`, which is not valid JSON.
    f_statistic: float | None
    if constant_y:
        f_statistic, p_value = 0.0, 1.0
    elif perfect_fit:
        f_statistic, p_value = None, 0.0
    else:
        f_statistic = ((tss - rss) / degree) / (rss / dof)
        p_value = float(stats.f.sf(f_statistic, degree, dof))

    diagnostics.update(
        {
            "rss": rss,
            "tss": tss,
            "f": f_statistic,
            "p": p_value,
            "r_squared": None if tss <= 0 else 1 - (rss / tss),
            "adjusted_r_squared": None if tss <= 0 else 1 - (1 - (rss / tss)) * (n - 1) / dof,
            "constant_y": constant_y,
            "perfect_fit": perfect_fit,
        }
    )

    coefficients = [
        {
            "name": _names(degree)[index],
            "estimate": float(beta[index]),
            "stderr": float(stderr[index]),
            "low": float(beta[index] - t_critical * stderr[index]),
            "high": float(beta[index] + t_critical * stderr[index]),
        }
        for index in range(parameters)
    ]

    # A higher-degree term whose interval spans zero has not earned its place.
    unjustified: dict[str, Any] | None = None
    if degree >= 2:
        leading = coefficients[degree]
        if leading["low"] <= 0.0 <= leading["high"]:
            unjustified = leading

    if p_value >= 0.05:
        verdict = "contradicted"
    elif p_value < 0.01 and unjustified is None:
        verdict = "supported"
    else:
        verdict = "tentative"

    grid = np.linspace(float(x.min()), float(x.max()), GRID_POINTS)
    grid_design = np.vander(grid, parameters, increasing=True)
    mean = grid_design @ beta
    se_mean = np.sqrt(np.clip(np.einsum("ij,jk,ik->i", grid_design, covariance, grid_design), 0.0, None))

    percent = int(round(level * 100))
    if band_kind == "prediction":
        half_width = t_critical * np.sqrt(se_mean**2 + variance)
        band_label = f"{percent}% prediction band for one new observation"
    else:
        half_width = t_critical * se_mean
        band_label = f"{percent}% confidence band on the fitted curve"

    f_text = "F = n/a" if f_statistic is None else f"F = {f_statistic:.2f}"

    sentences: list[str] = []
    if constant_y:
        sentences.append(
            f"Every one of the {n} y values is {float(y[0]):.6g}, so there is no variation for a curve "
            f"to explain; the fit collapses to the mean."
        )
    elif verdict == "contradicted":
        sentences.append(
            f"A mean-only model is not beaten ({f_text}, {_describe_p(p_value)}), so these {n} points do not "
            f"yet support a trend of this shape."
        )
    else:
        sentences.append(
            f"{n} points, {parameters} parameters, {dof} degrees of freedom; the fit beats a mean-only "
            f"model ({f_text}, {_describe_p(p_value)})."
        )
        shown = coefficients[1] if degree == 1 else coefficients[degree]
        sentences.append(
            f"{shown['name']} = {shown['estimate']:.4g} [{shown['low']:.4g}, {shown['high']:.4g}] at "
            f"{percent}%. {band_label} shown."
        )

    if perfect_fit:
        sentences.append(
            "The residuals are zero to numerical precision, which usually means y was derived from x "
            "rather than measured against it; check the provenance before trusting it."
        )
    if unjustified is not None:
        sentences.append(
            f"The {unjustified['name']} term's interval spans zero ({unjustified['low']:.3g} to "
            f"{unjustified['high']:.3g}), so the extra curvature is not justified by this data."
        )
    if skipped:
        skipped_text = f"{skipped} {_plural(skipped, 'point')}"
        sentences.append(f"{skipped_text} {_plural(skipped, 'was', 'were')} skipped for missing or non-finite values.")

    if constant_y:
        caption = "Every y value is identical; there is no variation for a curve to explain."
    elif verdict == "contradicted":
        caption = "A mean-only model is not beaten, so these points do not support a trend of this shape."
    else:
        leading = coefficients[1] if degree == 1 else coefficients[degree]
        caption = (
            f"{leading['name']} = {leading['estimate']:.4g} "
            f"[{leading['low']:.4g}, {leading['high']:.4g}] at {percent}%."
        )

    return {
        "caption": caption,
        "data": {
            "series": {"x": x.tolist(), "y": y.tolist(), "fitted": fitted.tolist()},
            "coefficients": coefficients,
            "band_label": band_label,
            "curve_drawn": True,
            "residuals": residuals.tolist(),
        },
        "chart": {
            "x": x_axis,
            "y": y_axis,
            "points": _points(x, y),
            "line": [{"x": float(a), "y": float(b)} for a, b in zip(grid, mean)],
            "band": [
                {"x": float(a), "y0": float(b - c), "y1": float(b + c)}
                for a, b, c in zip(grid, mean, half_width)
            ],
            "footer": f"n = {n} · {parameters} parameters · DOF {dof} · {verdict}",
        },
        "verdict": verdict,
        "diagnostics": diagnostics,
        "narrative": " ".join(sentences),
    }
