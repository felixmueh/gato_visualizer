"""One-pass numerical state detachment, preserving historical state semantics."""
import json
import pickle
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from execution_session import DEFAULT_EXECUTION, MultirateSession
from live_presentation import render_state, snapshot
from tests import test_live_mpc


class StateRecordTests(unittest.TestCase):
    def adapter(self):
        adapter = test_live_mpc.AdapterTelemetryTests().adapter()
        adapter.simulator_identity = dict(source=dict(branch='original'),
                                          limits=dict(velocity_rad_s=[2.]*7))
        adapter.profile = dict(id='original-profile')
        adapter.remote = SimpleNamespace(epoch='original-epoch')
        adapter.x = np.arange(14, dtype=float)/10
        adapter.x[5] = -.5  # Already native: no GPU-axis conversion at this boundary.
        adapter.u = np.arange(7, dtype=float)
        adapter.applied_torque = -np.arange(7, dtype=float)
        adapter.joint_limits = dict(lower_position_rad=[-2.]*7, upper_position_rad=[2.]*7)
        return adapter

    def test_state_record_matches_presentation_snapshot_and_survives_pickle(self):
        adapter = self.adapter()
        expected = render_state(adapter.state_snapshot(.75, 3), adapter.kinematics)
        record = adapter.state_record(.75, 3)
        self.assertEqual(render_state(record, adapter.kinematics), expected)
        restored = pickle.loads(pickle.dumps(record))
        self.assertEqual(render_state(restored, adapter.kinematics), expected)
        self.assertEqual(json.loads(json.dumps(expected, allow_nan=False)), expected)
        self.assertEqual(expected['q'][5], -.5)
        self.assertEqual(expected['qd'][5], 1.2)
        self.assertEqual(expected['torque_nm'][5], -5.)
        self.assertEqual(expected['settings_version'], 3)
        self.assertEqual(expected['rtf'], .75)

    def test_retained_records_detach_all_state_context_and_survive_profile_swap(self):
        adapter = self.adapter()
        record = adapter.state_record(.75, 3)
        immutable = adapter.state_snapshot(.75, 3)
        expected = render_state(record, adapter.kinematics)
        adapter.x[:] = -99
        adapter.applied_torque[:] = 99
        adapter.joint_limits['lower_position_rad'][0] = -99
        adapter.simulator_identity['source']['branch'] = 'edited'
        adapter.simulator_identity['limits']['velocity_rad_s'][0] = 99
        adapter.task_anchors = snapshot(dict(reach=[99]*3, figure8=[99]*3))
        adapter.task['kind'] = 'new-task'
        adapter.profile = dict(id='new-profile')
        adapter.remote = SimpleNamespace(epoch='new-epoch')
        self.assertEqual(render_state(record, adapter.kinematics), expected)
        self.assertEqual(render_state(immutable, adapter.kinematics), expected)
        with self.assertRaises(ValueError):
            record['_x'][0] = 0
        with self.assertRaises(TypeError):
            immutable['simulator_identity']['source']['branch'] = 'mutation'
        # The IPC record's containers are intentionally mutable, but belong
        # exclusively to that record, never to the next numerical state.
        record['simulator_identity']['limits']['velocity_rad_s'][1] = -100
        record['joint_limits']['upper_position_rad'][1] = -100
        self.assertEqual(adapter.simulator_identity['limits']['velocity_rad_s'][1], 2.)
        self.assertEqual(adapter.joint_limits['upper_position_rad'][1], 2.)

    def test_session_detaches_numerical_buffer_once_without_snapshot_or_mutable_pass(self):
        class CountCopies(np.ndarray):
            copies = 0
            def copy(self, *args, **kwargs):
                type(self).copies += 1
                return super().copy(*args, **kwargs)
        adapter = self.adapter()
        adapter.x = adapter.x.view(CountCopies)
        session = MultirateSession(adapter, DEFAULT_EXECUTION, version=4)
        with patch.object(adapter, 'state_snapshot', side_effect=AssertionError('Intermediate snapshot')), \
             patch('live_presentation.mutable', side_effect=AssertionError('Repeated mutable conversion')):
            record = session.initial_state()
        self.assertEqual(CountCopies.copies, 1)
        self.assertFalse(np.shares_memory(record['_x'], adapter.x))
        self.assertEqual(record['settings_version'], 4)
        self.assertFalse(record['plan_exhausted'])
        self.assertEqual(record['control_updates'], 0)

    def test_state_record_detaches_nested_arrays_and_snapshot_only_adapter_fallback(self):
        adapter = self.adapter()
        adapter.simulator_identity['nested'] = [dict(buffer=np.arange(3.))]
        record = adapter.state_record()
        adapter.simulator_identity['nested'][0]['buffer'][:] = -1
        np.testing.assert_array_equal(record['simulator_identity']['nested'][0]['buffer'], np.arange(3.))
        self.assertFalse(record['simulator_identity']['nested'][0]['buffer'].flags.writeable)
        source = dict(_x=np.arange(14.), context=dict(values=[1, 2]))
        other = SimpleNamespace(t=0., state_snapshot=lambda *args: snapshot(source), new_plant=lambda substep: None)
        fallback = MultirateSession(other, DEFAULT_EXECUTION).initial_state()
        source['_x'][:] = -1
        source['context']['values'][0] = -1
        np.testing.assert_array_equal(fallback['_x'], np.arange(14.))
        self.assertEqual(fallback['context']['values'], [1, 2])
