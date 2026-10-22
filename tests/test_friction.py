"""CPU-only independent plant/predictor laws and retained configuration checks."""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np

from execution_session import DEFAULT_EXECUTION, MultirateSession
from friction_settings import DEFAULT_FRICTION, canonical_losses, load_configuration, validate_friction
from inspection_problem import configuration_overrides
from live_mpc import MPCAdapter, import_mpc, parameter_specs, validate_settings
from tests.test_execution import FakeAdapter, fake_schema

ROOT = Path(__file__).resolve().parents[2]/'tiago_mpc_vis_baseline'


class FrictionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reach, cls.configuration = import_mpc(ROOT)
        _, cls.base, _ = cls.configuration.load_configuration()
        cls.base = {k:v for k,v in cls.base.items() if k in ('N','dt_s','solver_params','controller','limit_bounds')}

    def resolve(self, value):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'config.json'
            path.write_text(json.dumps(value))
            return load_configuration(path, ROOT)[2]

    def test_independent_modes_use_canonical_source_and_keep_numerical_settings(self):
        losses, source = canonical_losses(ROOT)
        baseline = self.resolve(self.base)
        self.assertIsNone(baseline['prediction_joint_dynamics'])
        self.assertIsNone(baseline['simulator_joint_dynamics'])
        self.assertTrue(DEFAULT_FRICTION['simulation'])
        self.assertTrue(DEFAULT_FRICTION['prediction'])
        for sim in (False,True):
            for pred in (False,True):
                effective = self.resolve(dict(self.base,friction=dict(simulation=sim,prediction=pred,predictor_smoothing_rad_s=.07)))
                self.assertEqual(effective['simulator_joint_dynamics'],losses if sim else None)
                self.assertEqual(effective['prediction_joint_dynamics'],dict(losses,model='coulomb_tanh_viscous',smoothing_rad_s=.07) if pred else None)
                self.assertEqual(effective['friction_source'],source)
                self.assertEqual(effective['solver_params'],baseline['solver_params'])
                self.assertEqual(effective['controller'],baseline['controller'])
                self.assertEqual(effective['limit_bounds'],baseline['limit_bounds'])

    def test_explicit_upstream_losses_apply_to_plant_and_predictor(self):
        losses, _ = canonical_losses(ROOT)
        resolved = self.resolve(dict(self.base,joint_dynamics=losses,predictor_smoothing_rad_s=.03))
        self.assertEqual(resolved['simulator_joint_dynamics'],losses)
        self.assertEqual(resolved['prediction_joint_dynamics'],dict(losses,model='coulomb_tanh_viscous',smoothing_rad_s=.03))

    def test_remote_profile_horizons_never_trigger_simulator_cache_discovery(self):
        from live_mpc import build_schema
        with patch('source_runtime.discover_compatible_modules',side_effect=AssertionError('Simulator cache inspected')):
            schema = build_schema(ROOT,available_n_by_friction=dict(off=[16],on=[64]),
                                  predictor_friction=dict(source={'mpc_root':'different-predictor'}))
        self.assertEqual(schema['available_N'],[16,64])
        self.assertEqual(schema['available_N_by_friction'],dict(off=[16],on=[64]))
        self.assertEqual(schema['friction']['predictor']['source']['mpc_root'],'different-predictor')
        self.assertEqual(schema['friction']['source']['urdf_path'],str(ROOT/'models/tiago_right/tiago_right_arm.urdf'))
        self.assertEqual(set(schema['defaults']['config']),{'N','dt_s','solver_params','controller','limit_bounds','friction'})

    def test_invalid_width_switches_and_mode_horizon_are_rejected(self):
        for change in (dict(simulation=1),dict(prediction='yes'),dict(predictor_smoothing_rad_s=0),
                       dict(predictor_smoothing_rad_s=float('nan')),dict(predictor_smoothing_rad_s=True)):
            with self.assertRaises(ValueError):
                validate_friction(dict(DEFAULT_FRICTION,**change))
        config = dict(self.base,friction=dict(DEFAULT_FRICTION,prediction=True))
        schema = dict(parameters=parameter_specs(config,[32]),available_N_by_friction=dict(off=[32],on=[]))
        with self.assertRaisesRegex(ValueError,'predictor friction on'):
            validate_settings(config,dict(kind='reach',target_offset_m=[0,0,0]),schema)

    def test_cold_inspection_recreates_captured_predictor_not_new_simulation_default(self):
        config = dict(self.base,friction=dict(DEFAULT_FRICTION,prediction=True,predictor_smoothing_rad_s=.09))
        captured = self.resolve(config)
        override = configuration_overrides(dict(problem_configuration=captured),12)
        self.assertNotIn('friction',override)
        replayed = self.resolve(override)
        self.assertEqual(replayed['prediction_joint_dynamics'],captured['prediction_joint_dynamics'])
        self.assertEqual(replayed['simulator_joint_dynamics'],override['joint_dynamics'])
        self.assertEqual(replayed['solver_params']['max_sqp_iters'],12)

    def test_missing_smooth_module_never_constructs_or_builds_a_solver(self):
        adapter = MPCAdapter.__new__(MPCAdapter)
        adapter.mpc_root, adapter.reach = ROOT, self.reach
        adapter.gato = SimpleNamespace(BSQP=Mock(side_effect=AssertionError('Native constructor called')))
        config = dict(self.base,friction=dict(DEFAULT_FRICTION,prediction=True))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'config.json';path.write_text(json.dumps(config))
            with patch('source_runtime.discover_compatible_modules',return_value=dict(available_N=[],modules=[],error='stale')):
                with self.assertRaisesRegex(ValueError,'prebuilt smooth-friction'):
                    adapter.configure(path,dict(kind='reach',target_offset_m=[0,0,0]))
        adapter.gato.BSQP.assert_not_called()

    def test_native_plant_step_reuses_upstream_rk4_and_preserves_loss_free_path(self):
        from tiago_mpc.joint_dynamics import plant_rk4
        model = self.reach.pin.buildModelFromUrdf(str(self.reach.URDF))
        q, v, u = self.reach.Q_START_RAD.copy(),np.linspace(-.2,.2,7),np.arange(7.)
        adapter = MPCAdapter.__new__(MPCAdapter)
        adapter.reach = self.reach
        adapter.simulator_joint_dynamics = canonical_losses(ROOT)[0]
        expected = plant_rk4(model,model.createData(),q,v,u,.001,adapter.simulator_joint_dynamics)
        actual = adapter.plant_step(model,model.createData(),q,v,u,.001)
        for a,b in zip(actual,expected): np.testing.assert_array_equal(a,b)
        adapter.simulator_joint_dynamics = None
        expected = self.reach.rk4(model,model.createData(),q,v,u,.001)
        actual = adapter.plant_step(model,model.createData(),q,v,u,.001)
        for a,b in zip(actual,expected): np.testing.assert_array_equal(a,b)

    def test_multirate_execution_uses_adapter_hook_for_every_native_step(self):
        import tests.test_execution as fixtures
        fixtures.LOCK_HELD = True
        adapter = FakeAdapter()
        adapter.plant_step = Mock(wraps=adapter.rk4)
        session = MultirateSession(adapter,DEFAULT_EXECUTION)
        records = session.advance_interval(.01)
        self.assertEqual(adapter.plant_step.call_count,10)
        self.assertEqual(len([r for r in records if r['type']=='state']),10)
        np.testing.assert_array_equal(adapter.plant_step.call_args.args[4],np.ones(7))

    def test_inspection_capability_uses_captured_predictor_variant(self):
        from solve_inspections import InspectionService
        service = InspectionService.__new__(InspectionService)
        checked = dict(compatible=True, available_N=[32], available_N_by_friction=dict(off=[32],on=[]),
                       capabilities=dict(iteration_capture_by_N={'32':True},
                           iteration_capture_by_friction=dict(off={'32':True},on={})))
        service._profile_capabilities = lambda profile: checked
        problem = dict(problem_configuration=dict(N=32,prediction_joint_dynamics={'model':'coulomb_tanh_viscous'}),
                       original_solver_profile={})
        with self.assertRaisesRegex(ValueError,'prebuilt'):
            service._checked(dict(profile={}),problem)
        checked['available_N_by_friction']['on'] = [32]
        with self.assertRaisesRegex(ValueError,'iteration capture'):
            service._checked(dict(profile={}),problem)
        checked['capabilities']['iteration_capture_by_friction']['on']['32'] = True
        self.assertIs(service._checked(dict(profile={}),problem),checked)

    def test_generated_model_is_local_and_friction_provenance_immutable(self):
        from source_runtime import prepared_model
        losses, _ = canonical_losses(ROOT)
        from tiago_mpc import model_runtime
        root_before = model_runtime.ROOT
        with prepared_model(self.reach,losses=dict(losses,model='coulomb_tanh_viscous',smoothing_rad_s=.03)) as (path,gpu,signs):
            self.assertTrue(path.is_relative_to(Path(__file__).resolve().parents[1]/'_expr_data'))
            self.assertEqual(signs.tolist(),[1,1,1,1,1,-1,1])
            self.assertIn(losses['provenance'],gpu.read_text())
            self.assertEqual(model_runtime.ROOT,root_before)
        self.assertFalse(path.exists())


if __name__ == '__main__': unittest.main()
