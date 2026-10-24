"""Fixed application frames shared by display kinematics and the Live schema.

The grasp frame belongs to tiago_mpc's derived arm URDF. Its origin is local
to a link of the canonical full display model, not a world-space offset.
"""
from __future__ import annotations

import math
import xml.etree.ElementTree as ET


def fixed_frame_spec(urdf, frame):
    """Read a fixed joint's parent link and local origin, without loading a solver."""
    if not isinstance(frame, str) or not frame.strip():
        raise ValueError("end_effector_frame must be a nonempty fixed-joint name")
    joint = next((joint for joint in ET.parse(urdf).getroot().findall("joint")
                  if joint.get("name") == frame), None)
    if joint is None or joint.get("type") != "fixed":
        raise ValueError(f"Missing fixed end-effector frame: {frame}")
    parent = joint.find("parent")
    parent_link = None if parent is None else parent.get("link")
    if not parent_link or not parent_link.strip():
        raise ValueError(f"Missing parent link for end-effector frame: {frame}")
    origin = joint.find("origin")
    attributes = {} if origin is None else origin.attrib
    result = dict(frame=frame, parent_link=parent_link)
    for key in ("xyz", "rpy"):
        try:
            values = [float(value) for value in attributes.get(key, "0 0 0").split()]
        except ValueError as error:
            raise ValueError(f"End-effector {key} must contain three finite values: {frame}") from error
        if len(values) != 3 or not all(math.isfinite(value) for value in values):
            raise ValueError(f"End-effector {key} must contain three finite values: {frame}")
        result[key] = values
    return result
