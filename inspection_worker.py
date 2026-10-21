"""Inspection operation executed only inside a temporary selected-source child."""
from __future__ import annotations

import inspect
from pathlib import Path
import time
import numpy as np

from inspection_artifacts import json_metadata, write_artifact


def inspect_solve(adapter, payload):
    solver = adapter.solver
    if not (getattr(solver.lib, "ITERATION_CAPTURE_AVAILABLE", False) and
            "capture_iterations" in inspect.signature(solver.solve).parameters):
        raise ValueError("This solver profile does not support native per-iteration capture; select a rebuilt capture-capable profile")
    problem = payload["problem"]
    limits = problem["joint_limits"]
    signs = np.asarray(adapter.signs)
    low = np.asarray(limits["lower_position_rad"]) * signs
    high = np.asarray(limits["upper_position_rad"]) * signs
    solver.set_row_group_bounds(0, np.minimum(low, high), np.maximum(low, high))
    for group, key in ((1, "velocity_rad_s"), (2, "effort_nm")):
        values = np.asarray(limits[key])
        solver.set_row_group_bounds(group, -values, values)
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
    metadata = dict(id=payload["id"], N=adapter.N, dt_s=adapter.dt, signs=signs.tolist(),
        initialization="cold_state", original=payload["original"],
        initial_state=problem["initial_state"], reference_native=problem["reference_native"],
        task=problem["task"], joint_limits=limits, problem_configuration=problem["problem_configuration"],
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
