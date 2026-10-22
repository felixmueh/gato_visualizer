"""Visualizer selection of unchanged upstream plant/predictor loss helpers."""
from copy import deepcopy
import hashlib
import importlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

DEFAULT_FRICTION = dict(simulation=True, prediction=True, predictor_smoothing_rad_s=.03)


def validate_friction(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_FRICTION):
        raise ValueError('friction requires simulation, prediction and predictor_smoothing_rad_s')
    if not all(type(value[key]) is bool for key in ('simulation', 'prediction')):
        raise ValueError('Friction switches must be booleans')
    width = value['predictor_smoothing_rad_s']
    if isinstance(width, bool) or not isinstance(width, (int, float)) or not math.isfinite(width) or not .001 <= width <= 1:
        raise ValueError('Predictor smoothing must be within [.001, 1] rad/s')
    return deepcopy(value)


def canonical_losses(mpc_root):
    """Reuse exact source provenance so the upstream generated model key matches."""
    root = Path(mpc_root)
    config_path = root/'configs/tracking.json'
    urdf_path = root/'models/tiago_right/tiago_right_arm.urdf'
    losses = deepcopy(json.loads(config_path.read_text())['joint_dynamics'])
    joint_dynamics = importlib.import_module('tiago_mpc.joint_dynamics')
    joint_dynamics.validate(losses)
    joints = {joint.get('name'): joint for joint in ET.parse(urdf_path).iter('joint')}
    for index in range(7):
        dynamics = joints[f'arm_right_{index+1}_joint'].find('dynamics')
        if dynamics is None or (float(dynamics.get('friction', '0')) != losses['coulomb_nm'][index]
                                or float(dynamics.get('damping', '0')) != losses['viscous_nm_s_per_rad'][index]):
            raise ValueError('Selected tracking loss coefficients differ from the canonical right-arm URDF')
    # Sources with the stick/slip plant step get it; sign(v) with explicit RK4
    # diverges for the light wrist at the default 1 ms step.
    losses['model'] = getattr(joint_dynamics, 'STICK_SLIP', 'coulomb_sign_viscous')
    return losses, dict(configuration_path=str(config_path),
        configuration_sha256=hashlib.sha256(config_path.read_bytes()).hexdigest(),
        urdf_path=str(urdf_path), urdf_sha256=hashlib.sha256(urdf_path.read_bytes()).hexdigest(),
        armature_runtime='inactive; metadata only')


def prediction_losses(mpc_root, width=.03):
    losses, _ = canonical_losses(mpc_root)
    return dict(losses, model='coulomb_tanh_viscous', smoothing_rad_s=width)


def load_configuration(path, mpc_root):
    """Resolve numerical settings without writing or changing upstream sources.

    Explicit captured joint_dynamics remains supported for cold inspections;
    absent visualizer switches otherwise retain the historical loss-free mode.
    """
    settings = json.loads(Path(path).read_text())
    if 'friction' not in settings:
        selected, original, effective = importlib.import_module('reaching_config').load_configuration(path)
        effective['simulator_joint_dynamics'] = deepcopy(original.get('joint_dynamics'))
        return selected, original, effective
    selection = validate_friction(settings['friction'])
    numerical = {key:value for key,value in settings.items() if key != 'friction'}
    effective = importlib.import_module('tiago_mpc.configuration').resolve_configuration(numerical)
    losses, source = canonical_losses(mpc_root)
    effective.update(friction=selection, friction_source=source,
        simulator_joint_dynamics=deepcopy(losses) if selection['simulation'] else None,
        prediction_joint_dynamics=(dict(losses, model='coulomb_tanh_viscous',
            smoothing_rad_s=selection['predictor_smoothing_rad_s']) if selection['prediction'] else None))
    return Path(path), settings, effective
