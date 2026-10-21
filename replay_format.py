"""Portable TIAGo replay NPZ v1: native joints, explicit clocks and model hash.

Only the standard library and NumPy are needed to export or validate files.
No pickle, solver, GPU coordinates, or robot dynamics package is involved.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

import numpy as np

FORMAT = "tiago-replay"
VERSION = 1
JOINT_NAMES = tuple(f"arm_right_{i}_joint" for i in range(1, 8))
MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_TOTAL_SAMPLES = 200_000
MAX_PREDICTIONS = 1024
REFERENCE_FRAMES = ("base_footprint", "torso_lift_link")


class ReplayError(ValueError):
    """A replay cannot be interpreted faithfully."""


@dataclass(frozen=True)
class Reference:
    xyz: np.ndarray
    time_s: np.ndarray | None
    frame: str


@dataclass(frozen=True)
class Prediction:
    identifier: str
    label: str
    origin_time_s: float
    time_s: np.ndarray
    q: np.ndarray
    reference: Reference | None
    stats: dict
    qd_rad_s: np.ndarray | None = None
    torque_nm: np.ndarray | None = None
    torque_time_s: np.ndarray | None = None


@dataclass(frozen=True)
class Replay:
    metadata: dict
    time_s: np.ndarray
    q: np.ndarray
    reference: Reference | None
    predictions: tuple[Prediction, ...]
    qd_rad_s: np.ndarray | None = None
    torque_nm: np.ndarray | None = None
    torque_time_s: np.ndarray | None = None
    joint_limits: dict | None = None


def model_sha256(model_urdf):
    return hashlib.sha256(Path(model_urdf).read_bytes()).hexdigest()


def _finite_json(value, name):
    try:
        json.dumps(value, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise ReplayError(f"{name} must contain finite JSON values: {exc}") from exc


def _number(value, name, nonnegative=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value):
        raise ReplayError(f"{name} must be a finite number")
    if nonnegative and value < 0:
        raise ReplayError(f"{name} must be nonnegative")
    return float(value)


def _numeric(archive, key, shape=None):
    if not isinstance(key, str) or not key or key not in archive.files:
        raise ReplayError(f"Missing array: {key!r}")
    try:
        result = archive[key]
    except (ValueError, TypeError, OSError, EOFError) as exc:
        raise ReplayError(f"Cannot read array {key}: {exc}") from exc
    if result.dtype.kind not in "fiu":
        raise ReplayError(f"{key} must be a real numeric array, never an object/pickle")
    if shape is not None and result.shape != shape:
        raise ReplayError(f"{key}: expected shape {shape}, got {result.shape}")
    if not np.isfinite(result).all():
        raise ReplayError(f"{key} contains nonfinite values")
    return result.astype(float, copy=False)


def _times(archive, key, minimum=2):
    result = _numeric(archive, key)
    if result.ndim != 1 or len(result) < minimum:
        raise ReplayError(f"{key} must be a one-dimensional array with at least {minimum} sample(s)")
    if result[0] < 0 or not (np.diff(result) > 0).all():
        raise ReplayError(f"{key} must be nonnegative and strictly increasing; samples are never sorted or dropped")
    return result


def _reference(archive, xyz_key, time_key, frame):
    if xyz_key is None:
        if time_key is not None:
            raise ReplayError("Reference times require reference positions")
        return None
    if frame not in REFERENCE_FRAMES:
        raise ReplayError("Reference positions require explicit reference_frame: base_footprint or torso_lift_link")
    xyz = _numeric(archive, xyz_key)
    if time_key is None:
        if xyz.shape != (3,):
            raise ReplayError(f"Static {xyz_key} must have shape (3,); moving references require a time array")
        return Reference(xyz=xyz, time_s=None, frame=frame)
    times = _times(archive, time_key, minimum=1)
    if xyz.shape != (len(times), 3):
        raise ReplayError(f"{xyz_key}: expected shape ({len(times)}, 3), got {xyz.shape}")
    return Reference(xyz=xyz, time_s=times, frame=frame)


def _fixed_joints(value, model_urdf):
    if not isinstance(value, dict):
        raise ReplayError("fixed_joints must be an object mapping native joint names to radians/metres")
    joints = {j.get("name"): j for j in ET.parse(model_urdf).getroot().findall("joint")}
    for name, angle in value.items():
        if name in JOINT_NAMES:
            raise ReplayError(f"Animated right-arm joint cannot also be fixed: {name}")
        joint = joints.get(name)
        if joint is None or joint.get("type") not in ("revolute", "prismatic", "continuous"):
            raise ReplayError(f"Unknown or unsupported fixed context joint: {name}")
        _number(angle, f"fixed_joints.{name}")


def _telemetry(archive, times, order, qd_key=None, torque_key=None, torque_time_key=None):
    qd = None if qd_key is None else _numeric(archive, qd_key, (len(times), 7))[:, order]
    if torque_key is None:
        if torque_time_key is not None:
            raise ReplayError("Torque timestamps require a torque array")
        return qd, None, None
    stamps = times if torque_time_key is None else _times(archive, torque_time_key, minimum=1)
    if stamps[0] < times[0] or stamps[-1] > times[-1]:
        raise ReplayError("Torque timestamps must be within the trajectory time range")
    torque = _numeric(archive, torque_key, (len(stamps), 7))[:, order]
    return qd, torque, stamps


def normalize_joint_limits(value, order):
    if value is None:
        return None
    fields = ("lower_position_rad", "upper_position_rad", "velocity_rad_s", "effort_nm")
    if not isinstance(value, dict) or any(field not in value for field in fields):
        raise ReplayError("joint_limits requires lower_position_rad, upper_position_rad, velocity_rad_s and effort_nm")
    result = {}
    for field in fields:
        array = np.asarray(value[field])
        if array.dtype.kind not in "fiu" or array.shape != (7,) or not np.isfinite(array).all():
            raise ReplayError(f"joint_limits.{field} must contain seven finite real values")
        result[field] = array[order].astype(float).tolist()
    if (not (np.asarray(result["upper_position_rad"]) > result["lower_position_rad"]).all() or
            not (np.asarray(result["velocity_rad_s"]) > 0).all() or not (np.asarray(result["effort_nm"]) > 0).all()):
        raise ReplayError("joint_limits needs ordered position bounds and positive velocity/effort limits")
    source = value.get("source", "Recorded limits")
    if not isinstance(source, str) or not source.strip():
        raise ReplayError("joint_limits.source must be a nonempty string")
    result["source"] = source
    return result


def load_replay(source, *, model_urdf):
    """Load a path or seekable file, validate, and normalize joint ordering.

    Recorded samples are preserved, including finite joint-limit violations.
    Timing is never inferred from solver timings or synthesized from a dt.
    """
    try:
        if hasattr(source, "seek"):
            source.seek(0, os.SEEK_END)
            compressed_size = source.tell()
            source.seek(0)
        else:
            compressed_size = Path(source).stat().st_size
        if compressed_size > MAX_COMPRESSED_BYTES:
            raise ReplayError("Replay exceeds the 64 MiB compressed file limit")
        with zipfile.ZipFile(source) as container:
            members = container.infolist()
            names = [member.filename for member in members]
            if len(names) != len(set(names)):
                raise ReplayError("Replay archive contains duplicate array names")
            if len(members) > 4096 or sum(m.file_size for m in members) > MAX_UNCOMPRESSED_BYTES:
                raise ReplayError("Replay exceeds the 256 MiB expanded-array limit")
            if any(not n.endswith(".npy") or "/" in n or "\\" in n for n in names):
                raise ReplayError("Replay must contain only top-level NumPy arrays")
            # ZIP size limits alone do not bound an NPY header's claimed
            # allocation. Inspect each header before NumPy allocates its array.
            for member in members:
                with container.open(member) as stream:
                    version = np.lib.format.read_magic(stream)
                    if version == (1, 0):
                        shape, _, dtype = np.lib.format.read_array_header_1_0(stream)
                    elif version == (2, 0):
                        shape, _, dtype = np.lib.format.read_array_header_2_0(stream)
                    else:
                        raise ReplayError(f"Unsupported NPY array version: {version}")
                    if shape and shape[0] > MAX_TOTAL_SAMPLES:
                        raise ReplayError(f"Replay exceeds the {MAX_TOTAL_SAMPLES} sample display limit")
                    if member.filename == "metadata_json.npy" and member.file_size > 1024*1024:
                        raise ReplayError("Replay metadata exceeds the 1 MiB limit")
                    if dtype.hasobject:
                        raise ReplayError("Object/pickle arrays are not allowed in replays")
                    expected_bytes = math.prod(shape) * dtype.itemsize
                    if expected_bytes != member.file_size-stream.tell() or expected_bytes > MAX_UNCOMPRESSED_BYTES:
                        raise ReplayError(f"Array header size disagrees with its data: {member.filename}")
        if hasattr(source, "seek"):
            source.seek(0)
        with np.load(source, allow_pickle=False) as archive:
            if "metadata_json" not in archive.files:
                raise ReplayError("Missing metadata_json; expected tiago-replay NPZ v1")
            try:
                encoded = archive["metadata_json"]
                if encoded.shape != () or encoded.dtype.kind != "U":
                    raise ReplayError("metadata_json must be one Unicode JSON scalar")
                metadata = json.loads(str(encoded.item()))
            except (ValueError, TypeError) as exc:
                raise ReplayError(f"Invalid metadata_json: {exc}") from exc
            if not isinstance(metadata, dict):
                raise ReplayError("metadata_json must encode an object")
            _finite_json(metadata, "metadata_json")
            if "provenance" in metadata and not isinstance(metadata["provenance"], dict):
                raise ReplayError("provenance must be a JSON object")
            if metadata.get("format") != FORMAT or type(metadata.get("version")) is not int or metadata["version"] != VERSION:
                raise ReplayError("Unsupported replay format/version; expected tiago-replay version 1")
            names = metadata.get("joint_names")
            if (not isinstance(names, list) or any(not isinstance(n, str) for n in names) or
                    len(names) != 7 or len(set(names)) != 7 or set(names) != set(JOINT_NAMES)):
                raise ReplayError("joint_names must list each of the seven native right-arm joints exactly once")
            order = [names.index(name) for name in JOINT_NAMES]
            expected_hash = model_sha256(model_urdf)
            if metadata.get("model_sha256") != expected_hash:
                raise ReplayError(f"Robot model mismatch: replay model_sha256={metadata.get('model_sha256')!r}; "
                                  f"visualizer canonical full URDF={expected_hash}")
            if metadata.get("time_basis") not in ("simulation", "wall"):
                raise ReplayError("time_basis must explicitly be 'simulation' or 'wall'")
            if "label" in metadata and (not isinstance(metadata["label"], str) or not metadata["label"].strip()):
                raise ReplayError("label must be a nonempty string")
            if "end_effector_frame" in metadata and (not isinstance(metadata["end_effector_frame"], str)
                    or not metadata["end_effector_frame"].strip()):
                raise ReplayError("end_effector_frame must be a nonempty fixed-joint name")
            _fixed_joints(metadata.get("fixed_joints", {}), model_urdf)
            times = _times(archive, "time_s")
            q = _numeric(archive, "q", (len(times), 7))[:, order]
            qd, torque, torque_times = _telemetry(archive, times, order,
                "qd_rad_s" if "qd_rad_s" in archive.files else None,
                "torque_nm" if "torque_nm" in archive.files else None,
                "torque_time_s" if "torque_time_s" in archive.files else None)
            limits = normalize_joint_limits(metadata.get("joint_limits"), order)
            reference = _reference(archive, "reference_xyz_m" if "reference_xyz_m" in archive.files else None,
                                   "reference_time_s" if "reference_time_s" in archive.files else None,
                                   metadata.get("reference_frame"))
            predictions = metadata.get("predictions", [])
            if not isinstance(predictions, list):
                raise ReplayError("predictions must be a list of plan descriptors")
            if len(predictions) > MAX_PREDICTIONS:
                raise ReplayError(f"Replay exceeds the {MAX_PREDICTIONS} prediction display limit")
            total_samples = len(times) + (0 if reference is None else len(np.atleast_2d(reference.xyz)))
            plans = []
            identifiers = set()
            for index, descriptor in enumerate(predictions):
                if not isinstance(descriptor, dict):
                    raise ReplayError(f"Prediction {index} descriptor must be an object")
                identifier = descriptor.get("id", f"prediction-{index}")
                label = descriptor.get("label", f"Prediction {index + 1}")
                if (not isinstance(identifier, str) or not identifier or identifier in identifiers or
                        identifier == "recorded" or not isinstance(label, str) or not label.strip()):
                    raise ReplayError(f"Prediction {index} needs a unique id and nonempty label")
                identifiers.add(identifier)
                origin = _number(descriptor.get("origin_time_s"), f"Prediction {index} origin_time_s", nonnegative=True)
                plan_times = _times(archive, descriptor.get("time_key"))
                plan_q = _numeric(archive, descriptor.get("q_key"), (len(plan_times), 7))[:, order]
                plan_qd, plan_torque, plan_torque_times = _telemetry(archive, plan_times, order,
                    descriptor.get("qd_key"), descriptor.get("torque_key"), descriptor.get("torque_time_key"))
                plan_reference = _reference(archive, descriptor.get("reference_xyz_key"),
                                            descriptor.get("reference_time_key"),
                                            descriptor.get("reference_frame", metadata.get("reference_frame")))
                stats = descriptor.get("stats", {})
                if not isinstance(stats, dict):
                    raise ReplayError(f"Prediction {index} stats must be a JSON object")
                total_samples += len(plan_times) + (0 if plan_reference is None else len(np.atleast_2d(plan_reference.xyz)))
                if total_samples > MAX_TOTAL_SAMPLES:
                    raise ReplayError(f"Replay exceeds the {MAX_TOTAL_SAMPLES} total sample display limit")
                plans.append(Prediction(identifier, label, origin, plan_times, plan_q, plan_reference, stats,
                                        plan_qd, plan_torque, plan_torque_times))
            if total_samples > MAX_TOTAL_SAMPLES:
                raise ReplayError(f"Replay exceeds the {MAX_TOTAL_SAMPLES} total sample display limit")
            return Replay(metadata, times, q, reference, tuple(plans), qd, torque, torque_times, limits)
    except ReplayError:
        raise
    except (OSError, ValueError, TypeError, KeyError, EOFError, zipfile.BadZipFile, ET.ParseError, RuntimeError, NotImplementedError) as exc:
        raise ReplayError(f"Cannot read replay: {exc}") from exc

