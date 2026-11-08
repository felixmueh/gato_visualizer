"""Source settings for the obstacle-avoidance demo: GATO's collision rows
(tiago_mpc's MpcParams.collision, tiago_mpc/collision.py) and the execution law of
tiago_mpc's experiments.

CPU-only descriptors and native builders: nothing here compiles or loads a solver. The
covers are tiago_mpc's stored ones (tiago_mpc/data/collision/), chosen by name. The arm's
sphere cover is compiled into the GATO module, so turning the rows on or off, or choosing
another arm cover, selects a compiled variant (MpcParams.collision None is the module
without rows). The environment (the body's cover and the obstacles), the mechanism and
the margin are runtime values of one module. The body posture and rho stay the native
defaults of Collision.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from typing import Any

import tiago_mpc as tm
from tiago_mpc.collision import DATA, Collision, arm_cover, body_cover

# Obstacles in metres in tiago_mpc's ROOT_FRAME (torso_lift_link), in Collision's layouts:
# spheres, and where the source has them capsules, boxes and planes. Bounds of the editable
# values, not of what GATO accepts.
OBSTACLE_BOUND_M = 2.
SIZE_M = (.005, .5)  # radius or half-extent
DEFAULT_RADIUS_M = .05  # the 5 cm spheres of experiments/obstacles.py
MAX_OBSTACLES = 16
SHAPES = (("obstacles", "sphere", "Spheres", "x, y, z and radius"),
          ("capsules", "capsule", "Capsules", "segment ends a and b and radius"),
          ("boxes", "box", "Boxes", "centre c, orientation as a quaternion q (x, y, z, w) and half-extents h "
                                    "along the box's axes"),
          ("planes", "plane", "Planes", "unit normal n and offset d; the arm stays on the side n.p >= d"))
EDITING = ("In the viewport, click one to select it: drag its arrows to move it; S scales with the pointer "
           "(Shift: finer, click or Enter applies, Esc cancels), R rotates boxes and planes; a capsule's end "
           "and a box's face handles move them alone; Delete removes, Ctrl+C and Ctrl+V copy and paste at the "
           "pointer, Esc deselects")
LAWS = {"default": tm.SampleKnot, "pd": tm.PlanFeedback}


def cover_choices(kind: str) -> list[dict[str, Any]]:
    """The stored covers of kind, labelled with their primitive counts; the body's with Off."""
    choices = []
    for name in sorted(path.stem for path in (DATA / kind).glob("*.json")):
        if kind == "arm":
            label = f"{name} ({sum(map(len, arm_cover(name).values()))} spheres)"
        else:
            counts = {key: len(values) for key, values in body_cover(name).items()}
            label = f"{name} ({sum(counts.values())}: " + ", ".join(f"{n} {key}" for key, n in counts.items()) + ")"
        choices.append(dict(value=name, label=label))
    return choices + ([dict(value=None, label="Off (obstacles only)")] if kind == "body" else [])


def describe() -> dict[str, Any]:
    """Fixed finite JSON metadata; the rows' runtime values are enabled only with the rows."""
    native = Collision()
    rows = {"enabled": True}
    shapes = [shape for shape in SHAPES if shape[0] in Collision.__dataclass_fields__]
    return {
        "simulation": {
            "controls": ["law"],
            "defaults": dict(law="pd"),
            "parameters": [
                dict(path="law", label="Execution law", kind="choice", group="Execution controller", effect="runtime",
                     choices=[dict(value="default", label="Default (plan torque)"),
                              dict(value="pd", label="PD feedback")],
                     description="PD feedback: the plan torque plus the stored gains (tiago.PD_KP, PD_KD) on the "
                                 "plan's state (PlanFeedback), as in tiago_mpc's experiments"),
            ],
        },
        "predictor": {
            "controls": ["collision"],
            "defaults": dict(enabled=True, mechanism=native.mechanism, arm=native.arm, body=native.body,
                             margin_m=native.margin_m,
                             **{path: [list(item) for item in getattr(native, path)] for path, *_ in shapes}),
            "parameters": [
                dict(path="enabled", label="Collision rows", kind="bool", group="Collision rows",
                     effect="compiled_model",
                     description="GATO's collision rows keep the arm's sphere cover, compiled into the module, the "
                                 "margin away from the environment. Off: no rows (MpcParams.collision None), "
                                 "the module without them"),
                dict(path="mechanism", label="Rows", kind="choice", group="Collision rows", effect="runtime",
                     choices=[dict(value="admm", label="Enforced (ADMM)"),
                              dict(value="telemetry", label="Reported only")],
                     enabled_if=rows,
                     description="Enforced: ADMM keeps the rows. Reported only: the same module and environment, "
                                 "the rows only report their violation"),
                dict(path="arm", label="Arm cover", kind="choice", group="Collision rows", effect="compiled_model",
                     choices=cover_choices("arm"), enabled_if=rows,
                     description="The arm's stored sphere cover (tiago_mpc/data/collision/arm/), compiled into the "
                                 "module: another cover is another module"),
                dict(path="body", label="Body cover", kind="choice", group="Collision rows", effect="runtime",
                     choices=cover_choices("body"), enabled_if=rows,
                     description="The environment includes the stored cover of the robot's body at its fixed posture "
                                 "(torso, head, left arm, base; spheres, capsules and boxes, "
                                 "tiago_mpc/data/collision/body/); Off: the obstacles only"),
                dict(path="margin_m", label="Margin", unit="m", kind="float", group="Collision rows",
                     effect="runtime", min=0., max=.2, enabled_if=rows,
                     description="Clearance the rows keep on top of the covers' bulge (Collision.margin_m)"),
            ] + [dict(path=path, label=label, unit="m", kind="shapes", shape=shape, group="Collision rows",
                      effect="runtime", bound=OBSTACLE_BOUND_M, min_size=SIZE_M[0], max_size=SIZE_M[1],
                      default_size=DEFAULT_RADIUS_M, max_count=MAX_OBSTACLES, frame="torso_lift_link",
                      description=f"{label} in torso_lift_link: {layout}. {EDITING}")
                 for path, shape, label, layout in shapes],
        },
    }


def build_simulation(values: Mapping[str, Any], base: tm.SimConfig) -> tuple[tm.SimConfig, tm.ControlLaw]:
    """The plant unchanged; the law with its native defaults (PlanFeedback's stored gains)."""
    law = values["law"]
    if law not in LAWS:
        raise ValueError(f"Unknown execution law: {law!r}")
    return base, LAWS[law]()


def build_predictor(values: Mapping[str, Any], base: tm.MpcParams) -> tm.MpcParams:
    """MpcParams.collision from the values; the posture and rho stay the base's (Collision's
    defaults when the base has no rows). Changes of enabled or arm may need another compiled
    module; only the visualizer's explicit Build compiles it."""
    if type(values["enabled"]) is not bool:
        raise ValueError("enabled must be a boolean")
    if not values["enabled"]:
        return replace(base, collision=None)
    native = base.collision or Collision()
    arm, body = values["arm"], values["body"]
    if arm not in {choice["value"] for choice in cover_choices("arm")}:
        raise ValueError(f"Unknown arm cover: {arm!r}")
    if body not in {choice["value"] for choice in cover_choices("body")}:
        raise ValueError(f"Unknown body cover: {body!r}")
    shapes = {path: tuple(tuple(map(float, item)) for item in values[path])
              for path, *_ in SHAPES if path in Collision.__dataclass_fields__}
    return replace(base, collision=replace(native, arm=arm, body=body, margin_m=float(values["margin_m"]),
                                           mechanism=values["mechanism"], **shapes))
