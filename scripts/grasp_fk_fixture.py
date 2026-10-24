#!/usr/bin/env python3
"""Regenerate the CPU Pinocchio oracle for browser arm FK and its Jacobian.

Run with the selected tiago_mpc checkout's prepared Python interpreter:
  python_bin="$(python3 scripts/launch_python.py)"
  "$python_bin" scripts/grasp_fk_fixture.py
No compiled GATO module or GPU is loaded.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np
import pinocchio as pin

from live_mpc import import_tiago
from robot_frames import fixed_frame_spec
from server import RobotKinematics
from visualizer_config import DEFAULT_MPC_ROOT

SEED = 20261023
DESTINATION = ROOT / 'tests/fixtures/grasp_fk.json'


def build_fixture(mpc_root=None):
    """Reference values from the selected checkout, not a duplicated FK algorithm."""
    mpc_root = Path(mpc_root or os.environ.get('TIAGO_MPC_ROOT') or DEFAULT_MPC_ROOT).resolve()
    tiago = import_tiago(mpc_root)
    reduced = tiago.arm_urdf()
    model = pin.buildModelFromUrdf(str(reduced))
    data = model.createData()
    frame_id = model.getFrameId(tiago.GRASP_FRAME)
    kinematics = RobotKinematics(tiago.FULL_URDF, end_effector_frame=tiago.GRASP_FRAME, reduced_urdf=reduced)
    limits = tiago.limits()
    rng = np.random.default_rng(SEED)
    labelled = [('Q_START', np.asarray(tiago.Q_START)), ('Q_REACH', np.asarray(tiago.Q_REACH))]
    labelled.extend((f'random_{i:02}', q) for i, q in enumerate(rng.uniform(limits.lower, limits.upper, size=(64, 7))))
    for i in range(7):
        for label, bounds in [('lower', limits.lower), ('upper', limits.upper)]:
            q = np.array(tiago.Q_START, copy=True)
            q[i] = bounds[i]
            labelled.append((f'joint_{i+1}_{label}', q))
    world = kinematics.ee_positions([q for _, q in labelled])
    poses = []
    for (label, q), point in zip(labelled, world):
        jacobian = pin.computeFrameJacobian(model, data, q, frame_id, pin.LOCAL_WORLD_ALIGNED)[:3]
        poses.append(dict(label=label, q=q.tolist(), grasp_torso_m=tiago.fk(q).tolist(),
                          jacobian_torso=jacobian.tolist(), grasp_world_m=point.tolist()))
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=mpc_root, text=True).strip()
    digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return dict(tiago_mpc_commit=commit, full_urdf_sha256=digest(tiago.FULL_URDF),
                reduced_urdf_sha256=digest(reduced), frame=tiago.GRASP_FRAME, root_frame=tiago.ROOT_FRAME,
                joint_names=list(tiago.RIGHT_ARM_JOINTS), grasp=fixed_frame_spec(reduced, tiago.GRASP_FRAME),
                seed=SEED, lower=limits.lower.tolist(), upper=limits.upper.tolist(), poses=poses)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mpc-root', type=Path)
    parser.add_argument('--output', type=Path, default=DESTINATION)
    args = parser.parse_args()
    fixture = build_fixture(args.mpc_root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fixture, indent=2) + '\n')
    print(f'{len(fixture["poses"])} poses -> {args.output} ({fixture["tiago_mpc_commit"]})')
