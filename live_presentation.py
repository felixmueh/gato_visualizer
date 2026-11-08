"""Detach and render numerical observations without controller or CUDA ownership."""
from collections.abc import Mapping
from types import MappingProxyType
import math

import numpy as np


def snapshot(value):
    """Detach mutable numerical buffers and settings before handing them off."""
    if isinstance(value, np.ndarray):
        value = value.copy()
        value.flags.writeable = False
        return value
    if isinstance(value, Mapping):
        return MappingProxyType({key: snapshot(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(snapshot(item) for item in value)
    return value


def mutable(value):
    if isinstance(value, Mapping):
        return {key: mutable(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [mutable(item) for item in value]
    return value


def render_plan(captured, kinematics):
    from solver_exchange import resolve_record
    captured = resolve_record(captured)
    event = mutable(captured)
    if "_controller_restarted" in event:
        from solver_worker import plan_stats
        event["stats"] = plan_stats(event["_native_stats"], event.pop("_controller_restarted"))
        from solver_worker import finite_or_none
        event['initial_state'] = finite_or_none(event['initial_state'])
    # Numerical replies retain binary telemetry and native timing for execution.
    # The HTTP/history owner formats it after it leaves the control path.
    event.pop("_native_stats", None)
    if "diagnostics" in event:
        from solver_worker import finite_or_none
        event["diagnostics"] = finite_or_none(event["diagnostics"])
    states, torque = np.asarray(event.pop("_states")), np.asarray(event.pop("_torques"))
    q, qd = states[:, :7], states[:, 7:]
    reference = event.pop("_reference")
    from solver_process import reference_to_wire
    event["reference_native"] = reference_to_wire(reference)  # a NaN orientation slot as null
    n, dt = event["N"], event["dt_s"]
    event.update(knot_time_s=(np.arange(n)*dt).tolist(), q=q.tolist(),
                 qd_rad_s=qd.tolist(), torque_nm=torque.tolist(), torque_kind="predicted",
                 torque_time_s=(np.arange(n-1)*dt).tolist(), torque_end_time_s=(n-1)*dt,
                 ee_xyz=kinematics.ee_positions(q).tolist(),
                 reference_xyz=[kinematics.target_to_world(row[:3]).tolist() for row in reference])
    return event


def render_state(captured, kinematics, context):
    """FK and arrival of one state; context is its segment header's."""
    event = mutable(captured)
    x = event.pop("_x")
    ee = kinematics.ee_positions(x[None, :7])[0]
    # Three scalar coordinates need no BLAS call or temporary NumPy vector.
    distance = math.dist(ee, event["target_xyz"])
    arrived = (context["task"]["kind"] == "reach" and distance <= context["position_tol_m"] and
               np.abs(x[7:]).sum() <= context["speed_l1_tol_rad_s"])
    event.update(q=x[:7].tolist(), qd=x[7:].tolist(), ee_xyz=ee.tolist(),
                 distance_m=distance, arrived=bool(arrived))
    from live_mpc import orientation_goal
    goal = orientation_goal(context["task"])
    if goal is not None:
        # The grasp frame's angle to the segment's orientation goal, as tiago_mpc's
        # orientation_error: |log(R_goalᵀ R)|. Arrival stays position-only.
        event["orientation_error_rad"] = rotation_angle(goal, kinematics.ee_rotvecs(x[None, :7])[0])
    return event


def rotation_angle(a, b):
    """The angle in radians between two rotation vectors' rotations, |log(R_aᵀ R_b)|."""
    import pinocchio as pin
    return float(np.linalg.norm(pin.log3(pin.exp3(np.asarray(a, dtype=float)).T @ pin.exp3(np.asarray(b, dtype=float)))))


class LiveRenderer:
    """The presentation thread exclusively owns this full-model Pinocchio data."""
    def __init__(self, mpc_root):
        self.mpc_root = mpc_root
        self.kinematics = None

    def __call__(self, frame, context=None):
        """Render one frame; context is the segment header's, needed for a plan or state."""
        plan, state, events = frame
        captured = plan if plan is not None else state
        end_effector_frame = context["end_effector_frame"] if captured is not None else None
        if captured is not None and (self.kinematics is None or
                self.kinematics.end_effector_frame != end_effector_frame):
            from live_mpc import body_joints
            from server import RobotKinematics
            self.kinematics = RobotKinematics(self.mpc_root / "models/tiago_pro/tiago_pro.urdf",
                                             body_joints(self.mpc_root), end_effector_frame=end_effector_frame)
        result = []
        if plan is not None:
            result.append(render_plan(plan, self.kinematics))
        if state is not None:
            result.append(render_state(state, self.kinematics, context))
        result.extend(mutable(event) for event in events)
        return result
