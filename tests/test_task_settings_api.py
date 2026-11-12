"""Shared backend task settings, without a solver or GPU."""
from copy import deepcopy
import json
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

from execution_bridge import LiveSettingsConflict, ProcessLiveService
from server import make_server
from task_settings import settings_only
from tests.test_execution import FakeAdapter, FakeRenderer, fake_schema, fake_worker
from tests.tiago_mpc_source import MPC_ROOT
from tests.test_solver_profiles import ProfileAdapter, wait_until


def scoped_schema(root):
    schema = fake_schema(root)
    for role, defaults, parameters in (
        ('simulation', dict(gain=1., law='both'), [dict(path='gain', kind='float', min=0., max=4.),
            dict(path='law', kind='choice', choices=['default', 'pd', 'ff', 'both'])]),
        ('predictor', dict(mode='nominal'), [dict(path='mode', kind='choice', choices=['nominal', 'fast'])]),
    ):
        schema['source_settings'][role].update(defaults=defaults, parameters=parameters)
        schema['defaults']['source_settings'][role] = deepcopy(defaults)
    return schema


# Task-specific defaults, as a tracking task's descriptor may declare them.
FIGURE8_OVERRIDES = dict(config=dict(cost_weights=dict(position=500., terminal_position=1000.),
                                     solver=dict(max_sqp_iters=1)),
                         execution=dict(to_hz=500.))


def overridden_schema(root):
    schema = scoped_schema(root)
    figure8 = next(task for task in schema['tasks'] if task['kind'] == 'figure8')
    figure8['settings_overrides'] = deepcopy(FIGURE8_OVERRIDES)
    return schema


def figure8_default_schema(root):
    schema = overridden_schema(root)
    schema['defaults']['task'] = deepcopy(next(task['defaults'] for task in schema['tasks'] if task['kind'] == 'figure8'))
    return schema


class StartupAdapter(FakeAdapter):
    def configure(self, config, task):
        super().configure(config, task)
        self.accepted_config = deepcopy(config)

    def segment_header(self, version, execution):
        header = super().segment_header(version, execution)
        header['context']['settings']['config'] = deepcopy(self.accepted_config)
        return header


class SettingsProfileAdapter(ProfileAdapter):
    def __init__(self, root):
        super().__init__(root)
        self.profile_schema = scoped_schema(root)

    def preflight_profile(self, profile, config, task):
        schema = scoped_schema(MPC_ROOT)
        schema['source_settings']['simulation'].update(
            defaults=dict(bias=.5), parameters=[dict(path='bias', kind='float', min=0., max=4.)])
        schema['defaults']['source_settings']['simulation'] = dict(bias=.5)
        schema['requested_source_settings'] = deepcopy(schema['defaults']['source_settings'])
        return schema

    def select_profile(self, profile, schema):
        self.profile_schema = deepcopy(schema)
        super().select_profile(profile, schema)


class TaskSessionTests(unittest.TestCase):
    def setUp(self):
        self.live = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter,
            schema_factory=scoped_schema, worker_target=fake_worker, render_factory=FakeRenderer)

    def tearDown(self):
        self.live.close()

    def patch(self, value, **options):
        return self.live.command(dict(type='patch_settings', patch=value, **options))

    def switch(self, kind, **options):
        return self.live.command(dict(type='switch_task', task_kind=kind, **options))

    def settings(self):
        return settings_only(self.live.settings_snapshot())

    def test_switch_restores_all_four_groups_and_presentation_edits(self):
        general = deepcopy(self.live.schema['defaults'])
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=8), cost_weights=dict(position=19.)),
                        task=dict(target_offset_m=[.1, -.1, .2]),
                        execution=dict(to_hz=200., duration_s=11.),
                        source_settings=dict(simulation=dict(gain=2.), predictor=dict(mode='fast'))))
        self.patch(dict(execution=dict(continue_at_end=True)))
        reach = self.settings()
        self.switch('figure8', expected_settings_version=self.live.version)
        self.assertEqual(self.settings(), self.live.schema['task_defaults']['figure8'])
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=3)), task=dict(period_s=12.),
                        execution=dict(to_hz=250., duration_s=7.), source_settings=dict(simulation=dict(gain=3.))))
        figure = self.settings()
        self.switch('reach')
        self.assertEqual(self.settings(), reach)
        self.switch('figure8')
        self.assertEqual(self.settings(), figure)
        self.assertEqual(self.live.schema['defaults'], general)
        snapshot = self.live.settings_snapshot()
        self.assertTrue(snapshot['task_settings']['overrides']['reach']['execution']['continue_at_end'])
        self.assertEqual(snapshot['task_settings']['overrides']['figure8']['task']['period_s'], 12.)
        self.assertEqual(snapshot['task_settings']['sessions']['reach'], reach)
        self.assertEqual(snapshot['task_settings']['sessions']['figure8'], figure)
        snapshot['task_settings']['sessions']['reach']['config']['solver']['max_sqp_iters'] = 99
        self.assertEqual(self.live.settings_snapshot()['task_settings']['sessions']['reach'], reach)
        snapshot['task_settings']['overrides']['reach']['execution']['continue_at_end'] = False
        self.assertTrue(self.live.settings_snapshot()['task_settings']['overrides']['reach']['execution']['continue_at_end'])

    def test_a_default_task_starts_with_its_own_defaults_in_backend_and_worker(self):
        self.live.close()
        self.live = ProcessLiveService(MPC_ROOT, adapter_factory=StartupAdapter,
            schema_factory=figure8_default_schema, worker_target=fake_worker, render_factory=FakeRenderer)
        current = self.settings()
        self.assertEqual(current['task']['kind'], 'figure8')
        self.assertEqual(current['config']['cost_weights']['position'], 500.)
        self.assertEqual(current['config']['cost_weights']['terminal_position'], 1000.)
        self.assertEqual(current['execution']['to_hz'], 500.)
        self.assertEqual(current['config']['solver']['max_sqp_iters'], 1)
        self.assertEqual(current['source_settings']['simulation']['law'], 'both')
        self.assertEqual(self.live.schema['defaults']['config']['cost_weights']['position'], 4.)
        self.assertEqual(self.live.schema['execution']['defaults']['to_hz'], 100.)
        self.live.subscribe()
        wait_until(lambda: 'plan' in self.live.latest)
        actual = self.live.latest['segment']['context']['settings']
        self.assertEqual(actual['config']['cost_weights']['position'], 500.)
        self.assertEqual(actual['execution']['to_hz'], 500.)
        self.assertEqual(actual['config']['solver']['max_sqp_iters'], 1)

    def test_reset_active_task_restores_all_groups_in_one_transaction_without_changing_other_tasks(self):
        self.live.close()
        self.live = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter,
            schema_factory=overridden_schema, worker_target=fake_worker, render_factory=FakeRenderer)
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=9)), execution=dict(to_hz=200.)))
        kinds = ['figure8']
        original_defaults = deepcopy(self.live.schema['task_defaults'])
        for kind in kinds:
            with self.subTest(kind=kind):
                self.switch(kind)
                self.patch(dict(config=dict(cost_weights=dict(position=17., terminal_position=31.), solver=dict(max_sqp_iters=7)),
                    task=dict(target_offset_m=[.1, -.1, .2]), execution=dict(to_hz=200., duration_s=7., continue_at_end=True,
                                                                        latency_compensation=False),
                    source_settings=dict(simulation=dict(gain=3., law='default'), predictor=dict(mode='fast'))))
                before = self.live.settings_snapshot()
                revision = self.live.revision.value
                with patch.object(self.live.commands, 'put_nowait', wraps=self.live.commands.put_nowait) as enqueue:
                    accepted = self.live.command(dict(type='reset_task_settings', expected_settings_version=self.live.version))
                    enqueue.assert_called_once()
                    request = enqueue.call_args.args[0]
                    self.assertEqual(request['type'], 'set_settings')
                    self.assertEqual(request['task']['kind'], kind)
                current = self.live.settings_snapshot()
                self.assertEqual(accepted, before['settings_version'] + 1)
                self.assertEqual(current['settings_version'], accepted)
                self.assertEqual(self.live.revision.value, revision + 1)
                self.assertEqual(self.settings(), original_defaults[kind])
                self.assertEqual(current['config']['cost_weights']['position'], 500.)
                self.assertEqual(current['config']['cost_weights']['terminal_position'], 1000.)
                self.assertEqual(current['execution']['to_hz'], 500.)
                self.assertTrue(current['execution']['latency_compensation'])
                self.assertEqual(current['config']['solver']['max_sqp_iters'], 1)
                self.assertEqual(current['source_settings']['simulation']['law'], 'both')
                self.assertEqual(current['task_settings']['overrides'][kind], {})
                for other, session in before['task_settings']['sessions'].items():
                    if other != kind:
                        self.assertEqual(current['task_settings']['sessions'][other], session)
                self.assertEqual(current['task_settings']['defaults'], original_defaults)
                # Restoring the earlier accepted document is the same normal edit
                # the browser's Undo sends, and must restore this bank alone.
                self.live.command(dict(type='set_settings', **settings_only(before), expected_settings_version=accepted))
                self.assertEqual(self.settings(), settings_only(before))
                for other, session in before['task_settings']['sessions'].items():
                    self.assertEqual(self.live.settings_snapshot()['task_settings']['sessions'][other], session)

    def test_reset_uses_latest_defaults_and_rejects_stale_or_invalid_requests_atomically(self):
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=9)), source_settings=dict(simulation=dict(gain=3.))))
        # The profile's defaults may have changed since its catalog was installed.
        self.live.schema['defaults']['source_settings']['simulation']['gain'] = 2.
        before = self.live.settings_snapshot()
        revision, path = self.live.revision.value, self.live.history_store.path
        with self.assertRaises(LiveSettingsConflict) as error:
            self.live.command(dict(type='reset_task_settings', expected_settings_version=0))
        self.assertEqual(error.exception.settings, before)
        for command in (dict(type='reset_task_settings', task_kind='figure8'),
                        dict(type='reset_task_settings', config={}),
                        dict(type='reset_task_settings', anchor={}),
                        dict(type='reset_task_settings', expected_settings_version=True)):
            with self.subTest(command=command), self.assertRaises(ValueError):
                self.live.command(command)
        with patch.object(self.live.commands, 'full', return_value=True), self.assertRaisesRegex(ValueError, 'queue full'):
            self.live.command(dict(type='reset_task_settings'))
        with patch('live_mpc.validate_settings', side_effect=ValueError('Default model unavailable')), self.assertRaisesRegex(ValueError, 'Default model unavailable'):
            self.live.command(dict(type='reset_task_settings'))
        self.assertEqual(self.live.settings_snapshot(), before)
        self.assertEqual(self.live.revision.value, revision)
        self.assertEqual(self.live.history_store.path, path)
        self.live.command(dict(type='reset_task_settings', expected_settings_version=self.live.version))
        self.assertEqual(self.settings()['source_settings']['simulation']['gain'], 2.)
        self.assertEqual(self.settings()['config']['solver']['max_sqp_iters'], self.live.schema['defaults']['config']['solver']['max_sqp_iters'])

    def test_task_kind_patch_uses_target_session_before_applying_other_groups(self):
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=9)), execution=dict(to_hz=200.)))
        reach = self.settings()
        self.switch('figure8')
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=3)), task=dict(period_s=12.)))
        self.switch('reach')
        self.assertEqual(self.settings(), reach)
        self.patch(dict(task=dict(kind='figure8', width_m=.3), config=dict(solver=dict(max_pcg_iters=333))))
        current = self.settings()
        self.assertEqual(current['config']['solver']['max_sqp_iters'], 3)
        self.assertEqual(current['config']['solver']['max_pcg_iters'], 333)
        self.assertEqual(current['task']['period_s'], 12.)
        self.assertEqual(current['task']['width_m'], .3)
        self.assertEqual(current['execution']['to_hz'], self.live.schema['task_defaults']['figure8']['execution']['to_hz'])

    def test_full_replacement_owns_explicit_destination_values(self):
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=9))))
        self.switch('figure8')
        figure = self.settings()
        replacement = deepcopy(self.live.schema['task_defaults']['reach'])
        replacement['config']['solver']['max_sqp_iters'] = 2
        replacement['execution']['to_hz'] = 350.
        replacement['source_settings']['simulation']['gain'] = 4.
        self.live.command(dict(type='set_settings', **replacement))
        self.assertEqual(self.settings(), replacement)
        self.switch('figure8')
        self.assertEqual(self.settings(), figure)
        self.switch('reach')
        self.assertEqual(self.settings(), replacement)

    def test_selected_transfer_changes_only_the_active_destination(self):
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=9), cost_weights=dict(position=23.)),
                        task=dict(target_offset_m=[.1, .2, .3]), execution=dict(to_hz=200.),
                        source_settings=dict(simulation=dict(gain=3.))))
        source = self.settings()
        self.switch('figure8')
        before = self.settings()
        self.live.command(dict(type='transfer_settings', source_task='reach',
            paths=['config.solver.max_sqp_iters', 'config.cost_weights.position',
                   'task.target_offset_m', 'source_settings.simulation'],
            expected_settings_version=self.live.version))
        current = self.settings()
        self.assertEqual(current['task']['kind'], 'figure8')
        self.assertEqual(current['task']['target_offset_m'], [.1, .2, .3])
        self.assertEqual(current['config']['solver']['max_sqp_iters'], 9)
        self.assertEqual(current['config']['cost_weights']['position'], 23.)
        self.assertEqual(current['source_settings']['simulation']['gain'], 3.)
        self.assertEqual(current['execution'], before['execution'])
        self.assertEqual(current['config']['cost'], before['config']['cost'])
        self.switch('reach')
        self.assertEqual(self.settings(), source)

    def test_transfer_of_only_continue_at_end_preserves_history_and_updates_task_bank(self):
        self.patch(dict(execution=dict(continue_at_end=True)))
        self.switch('figure8')
        before = self.live.settings_snapshot()
        revision = self.live.revision.value
        with patch.object(self.live.commands, 'put_nowait', wraps=self.live.commands.put_nowait) as enqueue:
            self.live.command(dict(type='transfer_settings', source_task='reach', paths=['execution.continue_at_end']))
            enqueue.assert_not_called()
        after = self.live.settings_snapshot()
        self.assertTrue(after['execution']['continue_at_end'])
        self.assertTrue(after['task_settings']['overrides']['figure8']['execution']['continue_at_end'])
        self.assertEqual((after['generation'], after['settings_version']),
                         (before['generation'], before['settings_version']))
        self.assertEqual(self.live.revision.value, revision)

    def test_rejected_switch_or_transfer_never_mutates_bank_revision_or_history(self):
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=9))))
        before = self.live.settings_snapshot()
        revision, path = self.live.revision.value, self.live.history_store.path
        invalid = [dict(type='switch_task', task_kind='unknown'),
                   dict(type='patch_settings', patch=dict(task=dict(kind='figure8'), config=dict(N=64))),
                   dict(type='transfer_settings', source_task='figure8', paths=['task.kind']),
                   dict(type='transfer_settings', source_task='figure8', paths=['config.cost']),
                   dict(type='transfer_settings', source_task='figure8', paths=['settings_version']),
                   dict(type='transfer_settings', source_task='figure8', paths=['task.width_m']),
                   dict(type='transfer_settings', source_task='figure8', paths=[])]
        for command in invalid:
            with self.subTest(command=command), self.assertRaises(ValueError):
                self.live.command(command)
            self.assertEqual(self.live.settings_snapshot(), before)
            self.assertEqual(self.live.revision.value, revision)
            self.assertEqual(self.live.history_store.path, path)
        with patch.object(self.live.commands, 'full', return_value=True), self.assertRaisesRegex(ValueError, 'queue full'):
            self.switch('figure8')
        self.assertEqual(self.live.settings_snapshot(), before)

    def test_new_commands_use_compare_and_set_and_same_task_is_a_noop(self):
        self.patch(dict(execution=dict(to_hz=200.)))
        before = self.live.settings_snapshot()
        for command in (dict(type='switch_task', task_kind='figure8'),
                        dict(type='transfer_settings', source_task='figure8', paths=['execution.to_hz'])):
            with self.subTest(command=command), self.assertRaises(LiveSettingsConflict) as error:
                self.live.command(dict(command, expected_settings_version=0))
            self.assertEqual(error.exception.settings, before)
            self.assertEqual(self.live.settings_snapshot(), before)
        revision = self.live.revision.value
        self.assertEqual(self.switch('reach', expected_settings_version=self.live.version), self.live.version)
        self.assertEqual(self.live.settings_snapshot(), before)
        self.assertEqual(self.live.revision.value, revision)

    def test_profile_changes_rebase_inactive_fields_and_keep_explicit_native_menu_intact(self):
        self.live.close()
        self.live = ProcessLiveService(MPC_ROOT, adapter_factory=SettingsProfileAdapter,
            schema_factory=scoped_schema, worker_target=fake_worker, render_factory=FakeRenderer)
        self.switch('figure8')
        self.patch(dict(config=dict(solver=dict(max_sqp_iters=3)), source_settings=dict(simulation=dict(gain=3.))))
        self.switch('reach')
        # An explicit inactive menu that a later profile cannot represent must
        # remain intact so activation rejects it rather than changing its objective.
        custom = deepcopy(self.live.schema['defaults']['config']['cost'])
        custom['input']['target'] = 'gravity'
        self.live._task_overrides['figure8'].setdefault('config', {})['cost'] = custom
        self.live.switch_solver_profile(dict(id='new-settings'))
        wait_until(lambda: self.live.profile_switch['state'] != 'switching')
        self.assertEqual(self.live.profile_switch['state'], 'idle')
        patch_ = self.live.settings_snapshot()['task_settings']['overrides']['figure8']
        self.assertNotIn('gain', patch_.get('source_settings', {}).get('simulation', {}))
        self.assertEqual(patch_['config']['solver']['max_sqp_iters'], 3)
        self.assertEqual(patch_['config']['cost'], custom)
        before = self.live.settings_snapshot()
        with self.assertRaisesRegex(ValueError, 'Complete config|Native cost is fixed'):
            self.switch('figure8')
        self.assertEqual(self.live.settings_snapshot(), before)
        del self.live._task_overrides['figure8']['config']['cost']
        self.switch('figure8')
        self.assertEqual(self.settings()['source_settings']['simulation'], dict(bias=.5))
        self.assertEqual(self.settings()['config']['solver']['max_sqp_iters'], 3)

    def test_http_reload_observes_the_backend_bank_and_switch_state(self):
        server = make_server(dict(trajectories=[]), b'<robot/>', {}, port=0, live=self.live)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            self.patch(dict(config=dict(solver=dict(max_sqp_iters=9))))
            request = Request(base+'/api/live/command', json.dumps(dict(type='switch_task', task_kind='figure8',
                expected_settings_version=self.live.version)).encode(), {'Content-Type': 'application/json'})
            with urlopen(request) as response:
                self.assertTrue(json.load(response)['accepted'])
            with urlopen(base+'/api/live/settings') as response:
                current = json.load(response)
            self.assertEqual(current['task']['kind'], 'figure8')
            self.assertEqual(current['task_settings']['overrides']['reach']['config']['solver']['max_sqp_iters'], 9)
            self.assertEqual(current, self.live.settings_snapshot())
            self.assertFalse(self.live._preview_requested)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
