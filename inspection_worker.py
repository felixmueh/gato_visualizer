"""Inspection operation executed only inside a temporary selected-source child."""
from __future__ import annotations

import inspect
import hashlib
from pathlib import Path
import time
import numpy as np

from inspection_artifacts import json_metadata, write_artifact


def snapshot_models(adapter, folder, profile):
    """Retain FK inputs so later source edits cannot rewrite historical plots."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    root = Path(profile["mpc_root"])
    inputs = (("full", root / "models/tiago_pro/tiago_pro.urdf", "full_urdf_sha256"),
              ("reduced", Path(adapter.reach.URDF), "native_urdf_sha256"))
    result = {}
    for name, source, identity_key in inputs:
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if adapter.model_identity.get(identity_key) != digest:
            raise ValueError("Inspection model source changed after initialization; reselect the source")
        filename = name + ".urdf"
        with (folder / filename).open("xb") as stream:
            stream.write(data)
        result[name] = dict(filename=filename, sha256=digest)
    return result


def inspect_solve(adapter, payload):
    solver = adapter.solver
    if not (getattr(solver.lib, "ITERATION_CAPTURE_AVAILABLE", False) and
            "capture_iterations" in inspect.signature(solver.solve).parameters):
        raise ValueError("This solver profile does not support native per-iteration capture; select a rebuilt capture-capable profile")
    models = snapshot_models(adapter, payload["artifact_directory"], payload["actual_solver_profile"]["profile"])
    problem = payload["problem"]
    limits = problem["joint_limits"]
    signs = np.asarray(adapter.signs)
    installed = solver.get_row_groups()
    for group, captured in enumerate(problem["constraint_bounds_native"]):
        current = installed[group]
        for key in ("kind", "block", "mech", "n_rows", "knot_lo", "knot_hi"):
            if current.get(key) != captured.get(key):
                raise ValueError(f"Configured constraint rows differ from the captured problem ({key})")
        low = np.asarray(captured["lo"]) * signs
        high = np.asarray(captured["hi"]) * signs
        solver.set_row_group_bounds(group, np.minimum(low, high), np.maximum(low, high))
        bits = np.asarray(captured["active"], dtype=np.uint64)
        mask = ((bits[:, None] >> np.arange(7, dtype=np.uint64)) & 1).astype(bool)
        solver.set_row_group_mask(group, mask)
    # One cold invocation. No MPCController.step(), warm-start shifting or
    # reconstruction of historical private optimizer state is involved.
    state = problem["initial_state"]
    x = np.r_[state["q"], state["qd"]].astype(np.float32) * np.tile(signs, 2)
    reference = np.asarray(problem["reference_native"], dtype=np.float32)
    solver.reset_dual()
    solver.reset_rho()
    # The cold controller's held-state seed has zero prediction error and no
    # previous cap-out; its adaptive ADMM policy selects PCG in this case.
    if getattr(adapter.controller, "admm_linsys", None) == "auto":
        solver.set_admm_linsys("pcg")
    start = time.perf_counter()
    result = solver.solve(x[None, :], reference.reshape(1, -1),
                          capture_iterations=True, budget_s=payload.get("budget_s"))
    wall = time.perf_counter()-start
    if result.iteration_trace is None:
        raise ValueError("Solver claimed capture support but returned no native iteration trace")
    diagnostics = {name: json_metadata(getattr(result.stats, name)) for name in (
        "initial_merit", "final_merit", "min_merit", "step_size", "pcg_iters", "pcg_times_us",
        "ls_num_iters", "budget_hit", "linsys", "admm_r_prim", "admm_r_dual", "row_max_violation",
        "row_sum_violation") if hasattr(result.stats, name)}
    metadata = dict(model_snapshots=models, id=payload["id"], N=adapter.N, dt_s=adapter.dt, signs=signs.tolist(),
        initialization="cold_state", original=payload["original"],
        initial_state=problem["initial_state"], reference_native=problem["reference_native"],
        task=problem["task"], joint_limits=limits,
        constraint_bounds_native=problem["constraint_bounds_native"], problem_configuration=problem["problem_configuration"],
        original_model_identity=problem["original_model_identity"],
        original_solver_profile=problem["original_solver_profile"],
        model_identity=adapter.model_identity, solver_profile=payload["actual_solver_profile"],
        actual_configuration=adapter.problem_configuration,
        requested=dict(sqp_iters=payload["sqp_iters"], budget_s=payload.get("budget_s")),
        diagnostics=diagnostics, stats=dict(sqp_iters=result.iteration_trace.iterations_run,
            solve_time_ms=float(result.solve_time_us)/1000, inspection_call_wall_s=wall,
            pcg_iters=int(np.sum(result.iteration_trace.pcg_iters))),
        end_effector_frame=adapter.reach.EE_FRAME)
    return write_artifact(Path(payload["artifact_directory"]), result.iteration_trace, metadata)
