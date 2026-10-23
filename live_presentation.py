"""Bounded presentation pipeline; no controller or CUDA objects cross threads."""
from collections.abc import Mapping
from types import MappingProxyType
import json
import math
import threading
import time
import traceback

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
    event = mutable(captured)
    states, torque = np.asarray(event.pop("_states")), np.asarray(event.pop("_torques"))
    q, qd = states[:, :7], states[:, 7:]
    reference = event.pop("_reference")
    event["reference_native"] = np.asarray(reference).tolist()
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
    return event


class LatestPresentation:
    """One in-flight frame and one replaceable pending frame, capped at 60 Hz.

    Command boundaries invalidate an obsolete in-flight frame. During ordinary
    play we finish the current frame then take the newest snapshot, so a slow
    presenter cannot starve the display or build an ever-growing queue.
    """
    def __init__(self, render, publish, max_hz=60):
        self.render, self.publish = render, publish
        self.interval = 1/max_hz
        self.condition = threading.Condition()
        self.pending = None
        self.generation = 0
        self.closed = False
        self.thread = threading.Thread(target=self._run, name="live-mpc-presentation", daemon=True)
        self.thread.start()

    def invalidate(self):
        with self.condition:
            self.generation += 1
            self.pending = None
            self.condition.notify_all()

    def submit(self, frame, urgent=False):
        with self.condition:
            self.pending = (self.generation, frame, urgent)
            self.condition.notify_all()

    def close(self):
        with self.condition:
            self.closed = True
            self.pending = None
            self.condition.notify_all()
        self.thread.join()

    def _run(self):
        next_frame = 0
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.closed or self.pending is not None)
                if self.closed:
                    return
                remaining = next_frame-time.monotonic()
                if remaining > 0 and not self.pending[2]:
                    self.condition.wait(timeout=remaining)
                    continue
                generation, frame, _ = self.pending
                self.pending = None
            try:
                events = self.render(frame)
                for event in events:
                    json.dumps(event, allow_nan=False)
            except Exception as exc:
                events = [dict(type="error", message=f"Live presentation: {exc}",
                               detail=traceback.format_exc())]
            with self.condition:
                if self.closed:
                    return
                if generation == self.generation:
                    # Publication only appends already validated events. Neither
                    # JSON/FK nor client socket writes occur under this lock.
                    self.publish(events)
            next_frame = time.monotonic()+self.interval


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
            from server import RobotKinematics
            self.kinematics = RobotKinematics(self.mpc_root / "models/tiago_pro/tiago_pro.urdf",
                                             end_effector_frame=end_effector_frame)
        result = []
        if plan is not None:
            result.append(render_plan(plan, self.kinematics))
        if state is not None:
            result.append(render_state(state, self.kinematics, context))
        result.extend(mutable(event) for event in events)
        return result
