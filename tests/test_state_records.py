"""One-pass numerical state detachment, preserving historical state semantics."""
import json
import pickle
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from tests.tiago_mpc_source import EXECUTION
from native_session import NativeSession
from live_presentation import render_state, snapshot
from tests import test_live_mpc


class StateRecordTests(unittest.TestCase):
    CONTEXT = dict(task=dict(kind='reach'), position_tol_m=.01, speed_l1_tol_rad_s=.1)

    def adapter(self):
        adapter = test_live_mpc.AdapterTelemetryTests().adapter()
        adapter.x = np.arange(14, dtype=float)/10
        adapter.x[5] = -.5  # Already native: no GPU-axis conversion at this boundary.
        adapter.u = np.arange(7, dtype=float)
        adapter.applied_torque = -np.arange(7, dtype=float)
        return adapter

    def test_state_record_matches_presentation_snapshot_and_survives_pickle(self):
        adapter = self.adapter()
        expected = render_state(adapter.state_snapshot(3), adapter.kinematics, self.CONTEXT)
        record = adapter.state_record(3)
        self.assertEqual(render_state(record, adapter.kinematics, self.CONTEXT), expected)
        restored = pickle.loads(pickle.dumps(record))
        self.assertEqual(render_state(restored, adapter.kinematics, self.CONTEXT), expected)
        self.assertEqual(json.loads(json.dumps(expected, allow_nan=False)), expected)
        self.assertEqual(expected['q'][5], -.5)
        self.assertEqual(expected['qd'][5], 1.2)
        self.assertEqual(expected['torque_nm'][5], -5.)
        self.assertEqual(expected['settings_version'], 3)

    def test_state_records_hold_only_their_own_data_detached(self):
        adapter = self.adapter()
        record = adapter.state_record(3)
        immutable = adapter.state_snapshot(3)
        # The constant context (limits, identities, task, profile) is in the segment header.
        self.assertEqual(set(record), {'type', 'sim_time_s', '_x', 'settings_version', 'torque_nm', 'target_xyz'})
        expected = render_state(record, adapter.kinematics, self.CONTEXT)
        adapter.x[:] = -99
        adapter.applied_torque[:] = 99
        self.assertEqual(render_state(record, adapter.kinematics, self.CONTEXT), expected)
        self.assertEqual(render_state(immutable, adapter.kinematics, self.CONTEXT), expected)
        with self.assertRaises(ValueError):
            record['_x'][0] = 0

    def test_session_detaches_numerical_buffer_once_without_snapshot_or_mutable_pass(self):
        class CountCopies(np.ndarray):
            copies = 0
            def copy(self, *args, **kwargs):
                type(self).copies += 1
                return super().copy(*args, **kwargs)
        adapter = self.adapter()
        adapter.x = adapter.x.view(CountCopies)
        session = NativeSession(adapter, EXECUTION, version=4)
        with patch.object(adapter, 'state_snapshot', side_effect=AssertionError('Intermediate snapshot')), \
             patch('live_presentation.mutable', side_effect=AssertionError('Repeated mutable conversion')):
            record = session.initial_state()
        self.assertEqual(CountCopies.copies, 1)
        self.assertFalse(np.shares_memory(record['_x'], adapter.x))
        self.assertEqual(record['settings_version'], 4)
        self.assertFalse(record['plan_exhausted'])
        self.assertEqual(record['control_updates'], 0)

    def test_snapshot_only_adapter_fallback_detaches(self):
        source = dict(_x=np.arange(14.), context=dict(values=[1, 2]))
        other = SimpleNamespace(t=0., x=np.arange(14.), u=np.zeros(7), sequence=0, applied_torque=None,
                                state_snapshot=lambda *args: snapshot(source), new_plant=lambda substep: None)
        fallback = NativeSession(other, EXECUTION).initial_state()
        source['_x'][:] = -1
        source['context']['values'][0] = -1
        np.testing.assert_array_equal(fallback['_x'], np.arange(14.))
        self.assertEqual(fallback['context']['values'], [1, 2])
