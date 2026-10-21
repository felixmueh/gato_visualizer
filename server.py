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
from pathlib import Path
import sys
from urllib.parse import parse_qs, unquote, urlsplit
import xml.etree.ElementTree as ET

import numpy as np
import pinocchio as pin

from visualizer_config import DEFAULT_CONFIG, load_visualizer_config
from replay_format import normalize_joint_limits

ROOT = Path(__file__).resolve().parent
JOINT_NAMES = [f"arm_right_{i}_joint" for i in range(1, 8)]
# Native left-arm joint values chosen from the canonical left chain for a bent
# resting display pose. These are visual context, not a dynamics symmetry rule.
LEFT_ARM_REST_RAD = (0.39, -1.73, 0.38, -2.35, 0.0, -1.21, -0.04)
FIXED_DISPLAY_JOINTS = {f"arm_left_{i}_joint": angle
                        for i, angle in enumerate(LEFT_ARM_REST_RAD, 1)}
DEFAULT_RUN = Path("_expr_data/canonical-model-correction-20261020/default-smoke")


class SourceError(ValueError):
    """A source recording cannot be represented faithfully."""


class NoRecordingError(SourceError):
    """Autodiscovery found no recording; canonical starting context is available."""


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


def add_telemetry(item, qd=None, torque=None, torque_times=None, kind="applied"):
    if qd is not None:
        item["qd_rad_s"] = np.asarray(qd).tolist()
    if torque is not None:
        item.update(torque_nm=np.asarray(torque).tolist(), torque_kind=kind,
                    torque_time_s=np.asarray(torque_times).tolist())
        if kind == "predicted":
            item["torque_end_time_s"] = item["time_s"][-1]
    return item


def discover_run(mpc_root):
    preferred = mpc_root / DEFAULT_RUN
    if (preferred / "trajectory.npz").is_file() and (preferred / "summary.json").is_file():
        return preferred
    candidates = [p.parent for p in (mpc_root / "_expr_data").rglob("trajectory.npz")
                  if (p.parent / "summary.json").is_file()]
    if not candidates:
        raise NoRecordingError(f"No recorded trajectory found under {mpc_root / '_expr_data'}; use --run-dir")
    return max(candidates, key=lambda p: (p / "trajectory.npz").stat().st_mtime_ns)


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
            reduced_urdf = reduced_urdf or Path(urdf).parents[1] / "tiago_right/tiago_right_arm.urdf"
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


def read_json(path):
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise SourceError(f"Cannot read {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SourceError(f"Expected an object in {path}")
    return value


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


def load_bootstrap_scene(mpc_root):
    """Show an honest starting pose when no legacy recording is available."""
    robot_xml, assets, fixed_joints, world_frame = canonical_model_assets(mpc_root)
    starting_right_rad = (-.39, -1.73, -.38, -2.35, 0.0, -1.21, .04)
    fixed_joints.update(zip(JOINT_NAMES, starting_right_rad))
    urdf = Path(mpc_root) / "models/tiago_pro/tiago_pro.urdf"
    scene = dict(robot_url="/assets/robot.urdf", joint_names=JOINT_NAMES,
                 joint_limits=canonical_joint_limits(urdf),
                 fixed_joints=fixed_joints, world_frame=world_frame, up_axis="Z",
                 end_effector_frame="arm_right_tool_joint", trajectories=[],
                 source=dict(mpc_root=str(Path(mpc_root).resolve()), bootstrap=True,
                             label="Starting pose — upload or select a recording",
                             full_urdf_sha256=sha256(urdf), files_sha256={}))
    return scene, robot_xml, assets


def load_scene(mpc_root, run_dir=None):
    """Load immutable source files and return JSON data plus allowed assets."""
    mpc_root = Path(mpc_root).expanduser().resolve()
    urdf = mpc_root / "models/tiago_pro/tiago_pro.urdf"
    if not urdf.is_file():
        raise SourceError(f"Canonical full robot model is missing: {urdf}")
    if run_dir is None:
        try:
            run_dir = discover_run(mpc_root)
        except NoRecordingError:
            return load_bootstrap_scene(mpc_root)
    else:
        run_dir = Path(run_dir).expanduser().resolve()
    summary = read_json(run_dir / "summary.json")
    if summary.get("joint_names") != JOINT_NAMES:
        raise SourceError("Recording joint_names do not match the seven native right-arm joints")
    target = finite_array(summary.get("target_m"), "summary target_m", (3,))
    dt = float(summary.get("dt_s", 0))
    knots = summary.get("N", 0)
    if not np.isfinite(dt) or dt <= 0:
        raise SourceError("Recording dt_s must be finite and positive")
    end_effector_frame = summary.get("end_effector_frame", "arm_right_tool_joint")
    kinematics = RobotKinematics(urdf, end_effector_frame=end_effector_frame)
    target_world = kinematics.target_to_world(target).tolist()
    try:
        with np.load(run_dir / "trajectory.npz", allow_pickle=False) as data:
            times = finite_array(data["time_s"], "recorded time_s")
            if times.ndim != 1 or len(times) < 2:
                raise SourceError("Recorded trajectory must contain at least two timestamps")
            if times[0] < 0 or not (np.diff(times) > 0).all():
                raise SourceError("Recorded timestamps must be nonnegative and strictly increasing")
            states = finite_array(data["state"], "recorded state", (len(times), 14))
            applied = (finite_array(data["applied_torque_nm"], "recorded applied_torque_nm", (len(times)-1, 7))
                       if "applied_torque_nm" in data.files else None)
    except (OSError, KeyError, ValueError) as exc:
        raise SourceError(f"Cannot load recorded trajectory from {run_dir}: {exc}") from exc

    def trajectory(identifier, label, kind, time_s, q, metadata):
        return dict(id=identifier, label=label, kind=kind,
                    time_s=time_s.tolist(), q=q.tolist(),
                    ee_xyz=kinematics.ee_positions(q).tolist(),
                    target_xyz=target_world, metadata=metadata)

    recorded_metadata = {key: summary[key] for key in (
        "status", "mode", "timing", "orientation", "collisions", "reached",
        "limits_pass", "final_distance_m", "solve_time_median_ms", "solver_params",
        "admm_effective", "dt_s", "N") if key in summary}
    recorded_metadata.update(coordinates="native", source_file="trajectory.npz")
    trajectories = [trajectory("recorded", "Recorded MPC motion", "recorded",
                               times, states[:, :7], recorded_metadata)]
    add_telemetry(trajectories[0], states[:, 7:], applied, times[:-1])
    source_files = [run_dir / "trajectory.npz", run_dir / "summary.json"]
    for index, plan in enumerate(sorted(run_dir.glob("plan_[0-9][0-9][0-9][0-9].npz"))):
        try:
            with np.load(plan, allow_pickle=False) as data:
                q, qd, torque = decode_prediction_telemetry(data["xu"], data["signs"], knots)
                reference = finite_array(data["reference"], "plan reference", (int(knots), 6))
                if not np.allclose(reference[:, :3], target, atol=1e-7, rtol=1e-6):
                    raise SourceError("Plan has a moving/different target; this MVP supports fixed-target reaches")
                # The saved plan's initial state is native, unlike its GPU XU.
                initial = finite_array(data["state"], "plan initial state", (14,))
                initial_delta = float(np.max(np.abs(q[0] - initial[:7])))
        except (OSError, KeyError, ValueError) as exc:
            raise SourceError(f"Cannot decode {plan}: {exc}") from exc
        step = int(plan.stem.split("_")[1])
        trajectories.append(trajectory(f"prediction-{index}", f"Prediction {index + 1}", "prediction",
                                       np.arange(int(knots)) * dt, q,
                                       dict(source_file=plan.name, controller_step=step,
                                            recorded_start_s=step * dt, dt_s=dt, N=int(knots),
                                            initial_q_difference_rad=initial_delta,
                                            coordinates="native, decoded from GPU signs")))
        add_telemetry(trajectories[-1], qd, torque, np.arange(int(knots)-1)*dt, kind="predicted")
        source_files.append(plan)

    robot_xml, assets, fixed_joints, world_frame = canonical_model_assets(mpc_root)
    scene = dict(robot_url="/assets/robot.urdf", joint_names=JOINT_NAMES,
                 joint_limits=(normalize_joint_limits(summary.get("raw_limits"), list(range(7)))
                               or canonical_joint_limits(urdf)),
                 fixed_joints=fixed_joints, world_frame=world_frame,
                 up_axis="Z", end_effector_frame=end_effector_frame,
                 source=dict(mpc_root=str(mpc_root), run_dir=str(run_dir),
                             repository_commit=summary.get("repository_commit"),
                             gato_commit=summary.get("gato_commit"),
                             full_urdf_sha256=sha256(urdf),
                             recorded_urdf_sha256=summary.get("urdf_sha256"),
                             files_sha256={p.name: sha256(p) for p in source_files}),
                 trajectories=trajectories)
    # Reject nonfinite summary metadata too, before any HTTP response is served.
    try:
        json.dumps(scene, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise SourceError(f"Recording metadata is not finite JSON: {exc}") from exc
    return scene, robot_xml, assets


def replay_scene(replay, path, mpc_root, base_scene):
    """Convert a portable native replay into the existing browser scene shape."""
    fixed = {name: value for name, value in base_scene["fixed_joints"].items() if name not in JOINT_NAMES}
    fixed.update(replay.metadata.get("fixed_joints", {}))
    end_effector_frame = replay.metadata.get("end_effector_frame", "arm_right_tool_joint")
    kinematics = RobotKinematics(Path(mpc_root) / "models/tiago_pro/tiago_pro.urdf", fixed_joints=fixed,
                                 end_effector_frame=end_effector_frame)

    def world_points(reference):
        points = np.atleast_2d(reference.xyz)
        if reference.frame == "torso_lift_link":
            return np.asarray([kinematics.target_to_world(point) for point in points])
        return points

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
    if "provenance" in replay.metadata:
        result["source"]["provenance"] = deepcopy(replay.metadata["provenance"])
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
                replays=None):
    dist = Path(dist or ROOT / "dist").resolve()
    scene_json = json.dumps(scene, allow_nan=False, separators=(",", ":")).encode()

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

        def do_HEAD(self):
            self.do_GET()

        def do_POST(self):
            if urlsplit(self.path).path == "/api/replays/upload" and replays is not None:
                self.upload_replay()
                return
            if urlsplit(self.path).path != "/api/live/command" or live is None:
                self.send_error(404)
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
            if path == "/api/scene":
                self.send_payload(scene_json, "application/json; charset=utf-8")
            elif path == "/api/replays" and replays is not None:
                self.send_payload(json.dumps(replays.catalog(), allow_nan=False).encode(),
                                  "application/json; charset=utf-8")
            elif path == "/api/replays/scene" and replays is not None:
                try:
                    query = parse_qs(urlsplit(self.path).query)
                    if set(query) != {"id"} or len(query["id"]) != 1:
                        raise ValueError("Select one recording with its catalog id")
                    selected = replays.scene(query["id"][0])
                    self.send_payload(json.dumps(selected, allow_nan=False).encode(),
                                      "application/json; charset=utf-8")
                except (KeyError, ValueError, OSError) as exc:
                    status = 404 if isinstance(exc, KeyError) else 400
                    self.send_payload(json.dumps(dict(error=str(exc))).encode(),
                                      "application/json; charset=utf-8", status)
            elif path == "/api/health":
                self.send_payload(json.dumps(dict(status="ok", trajectories=len(scene["trajectories"]))).encode(),
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
                    payload = live.history(int(query["generation"][0]),
                                           int(query.get("after", ["0"])[0]),
                                           int(query.get("limit", ["256"])[0]))
                    status = 200
                except (ValueError, TypeError) as exc:
                    status = 409 if isinstance(exc, HistoryGenerationError) else 400
                    payload = dict(error=str(exc), generation=live.generation)
                self.send_payload(json.dumps(payload, allow_nan=False, separators=(",", ":")).encode(),
                                  "application/json; charset=utf-8", status, compress=True)
            elif path == "/api/live/events" and live is not None:
                self.live_events()
            elif path == "/assets/robot.urdf":
                self.send_payload(robot_xml, "application/xml; charset=utf-8")
            elif path in mesh_assets:
                self.send_payload(mesh_assets[path].read_bytes(), "model/stl")
            elif path.startswith(("/api/", "/assets/meshes/")):
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
                        default=Path(os.environ.get("TIAGO_MPC_ROOT", ROOT.parent / "tiago_mpc")))
    parser.add_argument("--run-dir", type=Path, help="Existing reaching recording directory (read only)")
    parser.add_argument("--host", default="127.0.0.1", help="Use 0.0.0.0 to view over your local network")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--replay-only", action="store_true", help="Disable all live solver work")
    args = parser.parse_args(argv)
    try:
        visualizer_config = load_visualizer_config(args.config)
    except ValueError as exc:
        parser.exit(1, f"Config error: {exc}\n")
    try:
        scene, robot_xml, meshes = load_scene(args.mpc_root, args.run_dir)
    except (SourceError, OSError, RuntimeError) as exc:
        parser.exit(1, f"Source error: {exc}\n")
    live = None
    if not args.replay_only:
        from live_mpc import LiveService
        try:
            live = LiveService(args.mpc_root)
        except (ValueError, OSError, RuntimeError) as exc:
            parser.exit(1, f"Live setup error: {exc}\n")
    from replay_library import ReplayLibrary
    library = ReplayLibrary(ingest_directory=visualizer_config.ingest_directory,
                            model_urdf=args.mpc_root / "models/tiago_pro/tiago_pro.urdf",
                            default_scene=scene,
                            scene_builder=lambda replay, path: replay_scene(replay, path, args.mpc_root, scene))
    server = make_server(scene, robot_xml, meshes, args.host, args.port, live=live, replays=library)
    server.replay_library = library
    server.visualizer_config = visualizer_config
    print(f"TIAGo visualizer: http://{args.host}:{server.server_port}", flush=True)
    print(f"Visualizer config: {visualizer_config.path}", flush=True)
    print(f"Ingest directory: {visualizer_config.ingest_directory} "
          "(recursive catalog updates when the browser polls)", flush=True)
    print(f"Browser uploads: {library.upload_directory}", flush=True)
    if scene["source"].get("bootstrap"):
        print("Starting pose only: upload or select a recording for replay", flush=True)
    else:
        print(f"Read-only recording: {scene['source']['run_dir']}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if live is not None:
            live.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
