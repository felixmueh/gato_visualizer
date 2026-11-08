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
# A default figure eight has 2400 plans of five arrays each; the total sample
# limit still bounds the work per plan.
MAX_PREDICTIONS = 10_000
MAX_ARRAYS = 65_536
# NumPy stores the JSON as UCS-4, four bytes per character (about 0.8 KiB per plan).
MAX_METADATA_BYTES = 16 * 1024 * 1024
REFERENCE_FRAMES = ("base_footprint", "torso_lift_link")


class ReplayError(ValueError):
    """A replay cannot be interpreted faithfully."""


class _Arrays(dict):
    """The NPZ's arrays by name, read in the pass that checks their headers.

    NumPy's NpzFile finds each member by searching a list, which took seconds
    for a long recording's ~12,000 arrays; reading here is one pass, unpickled.
    """
    @property
    def files(self):
        return self.keys()


@dataclass(frozen=True)
class Reference:
    xyz: np.ndarray
    time_s: np.ndarray | None
    frame: str
    # The end effector's target orientation per sample, rotation vectors in frame;
    # NaN rows: no orientation target there. None: no orientation in the recording.
    rotvec: np.ndarray | None = None


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
    # Recorded and displayed full-URDF hashes when they differ; None when equal.
    model_warning: dict | None = None


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


def _rotvec(archive, key, shape):
    """Reference orientations: the positions' shape, each row three finite values or three NaN."""
    if key is None:
        return None
    if key not in archive.files:
        raise ReplayError(f"Missing array: {key!r}")
    result = archive[key]
    if result.dtype.kind not in "fiu" or result.shape != shape:
        raise ReplayError(f"{key}: expected a real array of shape {shape}")
    result = result.astype(float, copy=False)
    if not (np.isfinite(result).all(axis=-1) | np.isnan(result).all(axis=-1)).all():
        raise ReplayError(f"{key}: each orientation is three finite values or three NaN (none)")
    return result


def _reference(archive, xyz_key, time_key, frame, rotvec_key=None):
    if xyz_key is None:
        if time_key is not None or rotvec_key is not None:
            raise ReplayError("Reference times and orientations require reference positions")
        return None
    if frame not in REFERENCE_FRAMES:
        raise ReplayError("Reference positions require explicit reference_frame: base_footprint or torso_lift_link")
    xyz = _numeric(archive, xyz_key)
    if time_key is None:
        if xyz.shape != (3,):
            raise ReplayError(f"Static {xyz_key} must have shape (3,); moving references require a time array")
        return Reference(xyz=xyz, time_s=None, frame=frame, rotvec=_rotvec(archive, rotvec_key, (3,)))
    times = _times(archive, time_key, minimum=1)
    if xyz.shape != (len(times), 3):
        raise ReplayError(f"{xyz_key}: expected shape ({len(times)}, 3), got {xyz.shape}")
    return Reference(xyz=xyz, time_s=times, frame=frame, rotvec=_rotvec(archive, rotvec_key, xyz.shape))


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


def _spheres(value, name):
    if (not isinstance(value, list) or any(not isinstance(s, list) or len(s) != 4 for s in value)
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for s in value for v in s)
            or any(s[3] <= 0 for s in value)):
        raise ReplayError(f"{name} must be a list of spheres [x, y, z, radius] with finite values and positive radii")


# Further obstacles (tiago_mpc.collision.Collision's layouts): row width and the columns
# that are sizes (positive): capsules (ax, ay, az, bx, by, bz, r), boxes (cx, cy, cz, qx,
# qy, qz, qw, hx, hy, hz), planes (nx, ny, nz, d) with a nonzero normal.
OBSTACLE_SHAPES = {"obstacle_capsules": (7, (6,)), "obstacle_boxes": (10, (7, 8, 9)), "obstacle_planes": (4, ())}
# The body cover's capsules and boxes of an MPC's collision rows, in the same layouts.
BODY_SHAPES = {"body_capsules": (7, (6,)), "body_boxes": (10, (7, 8, 9))}


def _primitives(value, name, width, sizes):
    if (not isinstance(value, list) or any(not isinstance(row, list) or len(row) != width for row in value)
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for row in value for v in row)
            or any(row[i] <= 0 for row in value for i in sizes)
            or (name in ("obstacle_boxes", "body_boxes") and any(math.hypot(*row[3:7]) < 1e-9 for row in value))
            or (name == "obstacle_planes" and any(math.hypot(*row[:3]) < 1e-9 for row in value))):
        raise ReplayError(f"{name} must be a list of rows of {width} finite values with positive sizes")


def _collision(metadata, model_urdf):
    """Optional obstacles (spheres, capsules, boxes, planes), collision_spheres and the body
    cover's capsules and boxes: in torso_lift_link, the arm's in its links' frames, whose
    names the displayed model must have."""
    if "obstacles" in metadata:
        _spheres(metadata["obstacles"], "obstacles")
    for name, (width, sizes) in {**OBSTACLE_SHAPES, **BODY_SHAPES}.items():
        if name in metadata:
            _primitives(metadata[name], name, width, sizes)
    if "collision_spheres" not in metadata:
        return
    value = metadata["collision_spheres"]
    if not isinstance(value, dict) or set(value) != {"environment", "arm"} or not isinstance(value["arm"], dict):
        raise ReplayError("collision_spheres must be an object with environment and arm")
    _spheres(value["environment"], "collision_spheres.environment")
    links = {link.get("name") for link in ET.parse(model_urdf).getroot().findall("link")}
    for link, spheres in value["arm"].items():
        if link not in links:
            raise ReplayError(f"collision_spheres.arm names a link the model does not have: {link}")
        _spheres(spheres, f"collision_spheres.arm.{link}")


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
            if len(members) > MAX_ARRAYS:
                raise ReplayError(f"Replay exceeds the {MAX_ARRAYS} array limit")
            if sum(m.file_size for m in members) > MAX_UNCOMPRESSED_BYTES:
                raise ReplayError("Replay exceeds the 256 MiB expanded-array limit")
            if any(not n.endswith(".npy") or "/" in n or "\\" in n for n in names):
                raise ReplayError("Replay must contain only top-level NumPy arrays")
            # ZIP size limits alone do not bound an NPY header's claimed
            # allocation. Inspect each header before NumPy allocates its array.
            archive = _Arrays()
            for member in members:
                with container.open(member) as stream:
                    version = np.lib.format.read_magic(stream)
                    if version == (1, 0):
                        shape, fortran_order, dtype = np.lib.format.read_array_header_1_0(stream)
                    elif version == (2, 0):
                        shape, fortran_order, dtype = np.lib.format.read_array_header_2_0(stream)
                    else:
                        raise ReplayError(f"Unsupported NPY array version: {version}")
                    if shape and shape[0] > MAX_TOTAL_SAMPLES:
                        raise ReplayError(f"Replay exceeds the {MAX_TOTAL_SAMPLES} sample display limit")
                    if member.filename == "metadata_json.npy" and member.file_size > MAX_METADATA_BYTES:
                        raise ReplayError("Replay metadata exceeds the 16 MiB limit")
                    if dtype.hasobject:
                        raise ReplayError("Object/pickle arrays are not allowed in replays")
                    expected_bytes = math.prod(shape) * dtype.itemsize
                    if expected_bytes != member.file_size-stream.tell() or expected_bytes > MAX_UNCOMPRESSED_BYTES:
                        raise ReplayError(f"Array header size disagrees with its data: {member.filename}")
                    data = bytearray(stream.read(expected_bytes))
                    if len(data) != expected_bytes:
                        raise ReplayError(f"Array data is truncated: {member.filename}")
                    archive[member.filename.removesuffix(".npy")] = np.frombuffer(data, dtype).reshape(
                        shape, order="F" if fortran_order else "C")
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
        recorded_hash = metadata.get("model_sha256")
        if not isinstance(recorded_hash, str) or not recorded_hash:
            raise ReplayError("model_sha256 must identify the recording's full URDF")
        # The hash covers raw file bytes, so comment or dynamics edits change
        # it too. Joint names, fixed joints and frames are checked against
        # the displayed model; a different file only produces a warning.
        expected_hash = model_sha256(model_urdf)
        model_warning = None if recorded_hash == expected_hash else dict(
            recorded_model_sha256=recorded_hash, current_model_sha256=expected_hash)
        if metadata.get("time_basis") not in ("simulation", "wall"):
            raise ReplayError("time_basis must explicitly be 'simulation' or 'wall'")
        if "label" in metadata and (not isinstance(metadata["label"], str) or not metadata["label"].strip()):
            raise ReplayError("label must be a nonempty string")
        if "end_effector_frame" in metadata and (not isinstance(metadata["end_effector_frame"], str)
                or not metadata["end_effector_frame"].strip()):
            raise ReplayError("end_effector_frame must be a nonempty fixed-joint name")
        _fixed_joints(metadata.get("fixed_joints", {}), model_urdf)
        _collision(metadata, model_urdf)
        times = _times(archive, "time_s")
        q = _numeric(archive, "q", (len(times), 7))[:, order]
        qd, torque, torque_times = _telemetry(archive, times, order,
            "qd_rad_s" if "qd_rad_s" in archive.files else None,
            "torque_nm" if "torque_nm" in archive.files else None,
            "torque_time_s" if "torque_time_s" in archive.files else None)
        limits = normalize_joint_limits(metadata.get("joint_limits"), order)
        reference = _reference(archive, "reference_xyz_m" if "reference_xyz_m" in archive.files else None,
                               "reference_time_s" if "reference_time_s" in archive.files else None,
                               metadata.get("reference_frame"),
                               "reference_rotvec_rad" if "reference_rotvec_rad" in archive.files else None)
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
        return Replay(metadata, times, q, reference, tuple(plans), qd, torque, torque_times, limits,
                      model_warning)
    except ReplayError:
        raise
    except (OSError, ValueError, TypeError, KeyError, EOFError, zipfile.BadZipFile, ET.ParseError, RuntimeError, NotImplementedError) as exc:
        raise ReplayError(f"Cannot read replay: {exc}") from exc

