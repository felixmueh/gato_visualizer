"""Source settings for the experimental visualizer extension.

CPU-only descriptors and native builders. The simulator keeps state, timing,
integration and its own friction enable/law choice; the predictor role owns
its separate armature/friction model. Joint coefficients stay in code; the
controls select enablement, law and widths. PD gains stay in the tuned code
preset. Nothing compiles a solver.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from typing import Any

import tiago_mpc as tm
from experiments.controller_tuning import TUNED_FEEDFORWARD


def describe() -> dict[str, Any]:
    """Fixed finite JSON metadata; law choices change visibility, never field shape."""
    if not isinstance(TUNED_FEEDFORWARD.evaluation, tm.Tanh):
        raise ValueError("The tuned feedforward preset must use a Tanh law")
    return {
        "simulation": {
            "controls": ["armature", "friction.coulomb_nm", "friction.viscous_nm_s_per_rad", "law"],
            "defaults": dict(
                armature_on=True,
                law="default",
                ff_width_rad_s=TUNED_FEEDFORWARD.evaluation.width_rad_s,
            ),
            "parameters": [
                dict(path="armature_on", label="Plant armature", kind="bool", group="Plant dynamics",
                     effect="runtime",
                     description="Use the supplied reflected inertia fixed in code; off returns zeros."),
                dict(path="law", label="Execution law", kind="choice", group="Execution controller", effect="runtime",
                     choices=[dict(value="default", label="Default (plan torque)"),
                              dict(value="pd", label="PD feedback"),
                              dict(value="ff", label="Friction feedforward"),
                              dict(value="both", label="Feedforward + PD")]),
                dict(path="ff_width_rad_s", label="FF tanh width", kind="float", min=0., min_exclusive=True,
                     unit="rad/s", group="Execution controller", effect="runtime", visible_if={"law": ["ff", "both"]},
                     description="Uses the retained proximal friction prior and nominal wrists fixed in code."),
            ],
        },
        "predictor": {
            "controls": ["armature", "friction", "friction_law"],
            "defaults": dict(
                armature_on=True, friction_on=False,
                friction_width_rad_s=.2,
            ),
            "parameters": [
                dict(path="armature_on", label="Predictor armature", kind="bool", group="Predictor dynamics",
                     effect="compiled_model",
                     description="Use the supplied reflected inertia fixed in code; off returns zeros."),
                dict(path="friction_on", label="Predictor friction", kind="bool", group="Predictor dynamics",
                     effect="compiled_model", description="Use the nominal URDF joint coefficients fixed in code."),
                dict(path="friction_width_rad_s", label="Predictor tanh width", kind="float", min=0.,
                     min_exclusive=True,
                     unit="rad/s", group="Predictor dynamics", effect="compiled_model", enabled_if={"friction_on": True},
                     description="Used exactly as displayed when enabled; model changes require an explicit Build."),
            ],
        },
    }


def _flag(values: Mapping[str, Any], key: str) -> bool:
    flag = values[key]
    if not isinstance(flag, bool):
        raise ValueError(f"{key} must be a boolean")
    return flag


def build_simulation(values: Mapping[str, Any], base: tm.SimConfig) -> tuple[tm.SimConfig, tm.ControlLaw]:
    """Preserve every base field except armature and enabled-friction coefficients."""
    armature = tm.ARMATURE_KG_M2 if _flag(values, "armature_on") else (0.,) * 7
    prior = TUNED_FEEDFORWARD.friction
    # Construct inactive choices too, so hiding a field never bypasses its validation.
    evaluation = tm.Tanh(values["ff_width_rad_s"])
    mode = values["law"]
    if mode not in ("default", "pd", "ff", "both"):
        raise ValueError(f"Unknown execution law: {mode!r}")
    law: tm.ControlLaw = tm.PlanFeedback() if mode in ("pd", "both") else tm.SampleKnot()
    if mode in ("ff", "both"):
        law = tm.FrictionFeedforward(prior, law, evaluation=evaluation)
    plant = replace(base, armature=armature, friction=None if base.friction is None else prior)
    return plant, law


def build_predictor(values: Mapping[str, Any], base: tm.MpcParams) -> tm.MpcParams:
    """Resolve the separate predictor model; preserve costs, bounds, N and knot interval.

    Changes to these model values may need a different compiled binary. The
    visualizer's explicit Build action owns compilation, not this function.
    """
    armature = tm.ARMATURE_KG_M2 if _flag(values, "armature_on") else (0.,) * 7
    evaluation = tm.Tanh(values["friction_width_rad_s"])
    return replace(base, armature=armature, friction=tm.urdf_friction() if _flag(values, "friction_on") else None,
                   friction_law=evaluation)
