#!/usr/bin/env python3
"""TIAGo replay and live diagnostic MPC, served with same-origin assets."""
from __future__ import annotations

import argparse
from copy import deepcopy
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
import math
import queue
from pathlib import Path
import signal
import sys
import threading
import uuid
from urllib.parse import parse_qs, unquote, urlsplit
import xml.etree.ElementTree as ET

import numpy as np
import pinocchio as pin

from visualizer_config import DEFAULT_CONFIG, load_visualizer_config

ROOT = Path(__file__).resolve().parent
JOINT_NAMES = [f"arm_right_{i}_joint" for i in range(1, 8)]
# Native left-arm joint values chosen from the canonical left chain for a bent
# resting display pose. These are visual context, not a dynamics symmetry rule.
LEFT_ARM_REST_RAD = (0.39, -1.73, 0.38, -2.35, 0.0, -1.21, -0.04)
FIXED_DISPLAY_JOINTS = {f"arm_left_{i}_joint": angle
                        for i, angle in enumerate(LEFT_ARM_REST_RAD, 1)}


class SourceError(ValueError):
    """A source recording cannot be represented faithfully."""


def finite_array(value, name, shape=None):
    result = np.asarray(value, dtype=float)
    if shape is not None and result.shape != shape:
        raise SourceError(f"{name}: expected shape {shape}, got {result.shape}")
    if not np.isfinite(result).all():
        raise SourceError(f"{name}: contains nonfinite values")
    return result


def decode_prediction(xu, signs, knots):
    """Decode [q7,v7,u7] knots with the terminal control omitted."""
    if isinstance(knots, bool) or int(knots) != knots or knots < 2:
        raise SourceError("Prediction knot count must be an integer >= 2")
    knots = int(knots)
    signs = finite_array(signs, "GPU coordinate signs", (7,))
    if not np.isin(signs, [-1.0, 1.0]).all():
        raise SourceError("GPU coordinate signs must each be +1 or -1")
    packed = finite_array(xu, "packed prediction")
    if packed.shape not in [(21 * knots - 7,), (1, 21 * knots - 7)]:
        raise SourceError(f"Packed prediction must contain one {21 * knots - 7}-value trajectory")
    packed = packed.reshape(-1)
    # The final block is 14 values, so a reshape into N full blocks is wrong.
    q_gpu = np.stack([packed[21 * k:21 * k + 7] for k in range(knots)])
    return q_gpu * signs


def decode_prediction_telemetry(xu, signs, knots):
    """Native q, velocity and nonterminal actuator controls; no terminal u."""
    q = decode_prediction(xu, signs, knots)
    packed = np.asarray(xu, dtype=float).reshape(-1)
    velocity = np.stack([packed[21*k+7:21*k+14] for k in range(int(knots))]) * signs
    torque = np.stack([packed[21*k+14:21*k+21] for k in range(int(knots)-1)]) * signs
    return q, velocity, torque


def canonical_joint_limits(urdf):
    joints = {joint.get("name"): joint for joint in ET.parse(urdf).getroot().findall("joint")}
    fields = (("lower_position_rad", "lower"), ("upper_position_rad", "upper"),
              ("velocity_rad_s", "velocity"), ("effort_nm", "effort"))
    result = {name: [float(joints[joint].find("limit").get(attribute)) for joint in JOINT_NAMES]
              for name, attribute in fields}
    result["source"] = "Canonical display URDF limits"
    return result


def provenance_mpc_bounds(provenance, limits):
    """MPC bounds from a replay's recorded tiago_mpc parameters.

    provenance.params is asdict(MpcParams); tiago_mpc's set_bounds applies its
    joint_margin_rad, velocity_fraction and effort_fraction to the raw URDF
    limits. Only numeric values count; missing ones are not inferred.
    """
    params = provenance.get("params") if isinstance(provenance, dict) else None
    if not isinstance(params, dict) or not limits:
        return None
    number = lambda value: isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    bounds = {key: params[key] for key in ("joint_margin_rad", "velocity_fraction", "effort_fraction")
              if number(params.get(key))}
    result = {}
    if "joint_margin_rad" in bounds:
        margin = bounds["joint_margin_rad"]
        result.update(lower_position_rad=[v + margin for v in limits["lower_position_rad"]],
                      upper_position_rad=[v - margin for v in limits["upper_position_rad"]])
    for key, name in (("velocity_rad_s", "velocity_fraction"), ("effort_nm", "effort_fraction")):
        if name in bounds:
            result[key] = [bounds[name] * v for v in limits[key]]
    if not result:
        return None
    return dict(result, limit_bounds=bounds, source="MPC bounds from the recorded MpcParams")


def add_telemetry(item, qd=None, torque=None, torque_times=None, kind="applied"):
    if qd is not None:
        item["qd_rad_s"] = np.asarray(qd).tolist()
    if torque is not None:
        item.update(torque_nm=np.asarray(torque).tolist(), torque_kind=kind,
                    torque_time_s=np.asarray(torque_times).tolist())
        if kind == "predicted":
            item["torque_end_time_s"] = item["time_s"][-1]
    return item


class RobotKinematics:
    def __init__(self, urdf, fixed_joints=None, *, end_effector_frame="arm_right_tool_joint",
                 reduced_urdf=None):
        if not isinstance(end_effector_frame, str) or not end_effector_frame.strip():
            raise SourceError("end_effector_frame must be a nonempty fixed-joint name")
        self.model = pin.buildModelFromUrdf(str(urdf))
        self.data = self.model.createData()
        self.neutral = pin.neutral(self.model)
        for name, angle in FIXED_DISPLAY_JOINTS.items():
            jid = self.model.getJointId(name)
            if jid == self.model.njoints or self.model.joints[jid].nq != 1:
                raise SourceError(f"Expected one-axis native display joint: {name}")
            index = self.model.joints[jid].idx_q
            if not self.model.lowerPositionLimit[index] <= angle <= self.model.upperPositionLimit[index]:
                raise SourceError(f"Display posture is outside canonical joint limits: {name}")
            self.neutral[index] = angle
        for name, value in (fixed_joints or {}).items():
            jid = self.model.getJointId(name)
            if name in JOINT_NAMES or jid == self.model.njoints:
                raise SourceError(f"Unsupported fixed context joint: {name}")
            if isinstance(value, bool) or not np.isfinite(value):
                raise SourceError(f"Fixed context joint must be finite: {name}")
            joint = self.model.joints[jid]
            if joint.nq == 1:
                self.neutral[joint.idx_q] = value
            elif joint.nq == 2 and joint.nv == 1:
                self.neutral[joint.idx_q:joint.idx_q+2] = [np.cos(value), np.sin(value)]
            else:
                raise SourceError(f"Unsupported fixed context joint representation: {name}")
        self.arm_indices = []
        for name in JOINT_NAMES:
            jid = self.model.getJointId(name)
            if jid == self.model.njoints or self.model.joints[jid].nq != 1:
                raise SourceError(f"Expected one-axis native arm joint: {name}")
            self.arm_indices.append(self.model.joints[jid].idx_q)
        self.end_effector_frame = end_effector_frame
        self.ee_frame = self.model.getFrameId(end_effector_frame)
        self.ee_offset = pin.SE3.Identity()
        if self.ee_frame >= self.model.nframes:
            # Application TCP frames live in the reduced model, leaving the
            # canonical display URDF and historical replay hashes unchanged.
            # tiago_mpc derives the reduced arm into the cache (GATO_CACHE_DIR, the
            # selected cache in the backend) from the checkout's full URDF.
            if reduced_urdf is None:
                from live_mpc import import_tiago
                reduced_urdf = import_tiago(Path(urdf).parents[2]).arm_urdf()
            joint = next((j for j in ET.parse(reduced_urdf).getroot().findall("joint")
                          if j.get("name") == end_effector_frame), None)
            if joint is None or joint.get("type") != "fixed":
                raise SourceError(f"Missing fixed end-effector frame: {end_effector_frame}")
            self.ee_frame = self.model.getFrameId(joint.find("parent").get("link"))
            origin = joint.find("origin")
            attributes = {} if origin is None else origin.attrib
            xyz = finite_array([float(x) for x in attributes.get("xyz", "0 0 0").split()], "TCP xyz", (3,))
            rpy = finite_array([float(x) for x in attributes.get("rpy", "0 0 0").split()], "TCP rpy", (3,))
            self.ee_offset = pin.SE3(pin.rpy.rpyToMatrix(rpy), xyz)
        self.torso_frame = self.model.getFrameId("torso_lift_link")
        if max(self.ee_frame, self.torso_frame) >= self.model.nframes:
            raise SourceError("Canonical URDF is missing end-effector or torso frame")
        pin.forwardKinematics(self.model, self.data, self.neutral)
        pin.updateFramePlacements(self.model, self.data)
        self.world_from_torso = self.data.oMf[self.torso_frame].copy()
        first_joint = next(j for j in ET.parse(urdf).getroot().findall("joint")
                           if j.get("name") == JOINT_NAMES[0])
        parent_frame = self.model.getFrameId(first_joint.find("parent").get("link"))
        if parent_frame >= self.model.nframes:
            raise SourceError("Canonical URDF is missing the right arm parent frame")
        self.arm_base = self.data.oMf[parent_frame].homogeneous.copy()

    def ee_positions(self, arm_q):
        positions = []
        q = self.neutral.copy()
        for row in arm_q:
            q[self.arm_indices] = row
            pin.forwardKinematics(self.model, self.data, q)
            pin.updateFramePlacements(self.model, self.data)
            positions.append((self.data.oMf[self.ee_frame] * self.ee_offset).translation.copy())
        return finite_array(positions, "world end-effector positions", (len(arm_q), 3))

    def target_to_world(self, target):
        return self.world_from_torso.act(finite_array(target, "torso target", (3,)))


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_model_assets(mpc_root):
    """Canonical assets and static context, independent of any recording."""
    mpc_root = Path(mpc_root).expanduser().resolve()
    urdf = mpc_root / "models/tiago_pro/tiago_pro.urdf"
    if not urdf.is_file():
        raise SourceError(f"Canonical full robot model is missing: {urdf}")
    tree = ET.parse(urdf)
    assets = {}
    for mesh in tree.iter("mesh"):
        basename = Path(mesh.attrib["filename"]).name
        mesh_path = mpc_root / "models/tiago_pro/meshes" / basename
        if not mesh_path.is_file() or mesh_path.suffix.lower() != ".stl":
            raise SourceError(f"Missing canonical STL mesh: {mesh_path}")
        with mesh_path.open("rb") as stream:  # the browser would draw a pointer as nothing
            if stream.read(23) == b"version https://git-lfs":
                raise SourceError(f"Git LFS pointer instead of a mesh (git lfs pull): {mesh_path}")
        url = f"/assets/meshes/{basename}"
        assets[url] = mesh_path.resolve()
        mesh.set("filename", url)
    fixed_joints = {j.get("name"): 0.0 for j in tree.getroot().findall("joint")
                    if j.get("type") != "fixed" and j.get("name") not in JOINT_NAMES}
    fixed_joints.update(FIXED_DISPLAY_JOINTS)
    links = {link.get("name") for link in tree.getroot().findall("link")}
    children = {j.find("child").get("link") for j in tree.getroot().findall("joint")}
    root_links = links - children
    if len(root_links) != 1:
        raise SourceError("Expected one full-robot root link")
    return (ET.tostring(tree.getroot(), encoding="utf-8", xml_declaration=True),
            assets, fixed_joints, next(iter(root_links)))


def load_scene(mpc_root, start_pose=None):
    """The default scene: the arm at start_pose (seven native joint positions), by
    default Live's default start pose, the checkout's tiago.Q_START
    (live_mpc.start_pose_spec), without a recording."""
    robot_xml, assets, fixed_joints, world_frame = canonical_model_assets(mpc_root)
    if start_pose is None:
        from live_mpc import import_tiago, start_pose_spec
        start_pose = start_pose_spec(import_tiago(mpc_root))["default"]
    if len(start_pose) != len(JOINT_NAMES):
        raise SourceError("The start pose needs one position per right-arm joint")
    fixed_joints.update(zip(JOINT_NAMES, map(float, start_pose)))
    urdf = Path(mpc_root) / "models/tiago_pro/tiago_pro.urdf"
    scene = dict(robot_url="/assets/robot.urdf", joint_names=JOINT_NAMES,
                 joint_limits=canonical_joint_limits(urdf),
                 fixed_joints=fixed_joints, world_frame=world_frame, up_axis="Z",
                 end_effector_frame="arm_right_tool_joint", trajectories=[],
                 source=dict(mpc_root=str(Path(mpc_root).resolve()), bootstrap=True,
                             label="Start pose — upload or select a recording",
                             full_urdf_sha256=sha256(urdf), files_sha256={}))
    return scene, robot_xml, assets


def _replay_geometry(replay, mpc_root, base_scene):
    fixed = {name: value for name, value in base_scene["fixed_joints"].items() if name not in JOINT_NAMES}
    fixed.update(replay.metadata.get("fixed_joints", {}))
    end_effector_frame = replay.metadata.get("end_effector_frame", "arm_right_tool_joint")
    kinematics = RobotKinematics(Path(mpc_root) / "models/tiago_pro/tiago_pro.urdf", fixed_joints=fixed,
                                 end_effector_frame=end_effector_frame)
    return fixed, end_effector_frame, kinematics


def _reference_world(reference, kinematics):
    points = np.atleast_2d(reference.xyz)
    if reference.frame == "torso_lift_link":
        transform = kinematics.world_from_torso
        return points @ transform.rotation.T + transform.translation
    return points


def replay_motion(replay, path, mpc_root, base_scene):
    """A comparison track has recorded motion and no FK for saved predictions."""
    fixed, frame, kinematics = _replay_geometry(replay, mpc_root, base_scene)
    result = dict(label=replay.metadata.get("label", path.stem), time_basis=replay.metadata["time_basis"],
                  end_effector_frame=frame, fixed_joints=fixed,
                  joint_limits=(replay.joint_limits or canonical_joint_limits(
                      Path(mpc_root) / "models/tiago_pro/tiago_pro.urdf")),
                  model_warning=deepcopy(replay.model_warning), time_s=replay.time_s.tolist(), q=replay.q.tolist(),
                  ee_xyz=kinematics.ee_positions(replay.q).tolist(), reference_time_s=None, reference_xyz=None,
                  arm_base=kinematics.arm_base.tolist(), plan_count=len(replay.predictions),
                  provenance=deepcopy(replay.metadata.get("provenance", {})))
    if replay.reference is not None:
        points = _reference_world(replay.reference, kinematics)
        times = replay.reference.time_s
        if times is None:
            times = replay.time_s[[0, -1]]
            points = np.repeat(points, 2, axis=0)
        result.update(reference_time_s=times.tolist(), reference_xyz=points.tolist())
    json.dumps(result, allow_nan=False)
    return result


def replay_scene(replay, path, mpc_root, base_scene):
    """Convert a portable native replay into the existing browser scene shape."""
    fixed, end_effector_frame, kinematics = _replay_geometry(replay, mpc_root, base_scene)

    def world_points(reference):
        return _reference_world(reference, kinematics)

    def trajectory(identifier, label, kind, times, q, reference, origin=None, stats=None):
        metadata = dict(time_basis=replay.metadata["time_basis"], coordinates="native",
                        source_file=path.name, recording_format="tiago-replay v1")
        if origin is not None:
            metadata.update(recorded_start_s=origin, origin_time_s=origin)
        if stats:
            metadata["stats"] = stats
        item = dict(id=identifier, label=label, kind=kind, time_s=times.tolist(), q=q.tolist(),
                    ee_xyz=kinematics.ee_positions(q).tolist(), target_xyz=None, metadata=metadata)
        if reference is not None:
            points = world_points(reference)
            if reference.time_s is None:
                reference_times = np.asarray([times[0], times[-1]])
                points = np.repeat(points, 2, axis=0)
            elif origin is not None and reference is replay.reference:
                # A recording reference uses the recording clock; plans use
                # offsets from their explicit origin on that same clock.
                reference_times = times
                points = np.column_stack([np.interp(origin+times, reference.time_s, points[:, axis])
                                          for axis in range(3)])
            else:
                reference_times = reference.time_s
            item.update(reference_time_s=reference_times.tolist(), reference_xyz=points.tolist(),
                        target_xyz=points[0].tolist())
        return item

    trajectories = [trajectory("recorded", replay.metadata.get("label", "Recorded motion"), "recorded",
                               replay.time_s, replay.q, replay.reference)]
    add_telemetry(trajectories[0], replay.qd_rad_s, replay.torque_nm, replay.torque_time_s)
    trajectories.extend(trajectory(plan.identifier, plan.label, "prediction", plan.time_s, plan.q,
                                   plan.reference or replay.reference, plan.origin_time_s, plan.stats)
                        for plan in replay.predictions)
    for item, plan in zip(trajectories[1:], replay.predictions):
        add_telemetry(item, plan.qd_rad_s, plan.torque_nm, plan.torque_time_s, kind="predicted")
    result = deepcopy(base_scene)
    result.update(fixed_joints=fixed, trajectories=trajectories, end_effector_frame=end_effector_frame,
                  joint_limits=(replay.joint_limits or canonical_joint_limits(
                      Path(mpc_root) / "models/tiago_pro/tiago_pro.urdf")))
    result["source"] = dict(mpc_root=str(Path(mpc_root).resolve()), replay_file=str(path),
                            full_urdf_sha256=replay.metadata["model_sha256"],
                            replay_format="tiago-replay", replay_version=1,
                            time_basis=replay.metadata["time_basis"],
                            files_sha256={path.name: sha256(path)})
    if replay.model_warning:
        result["source"]["model_warning"] = dict(replay.model_warning)
    if "provenance" in replay.metadata:
        result["source"]["provenance"] = deepcopy(replay.metadata["provenance"])
    result.pop("mpc_bounds", None)
    # Without recorded limits, the bounds use the displayed URDF's limits.
    mpc_bounds = provenance_mpc_bounds(replay.metadata.get("provenance"), result["joint_limits"])
    if mpc_bounds:
        result["mpc_bounds"] = mpc_bounds
    json.dumps(result, allow_nan=False)
    return result


def accepts_gzip(value):
    """Honor explicit gzip exclusion before an Accept-Encoding wildcard."""
    codings = {}
    for item in value.lower().split(","):
        name, *parameters = item.strip().split(";")
        name = name.strip()
        quality = 1.
        for parameter in parameters:
            key, _, raw = parameter.strip().partition("=")
            if key == "q":
                try:
                    quality = float(raw)
                except ValueError:
                    quality = 0.
        codings[name] = quality
    return codings.get("gzip", codings.get("*", 0.)) > 0.


def make_server(scene, robot_xml, mesh_assets, host="127.0.0.1", port=8090, dist=None, live=None,
                replays=None, sources=None, live_error=None, plots=None, solver_profiles=None, inspections=None, presentation=None):
    dist = Path(dist or ROOT / "dist").resolve()
    scene_json = json.dumps(scene, allow_nan=False, separators=(",", ":")).encode()
    backend_id = uuid.uuid4().hex

    class Handler(BaseHTTPRequestHandler):
        def send_payload(self, payload, content_type, status=200, *, compress=False):
            # Browser fetch decompresses transparently. Compress history in its
            # HTTP thread, outside numerical work and history-store locks.
            compressed = (compress and len(payload) >= 1024
                          and accepts_gzip(self.headers.get("Accept-Encoding", "")))
            if compressed:
                payload = gzip.compress(payload, compresslevel=1, mtime=0)
            self.send_response(status)
            if compress:
                self.send_header("Vary", "Accept-Encoding")
            if compressed:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)

        def send_json_error(self, status, message):
            # API clients always parse JSON, also for unknown or disabled routes.
            self.send_payload(json.dumps(dict(error=message)).encode(),
                              "application/json; charset=utf-8", status)

        def live_unavailable(self, path):
            """Live-backed routes without a Live service report why, as JSON."""
            services = {"/api/live/": live, "/api/solver-profiles": solver_profiles,
                        "/api/solve-inspections": inspections}
            if any(path.startswith(prefix) and service is None for prefix, service in services.items()):
                self.send_json_error(503, live_error or "Live is unavailable")
                return True
            return False

        def do_HEAD(self):
            self.do_GET()

        def do_POST(self):
            if self.live_unavailable(urlsplit(self.path).path):
                return
            if urlsplit(self.path).path == "/api/presentation/settings" and presentation is not None:
                self.presentation_command()
                return
            if urlsplit(self.path).path.startswith("/api/solve-inspections") and inspections is not None:
                self.inspection_command()
                return
            if urlsplit(self.path).path in ("/api/solver-profiles", "/api/solver-profiles/activate") and solver_profiles is not None:
                self.solver_profile_command()
                return
            if urlsplit(self.path).path.startswith("/api/plots/") and plots is not None:
                self.plot_command()
                return
            if urlsplit(self.path).path.startswith("/api/source/") and sources is not None:
                self.source_command()
                return
            if urlsplit(self.path).path == "/api/replays/upload" and replays is not None:
                self.upload_replay()
                return
            if urlsplit(self.path).path == "/api/live/freeze" and replays is not None:
                self.freeze_live()
                return
            if urlsplit(self.path).path != "/api/live/command":
                self.send_json_error(404, "Unknown API endpoint")
                return
            # Only same-origin browser JSON may control the local GPU worker.
            origin = self.headers.get("Origin")
            if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536:
                    raise ValueError("Expected a JSON command under 64 KiB")
                if self.headers.get_content_type() != "application/json":
                    raise ValueError("Content-Type must be application/json")
                body = json.loads(self.rfile.read(length))
                version = live.command(body)
                result, status = dict(accepted=True, settings_version=version), 200
            except (ValueError, TypeError) as exc:
                result, status = dict(accepted=False, error=str(exc)), 400
            self.send_payload(json.dumps(result, allow_nan=False).encode(),
                              "application/json; charset=utf-8", status)

        def freeze_live(self):
            from datetime import datetime, timezone
            from execution_bridge import HistoryGenerationError, LiveFreezeConflict
            from live_freeze import export_freeze
            origin = self.headers.get("Origin")
            if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_json_error(403, "Freeze requires a same-origin request")
                return
            try:
                if urlsplit(self.path).query:
                    raise ValueError("Freeze does not accept query parameters")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536 or self.headers.get_content_type() != "application/json":
                    raise ValueError("Expected a JSON freeze command under 64 KiB")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict) or set(body) != {"generation"} or type(body["generation"]) is not int:
                    raise ValueError("Freeze requires only an integer generation")
                timestamp = datetime.now(timezone.utc)
                label = "Freeze · " + timestamp.strftime("%H:%M:%S")
                destination = replays.freeze_directory / (".freeze-" + timestamp.strftime("%Y%m%dT%H%M%S") +
                                                           "-" + uuid.uuid4().hex[:12] + ".npz")
                def writer(records, complete):
                    return export_freeze(destination, records, mpc_root=live.mpc_root,
                        model_urdf=replays.model_urdf, generation=body["generation"], complete=complete,
                        fixed_joints=scene["fixed_joints"], world_frame=scene["world_frame"],
                        label=label, frozen_at=timestamp.isoformat())
                item = live.freeze(body["generation"], writer, replays.add_freeze)
                result, status = dict(accepted=True, item=item), 200
            except (ValueError, TypeError, KeyError, OSError, RuntimeError) as exc:
                result = dict(accepted=False, error=str(exc))
                status = 409 if isinstance(exc, (HistoryGenerationError, LiveFreezeConflict)) else 400
            self.send_payload(json.dumps(result, allow_nan=False).encode(), "application/json; charset=utf-8", status)

        def presentation_command(self):
            origin = self.headers.get("Origin")
            if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536 or self.headers.get_content_type() != "application/json":
                    raise ValueError("Expected JSON presentation settings under 64 KiB")
                result = presentation.update(json.loads(self.rfile.read(length)))
                status = 200
            except (ValueError, TypeError, OSError, RuntimeError) as exc:
                result, status = dict(error=str(exc)), 400
            self.send_payload(json.dumps(result, allow_nan=False).encode(), "application/json; charset=utf-8", status)

        def inspection_command(self):
            origin = self.headers.get("Origin")
            if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536 or self.headers.get_content_type() != "application/json":
                    raise ValueError("Expected JSON solve selectors under 64 KiB")
                body = json.loads(self.rfile.read(length))
                path = urlsplit(self.path).path
                if path == "/api/solve-inspections":
                    result, status = inspections.submit(body), 202
                elif path == "/api/solve-inspections/capability":
                    result, status = inspections.capability(body), 200
                elif path.startswith("/api/solve-inspections/jobs/") and path.endswith("/stop"):
                    if body != {}:
                        raise ValueError("Stop requires an empty JSON object")
                    identifier = path.removeprefix("/api/solve-inspections/jobs/").removesuffix("/stop")
                    result, status = inspections.stop(identifier), 200
                else:
                    self.send_error(404)
                    return
            except (ValueError, TypeError, KeyError, OSError, RuntimeError) as exc:
                result, status = dict(error=str(exc)), 404 if isinstance(exc, KeyError) else 400
            self.send_payload(json.dumps(result, allow_nan=False).encode(), "application/json; charset=utf-8", status)

        def solver_profile_command(self):
            origin = self.headers.get("Origin")
            if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536 or self.headers.get_content_type() != "application/json":
                    raise ValueError("Expected a JSON profile request under 64 KiB")
                body = json.loads(self.rfile.read(length))
                if urlsplit(self.path).path.endswith("/activate"):
                    result, status = solver_profiles.activate(body), 202
                else:
                    result, status = solver_profiles.save(body), 200
            except (ValueError, TypeError, OSError, RuntimeError) as exc:
                result, status = dict(error=str(exc)), 400
            self.send_payload(json.dumps(result, allow_nan=False).encode(),
                              "application/json; charset=utf-8", status)

        def plot_command(self):
            origin = self.headers.get("Origin")
            if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536 or self.headers.get_content_type() != "application/json":
                    raise ValueError("Expected JSON plot selectors/settings under 64 KiB")
                body = json.loads(self.rfile.read(length))
                action = urlsplit(self.path).path.removeprefix("/api/plots/")
                if action in ("catalog", "evaluate"):
                    result, status = plots.submit(body, catalog=action == "catalog"), 202
                elif action == "settings":
                    result, status = plots.update_settings(body), 200
                elif action == "reload":
                    if body != {}:
                        raise ValueError("Reload requires an empty JSON object")
                    result, status = plots.reload(), 200
                else:
                    self.send_error(404)
                    return
            except (ValueError, TypeError, OSError, RuntimeError) as exc:
                result, status = dict(error=str(exc)), 400
            self.send_payload(json.dumps(result, allow_nan=False).encode(),
                              "application/json; charset=utf-8", status)

        def source_command(self):
            origin = self.headers.get("Origin")
            if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536 or self.headers.get_content_type() != "application/json":
                    raise ValueError("Expected a JSON source command under 64 KiB")
                body = json.loads(self.rfile.read(length))
                action = urlsplit(self.path).path.removeprefix("/api/source/")
                method = getattr(sources, action, None) if action in ("inspect", "build", "apply", "defaults") else None
                if method is None:
                    self.send_error(404)
                    return
                result, status = method(body), 200
            except (ValueError, TypeError, OSError, RuntimeError) as exc:
                result, status = dict(error=str(exc)), 400
            self.send_payload(json.dumps(result, allow_nan=False).encode(),
                              "application/json; charset=utf-8", status)
            if status == 200 and action == "apply":
                self.wfile.flush()
                sources.finish_apply()

        def upload_replay(self):
            from replay_format import MAX_COMPRESSED_BYTES, ReplayError
            from replay_library import UploadConflict
            origin = self.headers.get("Origin")
            if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_error(403)
                return
            status = 400
            try:
                query = parse_qs(urlsplit(self.path).query)
                if set(query) != {"path"} or len(query["path"]) != 1:
                    raise ReplayError("Upload requires one relative .npz path query parameter")
                length = int(self.headers.get("Content-Length", "0"))
                if length > MAX_COMPRESSED_BYTES:
                    status = 413
                    raise ReplayError("Upload exceeds the 64 MiB compressed file limit")
                if length <= 0:
                    raise ReplayError("Upload must contain one nonempty NPZ file")
                if self.headers.get_content_type() != "application/octet-stream":
                    raise ReplayError("Upload Content-Type must be application/octet-stream")
                self.connection.settimeout(30)
                payload = self.rfile.read(length)
                if len(payload) != length:
                    raise ReplayError("Incomplete upload; no recording was published")
                item = replays.upload(query["path"][0], payload)
                result, status = dict(accepted=True, item=item, id=item["id"]), 200
            except UploadConflict as exc:
                result, status = dict(accepted=False, error=str(exc)), 409
            except (ReplayError, ValueError, OSError) as exc:
                result = dict(accepted=False, error=str(exc))
            self.send_payload(json.dumps(result, allow_nan=False).encode(),
                              "application/json; charset=utf-8", status)

        def live_events(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            if self.command == "HEAD":
                return
            cursor, initial = live.subscribe()
            self.connection.settimeout(3)
            try:
                events = initial
                while not live.closed:
                    if events:
                        for event in events:
                            self.wfile.write(b"data: " + json.dumps(event, allow_nan=False,
                                             separators=(",", ":")).encode() + b"\n\n")
                    else:
                        self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    cursor, events = live.read_events(cursor, timeout=.5)
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                pass
            finally:
                live.unsubscribe()

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            if "\\" in path or "\x00" in path or ".." in path.split("/"):
                self.send_error(404)
                return
            if self.live_unavailable(path):
                return
            if path == "/api/presentation/settings" and presentation is not None:
                self.send_payload(json.dumps(presentation.settings(), allow_nan=False).encode(),
                                  "application/json; charset=utf-8")
            elif path == "/api/scene":
                self.send_payload(scene_json, "application/json; charset=utf-8")
            elif path.startswith("/api/solve-inspections/jobs/") and inspections is not None:
                try:
                    result = inspections.job(path.removeprefix("/api/solve-inspections/jobs/"))
                    status = 200
                except KeyError as exc:
                    result, status = dict(error=str(exc)), 404
                self.send_payload(json.dumps(result, allow_nan=False).encode(),
                                  "application/json; charset=utf-8", status, compress=True)
            elif path.startswith("/api/plots/") and plots is not None:
                try:
                    if path == "/api/plots/settings":
                        result = plots.settings()
                    elif path == "/api/plots/catalog":
                        query = parse_qs(urlsplit(self.path).query)
                        result = plots.static_catalog(query.get("context", [None])[0])
                    elif path.startswith("/api/plots/jobs/"):
                        result = plots.job(path.removeprefix("/api/plots/jobs/"))
                    else:
                        raise KeyError("Unknown plot endpoint")
                    status = 200
                except (KeyError, ValueError, OSError, RuntimeError) as exc:
                    result, status = dict(error=str(exc)), 404 if isinstance(exc, KeyError) else 400
                self.send_payload(json.dumps(result, allow_nan=False, separators=(",", ":")).encode(),
                                  "application/json; charset=utf-8", status, compress=True)
            elif path == "/api/solver-profiles" and solver_profiles is not None:
                self.send_payload(json.dumps(solver_profiles.status(), allow_nan=False).encode(),
                                  "application/json; charset=utf-8")
            elif path == "/api/replays" and replays is not None:
                self.send_payload(json.dumps(replays.catalog(), allow_nan=False).encode(),
                                  "application/json; charset=utf-8")
            elif path == "/api/source" and sources is not None:
                try:
                    result, status = sources.status(), 200
                except (ValueError, OSError, RuntimeError) as exc:
                    result, status = dict(error=str(exc)), 400
                self.send_payload(json.dumps(result, allow_nan=False).encode(),
                                  "application/json; charset=utf-8", status)
            elif path in ("/api/replays/scene", "/api/replays/motion") and replays is not None:
                try:
                    query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                    if set(query) != {"id"} or len(query["id"]) != 1:
                        raise ValueError("Select one recording with its catalog id")
                    selected = (replays.motion if path.endswith("/motion") else replays.scene)(query["id"][0])
                    self.send_payload(json.dumps(selected, allow_nan=False, separators=(",", ":")).encode(),
                                      "application/json; charset=utf-8", compress=True)
                except (KeyError, ValueError, OSError) as exc:
                    status = 404 if isinstance(exc, KeyError) else 400
                    self.send_payload(json.dumps(dict(error=str(exc))).encode(),
                                      "application/json; charset=utf-8", status)
            elif path == "/api/health":
                self.send_payload(json.dumps(dict(status="ok", trajectories=len(scene["trajectories"]), backend_id=backend_id)).encode(),
                                  "application/json; charset=utf-8")
            elif path == "/api/live/schema" and live is not None:
                self.send_payload(json.dumps(live.schema, allow_nan=False).encode(),
                                  "application/json; charset=utf-8")
            elif path == "/api/live/history" and live is not None:
                from execution_bridge import HistoryGenerationError
                try:
                    query = parse_qs(urlsplit(self.path).query)
                    if "generation" not in query or not set(query) <= {"generation", "after", "limit"} or any(len(values) != 1 for values in query.values()):
                        raise ValueError("History requires one generation and optional after/limit")
                    read_page = getattr(live, "history_json", live.history)
                    payload = read_page(int(query["generation"][0]),
                                        int(query.get("after", ["0"])[0]),
                                        int(query.get("limit", ["256"])[0]))
                    status = 200
                except (ValueError, TypeError) as exc:
                    status = 409 if isinstance(exc, HistoryGenerationError) else 400
                    payload = dict(error=str(exc), generation=live.generation)
                self.send_payload(payload if isinstance(payload, bytes) else json.dumps(payload, allow_nan=False, separators=(",", ":")).encode(),
                                  "application/json; charset=utf-8", status, compress=True)
            elif path == "/api/live/events" and live is not None:
                self.live_events()
            elif path == "/assets/robot.urdf":
                self.send_payload(robot_xml, "application/xml; charset=utf-8")
            elif path in mesh_assets:
                self.send_payload(mesh_assets[path].read_bytes(), "model/stl")
            elif path.startswith("/api/"):
                self.send_json_error(404, "Unknown API endpoint")
            elif path.startswith("/assets/meshes/"):
                self.send_error(404)
            else:
                candidate = (dist / path.lstrip("/")).resolve()
                if not candidate.is_relative_to(dist):
                    self.send_error(404)
                    return
                if not candidate.is_file() and not Path(path).suffix:
                    candidate = dist / "index.html"
                if candidate.is_file():
                    content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
                    self.send_payload(candidate.read_bytes(), content_type)
                elif path == "/":
                    self.send_payload(b"Frontend build missing. Run npm install && npm run build in the visualizer checkout.\n",
                                      "text/plain; charset=utf-8", 503)
                else:
                    self.send_error(404)

    return ThreadingHTTPServer((host, port), Handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG,
                        help="Visualizer JSON config (default: checkout visualizer.json)")
    parser.add_argument("--mpc-root", type=Path,
                        help="Source checkout; overrides TIAGO_MPC_ROOT and saved Source / Build selection")
    parser.add_argument("--host", default="127.0.0.1", help="Use 0.0.0.0 to view over your local network")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--replay-only", action="store_true", help="Disable all live solver work")
    args = parser.parse_args(argv)
    try:
        visualizer_config = load_visualizer_config(args.config)
    except ValueError as exc:
        parser.exit(1, f"Config error: {exc}\n")
    from visualizer_config import effective_source_selection
    selection = effective_source_selection(visualizer_config, args.mpc_root)
    args.mpc_root = Path(selection["mpc_root"])
    # A new process is essential: Python extension modules and CUDA imports
    # cannot be exchanged safely inside an existing numerical worker.
    if os.path.abspath(sys.executable) != os.path.abspath(selection["python"]):
        os.execve(selection["python"], [selection["python"], str(ROOT / "server.py"),
                  *(sys.argv[1:] if argv is None else argv)], os.environ.copy())
    # An explicit cache override, else unset: tiago_mpc's cache_root() decides.
    if selection["cache"]:
        os.environ["GATO_CACHE_DIR"] = selection["cache"]
    else:
        os.environ.pop("GATO_CACHE_DIR", None)
    # SIGTERM stops like Ctrl-C: the services below close their child processes.
    # A second SIGTERM ends the server at once; the children then exit with it.
    def stop(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    os.environ["PATH"] = str(Path(selection["python"]).parent) + os.pathsep + os.environ.get("PATH", "")
    try:
        scene, robot_xml, meshes = load_scene(args.mpc_root)
    except (SourceError, OSError, RuntimeError, ImportError, ValueError) as exc:
        parser.exit(1, f"Source error: {exc}\n")
    live, live_error = None, None
    if args.replay_only:
        live_error = "Live is off: the server runs with --replay-only"
    else:
        from live_mpc import LiveService
        try:
            live = LiveService(args.mpc_root, solver_profile=dict(id="simulator", name="Simulator checkout", **selection),
                               report_hz=visualizer_config.presentation["report_hz"])
        except (ValueError, OSError, RuntimeError, queue.Empty) as exc:
            live_error = str(exc) or "Numerical worker did not become ready within 60 seconds"
            print(f"Live setup error: {exc}; use Source / Build to check this selection", file=sys.stderr)
    from replay_library import ReplayLibrary
    library = ReplayLibrary(ingest_directory=visualizer_config.ingest_directory,
                            model_urdf=args.mpc_root / "models/tiago_pro/tiago_pro.urdf",
                            default_scene=scene,
                            scene_builder=lambda replay, path: replay_scene(replay, path, args.mpc_root, scene))
    from source_settings import SourceSettings, restart_arguments
    restart_requested = threading.Event()
    def request_restart():
        restart_requested.set()
        server.shutdown()
    sources = SourceSettings(selection, visualizer_config.path, request_restart,
                             on_built=live.refresh_compiled if live is not None else None)
    from plot_service import PlotService
    plots = PlotService(args.mpc_root, visualizer_config.path, scene, live=live, replays=library)
    from solver_profiles import SolverProfiles
    profiles = (SolverProfiles(live, selection, visualizer_config.path, visualizer_config.solver_profiles)
                if live is not None else None)
    from solve_inspections import InspectionService
    inspections = InspectionService(plots, profiles, live=live) if profiles is not None else None
    plots.inspections = inspections
    from presentation_settings import PresentationSettings
    presentation = PresentationSettings(visualizer_config.path, live=live, initial=visualizer_config.presentation)
    server = make_server(scene, robot_xml, meshes, args.host, args.port, live=live, replays=library,
                         sources=sources, live_error=live_error, plots=plots, solver_profiles=profiles, inspections=inspections, presentation=presentation)
    server.replay_library = library
    server.visualizer_config = visualizer_config
    print(f"TIAGo visualizer: http://{args.host}:{server.server_port}", flush=True)
    print(f"Visualizer config: {visualizer_config.path}", flush=True)
    print(f"Ingest directory: {visualizer_config.ingest_directory} "
          "(recursive catalog updates when the browser polls)", flush=True)
    print(f"Browser uploads: {library.upload_directory}", flush=True)
    from runtime_files import runtime_directory, runtime_warning
    print(f"Runtime files (RAM-backed, current run only): {runtime_directory()}", flush=True)
    if (warning := runtime_warning()) is not None:
        print(f"WARNING: {warning}", file=sys.stderr, flush=True)
    print("Start pose only: upload or select a recording for replay", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        sources.close()
        if inspections is not None:
            inspections.close()
        plots.close()
        if live is not None:
            live.close()
        library.close()
    if restart_requested.is_set():
        environment = os.environ.copy()
        # Apply explicitly replaces source launch overrides. Numerical workers
        # inherit the newly selected cache after exec, and disk history stays.
        for key in ("TIAGO_MPC_ROOT", "TIAGO_PYTHON", "GATO_CACHE_DIR"):
            environment.pop(key, None)
        os.execve(sources.selection["python"], [sources.selection["python"],
                  *restart_arguments(sys.argv[1:] if argv is None else argv, visualizer_config.path)], environment)
    return 0


if __name__ == "__main__":
    sys.exit(main())
