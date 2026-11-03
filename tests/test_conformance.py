"""CPU checks of the conformance reference's current loop/record API; no GPU solver."""
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from live_mpc import import_tiago
from scripts.check_conformance import COMMAND_PERIOD_S, SOLVE_LATENCY_S, compare_arrays, reference_arrays, reference_plant, run_reference
from tests.tiago_mpc_source import MPC_ROOT


class NativeLoopMpc:
    """Only the MPC is fake; the loop, plant, task and RunRecord are upstream's."""
    def __init__(self):
        from tiago_mpc.mpc import TIAGO
        from native_cost import with_knot_count
        self.params = replace(with_knot_count(TIAGO, 3), dt_s=.01, max_sqp_time_s=None)
        self.N, self.dt = self.params.N, self.params.dt_s
        self.warmups, self.requests, self.pending = [], [], None

    def warmup(self, state, reference):
        self.warmups.append((state, reference.copy()))

    def request(self, state, reference, updates=None):
        from tiago_mpc.interfaces import Plan
        self.requests.append(state.t)
        self.pending = Plan(state.t, self.dt, np.tile(np.r_[state.q, state.qd], (self.N, 1)),
                            np.zeros((self.N - 1, 7)), dict(wall_s=.001), measured_t=getattr(state, "measured_t", state.t))

    def result(self, block=False):
        pending, self.pending = self.pending, None
        return pending


class ConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import_tiago(MPC_ROOT)

    def test_native_reference_records_every_tick_and_plan_without_arriving_or_compiling(self):
        from experiments.reach import Reach
        from tiago_mpc.clock import VirtualClock
        from tiago_mpc.record import from_dict
        from tiago_mpc.sim import SimConfig
        for _ in range(2):
            with tempfile.TemporaryDirectory() as directory:
                mpc = NativeLoopMpc()
                config = SimConfig(substep=.001)
                plant = reference_plant(config)
                task = Reach(position_tol_m=0.)
                try:
                    record = run_reference(plant, mpc, task, Path(directory) / 'reference', .02)
                    ticks, arrays = reference_arrays(record)
                    self.assertIs(plant.config, config)
                    self.assertIsInstance(plant.clock, VirtualClock)
                    self.assertEqual(record.metadata['status'], 'timeout')
                    self.assertAlmostEqual(record.metadata['end_t'], .02)
                    np.testing.assert_allclose(ticks, np.arange(11) * COMMAND_PERIOD_S, rtol=0, atol=1e-12)
                    self.assertEqual(arrays['state'].shape, (11, 14))
                    self.assertEqual(arrays['command'].shape, (7, 7))
                    self.assertEqual(arrays['plan_states'].shape, (2, 3, 14))
                    self.assertEqual(arrays['plan_torques'].shape, (2, 2, 7))
                    self.assertEqual(len(mpc.warmups), 1)
                    np.testing.assert_allclose(mpc.requests, [0., .01], rtol=0, atol=1e-12)
                    summary = json.loads((record.out / 'summary.json').read_text())
                    self.assertEqual(summary['config']['params']['type'], 'MpcParams')
                    self.assertEqual(from_dict(summary['config']['params']), mpc.params)
                    self.assertEqual(summary['config']['timing']['type'], 'VirtualTimeSettings')
                    self.assertEqual(summary['config']['timing']['solve_latency_s'], SOLVE_LATENCY_S)
                    self.assertTrue((record.out / 'ticks.npz').is_file())
                    self.assertTrue((record.out / 'plans.npz').is_file())
                finally:
                    plant.close()

    def test_reference_preserves_native_failure_record_before_reraising(self):
        from experiments.reach import Reach
        from tiago_mpc.sim import SimConfig
        with tempfile.TemporaryDirectory() as directory:
            mpc = NativeLoopMpc()
            def failed_result(block=False):
                raise RuntimeError('failed reference solve')
            mpc.result = failed_result
            plant = reference_plant(SimConfig())
            output = Path(directory) / 'failed'
            try:
                with self.assertRaisesRegex(RuntimeError, 'failed reference solve'):
                    run_reference(plant, mpc, Reach(position_tol_m=0.), output, .02)
                summary = json.loads((output / 'summary.json').read_text())
                self.assertEqual(summary['metadata']['status'], 'error')
                self.assertIn('failed reference solve', summary['metadata']['error'])
                self.assertTrue((output / 'ticks.npz').is_file())
                np.testing.assert_array_equal(plant.command, np.zeros(7))
            finally:
                plant.close()

    def test_array_comparison_handles_empty_faulted_runs_and_reports_first_difference(self):
        empty = compare_arrays(np.empty((0, 7)), np.empty((0, 7)), 1e-9)
        self.assertEqual(empty['max_abs_difference'], 0.)
        self.assertIsNone(empty['first_row_beyond_atol'])
        self.assertFalse(compare_arrays(np.empty((0, 7)), np.empty((1, 7)), 1e-9)['shape_equal'])
        check = compare_arrays(np.zeros((3, 2)), np.array([[0., 0.], [0., .1], [.2, 0.]]), .01)
        self.assertEqual(check['first_row_beyond_atol'], 1)
        self.assertEqual(check['max_abs_difference'], .2)


if __name__ == '__main__':
    unittest.main()
