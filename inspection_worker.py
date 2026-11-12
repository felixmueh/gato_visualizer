"""Inspection operation executed only inside a temporary selected-source child."""
from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
import hashlib
from pathlib import Path
import time
import numpy as np

from inspection_artifacts import json_metadata, write_artifact


def snapshot_models(session, folder):
    """Retain FK inputs so later source edits cannot rewrite historical plots."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    inputs = (("full", session.tiago.FULL_URDF, "full_urdf_sha256"),
              ("reduced", session.tiago.arm_urdf(), "native_urdf_sha256"))
    result = {}
    for name, source, identity_key in inputs:
        data = Path(source).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if session.model_identity.get(identity_key) != digest:
            raise ValueError("Inspection model source changed after initialization; reselect the source")
        filename = name + ".urdf"
        with (folder / filename).open("xb") as stream:
            stream.write(data)
        result[name] = dict(filename=filename, sha256=digest)
    return result


def restore_bounds(solver, captured_groups):
    """Install the captured box bounds and masks without replacing appended collision rows."""
    installed = solver.get_row_groups()
    for group, captured in enumerate(captured_groups):
        current = installed[group]
        for key in ("kind", "block", "mech", "n_rows", "knot_lo", "knot_hi"):
            if current.get(key) != captured.get(key):
                raise ValueError(f"Configured constraint rows differ from the captured problem ({key})")
        solver.set_row_group_bounds(group, np.asarray(captured["lo"]), np.asarray(captured["hi"]))
        bits = np.asarray(captured["active"], dtype=np.uint64)
        mask = ((bits[:, None] >> np.arange(7, dtype=np.uint64)) & 1).astype(bool)
        solver.set_row_group_mask(group, mask)


def solve_statistics(result, cap):
    """Small statistics of one independent capped solve, with its actual stop reason."""
    raw = result.stats
    actual = int(np.asarray(raw.sqp_iters).sum())
    pcg = np.asarray(raw.pcg_iters)
    if getattr(raw, "budget_hit", False):
        reason = "wall_budget"
    elif getattr(raw, "defect_exit", False):
        reason = "defect_tolerance"
    elif np.asarray(getattr(raw, "kkt_converged", [False])).all():
        reason = "kkt_converged"
    elif actual >= cap:
        reason = "sqp_cap"
    elif pcg.size and np.asarray(pcg[-1]).max() == 0:
        reason = "zero_pcg"
    else:
        reason = "early_stop"
    stats = dict(sqp_iters=actual, pcg_iters=int(pcg.sum()),
                 zero_pcg_rows=int(np.sum(pcg == 0)), solve_time_ms=float(result.solve_time_us)/1000,
                 budget_hit=bool(getattr(raw, "budget_hit", False)))
    for key in ("admm_iters", "admm_linsys_iters"):
        values = getattr(raw, key, None)
        if values is not None:
            stats[key] = int(np.asarray(values).sum())
    diagnostics = {}
    for key in ("initial_merit", "final_merit", "min_merit", "step_size", "admm_r_prim", "admm_r_dual",
                "row_max_violation", "row_sum_violation", "defect", "linsys"):
        values = getattr(raw, key, None)
        if values is not None:
            # Per-iteration arrays become their final row; each independent run's
            # metadata stays bounded even when the requested cap is large.
            if key in ("min_merit", "step_size") and isinstance(values, np.ndarray) and values.ndim >= 2:
                values = values[-1] if len(values) else None
            diagnostics[key] = json_metadata(values)
    return actual, reason, stats, diagnostics


def inspect_solve(session, payload):
    """Solve independent caps 1..K from the same captured cold state and objective."""
    from tiago_mpc.mpc import Mpc
    from tiago_mpc.record import to_dict
    from tiago_mpc.costs import with_reference
    from solver_process import reference_from_wire
    models = snapshot_models(session, payload["artifact_directory"])
    problem = payload["problem"]
    params, binary = session.mpc.params, session.binary
    n, dt = params.N, params.dt_s
    state = problem["initial_state"]
    x = np.r_[state["q"], state["qd"]].astype(np.float32)
    held = np.zeros((n, 21), dtype=np.float32)
    held[:, :14] = x
    seed = held.reshape(-1)[:-7].reshape(1, -1)
    reference = reference_from_wire(problem["reference_native"], n)
    solver_reference = reference.copy()
    solver_reference[:, 3:] = 0.
    snapshots, runs = [seed.copy()], []
    session.mpc.close()
    for cap in range(1, payload["sqp_iters"] + 1):
        configured = replace(params, solver=replace(params.solver, max_sqp_iters=cap))
        mpc = Mpc(configured, binary)
        try:
            if to_dict(mpc.params) != to_dict(configured):
                raise ValueError("Independent capped solve resolved different native settings")
            solver = mpc.controller.solver
            restore_bounds(solver, problem["constraint_bounds_native"])
            solver.set_cost_menu(with_reference(mpc.params.cost, reference))
            solver.reset_dual()
            solver.reset_rho()
            if mpc.controller.admm_linsys == "auto":
                solver.set_admm_linsys("pcg")
            start = time.perf_counter()
            result = solver.solve(x[None, :].copy(), solver_reference.reshape(1, -1).copy(),
                                  xu_warm=seed.copy(), budget_s=payload.get("budget_s"))
            wall = time.perf_counter() - start
            snapshots.append(np.array(result.xu, dtype=np.float32, copy=True))
            actual, reason, stats, diagnostics = solve_statistics(result, cap)
            runs.append(dict(cap=cap, actual_sqp_iters=actual, stop_reason=reason,
                             stats=stats, diagnostics=diagnostics, solve_time_ms=stats["solve_time_ms"],
                             call_wall_s=wall, effective_sqp_cap=mpc.params.solver.max_sqp_iters))
        finally:
            mpc.close()
    metadata = dict(mode="independent_sqp_caps", model_snapshots=models, id=payload["id"], N=n, dt_s=dt,
        signs=[1.]*7, initialization="cold_state", original=payload["original"],
        initial_state=problem["initial_state"], reference_native=problem["reference_native"],
        task=problem["task"], joint_limits=problem["joint_limits"],
        constraint_bounds_native=problem["constraint_bounds_native"], problem_configuration=problem["problem_configuration"],
        original_model_identity=problem["original_model_identity"],
        original_solver_profile=problem["original_solver_profile"],
        model_identity=session.model_identity, solver_profile=payload["actual_solver_profile"],
        fixed_joints=session.kinematics.fixed_joints,
        actual_configuration=to_dict(params), runs=runs,
        requested=dict(sqp_iters=payload["sqp_iters"], budget_s=payload.get("budget_s")),
        diagnostics=runs[-1]["diagnostics"], stats=runs[-1]["stats"],
        end_effector_frame=session.tiago.GRASP_FRAME)
    snapshots = SimpleNamespace(xu=np.stack(snapshots), snapshot_count=len(snapshots))
    return write_artifact(Path(payload["artifact_directory"]), snapshots, metadata)
