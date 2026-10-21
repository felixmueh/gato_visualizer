"""Source/build HTTP and lifecycle regressions without solver/GPU work."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from source_settings import SourceSettings, restart_arguments
from visualizer_config import effective_source_selection, load_visualizer_config
from server import make_server

SELECTION = dict(mpc_root='/prepared/source', python=sys.executable, cache='/prepared/source/.cache/gato')


class SourceSettingsTests(unittest.TestCase):
    def test_persistent_apply_validates_before_write_and_defers_restart_until_response(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'viewer.json'
            path.write_text(json.dumps(dict(ingest_directory='recordings')))
            restart = Mock()
            service = SourceSettings(SELECTION, path, restart, probe=lambda _: dict(compatible=True, available_N=[48]))
            with patch('source_settings.selection_from_request', return_value=SELECTION):
                self.assertTrue(service.apply(SELECTION)['restarting'])
            self.assertEqual(json.loads(path.read_text()), dict(ingest_directory='recordings', source=SELECTION))
            restart.assert_not_called()
            service.finish_apply()
            restart.assert_called_once()
            with patch('source_settings.selection_from_request', return_value=SELECTION):
                with self.assertRaisesRegex(ValueError, 'already in progress'):
                    service.apply(SELECTION)

    def test_mismatch_keeps_configuration_and_gives_model_error(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'viewer.json'; path.write_text('{}')
            service = SourceSettings(SELECTION, path, Mock(), probe=lambda _: dict(compatible=False, error='grasp frame differs'))
            with patch('source_settings.selection_from_request', return_value=SELECTION):
                with self.assertRaisesRegex(ValueError, 'grasp frame differs'):
                    service.apply(SELECTION)
            self.assertEqual(path.read_text(), '{}')

    def test_cpu_build_keeps_running_until_validation_and_receipt_finish(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            entered, release = threading.Event(), threading.Event()
            def probe(_):
                entered.set(); release.wait(5)
                return dict(compatible=True, available_N=[48])
            service = SourceSettings(SELECTION, root / 'config.json', Mock(), probe=probe)
            command = [sys.executable, '-c', 'print("compilation progress", flush=True)']
            with patch('source_settings.ROOT', root), patch('source_settings.selection_from_request', return_value=SELECTION), patch('source_runtime.build_command', return_value=(command, {})):
                job = service.build(dict(selection=SELECTION, N=[48]))
                self.assertEqual(job['state'], 'running')
                self.assertTrue(entered.wait(5))
                self.assertEqual(service.job['state'], 'running')
                self.assertIn('compilation progress', service._job_snapshot()['log'])
                with self.assertRaisesRegex(ValueError, 'build is already running'):
                    service.build(dict(selection=SELECTION, N=[96]))
                with self.assertRaisesRegex(ValueError, 'Wait for the current build'):
                    service.apply(SELECTION)
                release.set(); service.build_thread.join(5)
                self.assertEqual(service.job['state'], 'complete')
                receipt = json.loads((Path(job['log_path']).parent / 'result.json').read_text())
                self.assertEqual(receipt['result']['available_N'], [48])
                self.assertEqual(receipt['state'], 'complete')
            service.close()

    def test_restart_drops_only_source_overrides_and_preserves_server_flags(self):
        argv = ['--mpc-root=/old', '--config', '/old/config', '--host', '0.0.0.0', '--port=9000', '--replay-only']
        result = restart_arguments(argv, '/saved/viewer.json')
        self.assertEqual(result[1:], ['--config', '/saved/viewer.json', '--host', '0.0.0.0', '--port=9000', '--replay-only'])

    def test_stopping_backend_terminates_supervised_cpu_build_and_retains_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            service = SourceSettings(SELECTION, root / 'config.json', Mock(), probe=lambda _: dict(compatible=True, available_N=[48]))
            command = [sys.executable, '-c', 'import time; time.sleep(30)']
            with patch('source_settings.ROOT', root), patch('source_settings.selection_from_request', return_value=SELECTION), patch('source_runtime.build_command', return_value=(command, {})):
                job = service.build(dict(selection=SELECTION, N=[48]))
                deadline = time.monotonic() + 5
                while not service.job.get('process') and time.monotonic() < deadline: time.sleep(.01)
                process = service.job['process']
                service.close()
                self.assertIsNotNone(process.poll())
                self.assertFalse(service.build_thread.is_alive())
                self.assertEqual(json.loads((Path(job['log_path']).parent / 'result.json').read_text())['state'], 'failed')

    def test_full_backend_restart_closes_resources_and_execs_selected_environment(self):
        from server import main
        class Restarted(Exception): pass
        events = []
        settings = SimpleNamespace(selection=dict(SELECTION, python='/new/env/bin/python'), close=lambda: events.append('sources-close'))
        service = SimpleNamespace(server_port=9001, server_close=lambda: events.append('server-close'), shutdown=Mock())
        def source_factory(selection, path, request_restart):
            service.serve_forever = request_restart
            return settings
        def execute(python, argv, environment):
            self.assertEqual(events, ['server-close', 'sources-close'])
            self.assertEqual(python, '/new/env/bin/python')
            self.assertNotIn('--mpc-root', argv)
            self.assertIn('--replay-only', argv)
            self.assertNotIn('TIAGO_MPC_ROOT', environment)
            self.assertNotIn('TIAGO_PYTHON', environment)
            self.assertNotIn('GATO_CACHE_DIR', environment)
            raise Restarted()
        config = SimpleNamespace(path=Path('/config/viewer.json'), ingest_directory=Path('/ingest'))
        scene = dict(trajectories=[], source=dict(bootstrap=True))
        with patch.dict(os.environ, {'TIAGO_MPC_ROOT':'/launch', 'TIAGO_PYTHON':'/old/python', 'GATO_CACHE_DIR':'/old/cache'}), patch('server.load_visualizer_config', return_value=config), patch('visualizer_config.effective_source_selection', return_value=SELECTION), patch('server.load_scene', return_value=(scene, b'<robot/>', {})), patch('replay_library.ReplayLibrary', return_value=SimpleNamespace(upload_directory='/uploads')), patch('source_settings.SourceSettings', side_effect=source_factory), patch('server.make_server', return_value=service), patch('server.os.execve', side_effect=execute):
            with self.assertRaises(Restarted):
                main(['--mpc-root', '/launch', '--replay-only', '--port', '9001'])

    def test_startup_precedence_and_default_environment_tracks_selected_project(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'viewer.json'
            path.write_text(json.dumps(dict(source=dict(mpc_root='/saved', python='/saved/python', cache='/saved/cache'))))
            config = load_visualizer_config(path)
            with patch('source_runtime.resolve_selection', side_effect=lambda root, **kw: dict(root=root, **kw)):
                self.assertEqual(effective_source_selection(config, environment={}), dict(root='/saved', python='/saved/python', cache='/saved/cache'))
                self.assertEqual(effective_source_selection(config, '/cli', {'TIAGO_MPC_ROOT':'/env'}), dict(root='/cli', python=None, cache=None))
                self.assertEqual(effective_source_selection(config, environment={'TIAGO_MPC_ROOT':'/env', 'TIAGO_PYTHON':'/python', 'GATO_CACHE_DIR':'/cache'}), dict(root='/env', python='/python', cache='/cache'))


class SourceHTTPTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        def apply(body):
            self.events.append(('apply', body)); return dict(accepted=True)
        self.sources = SimpleNamespace(status=lambda: dict(current=dict(compatible=True, available_N=[48])),
            inspect=lambda body: dict(compatible=False, error='wrong grasp frame'),
            build=lambda body: dict(state='running', N=body['N']), apply=apply,
            finish_apply=lambda: self.events.append(('restart', None)))
        self.server = make_server(dict(trajectories=[]), b'<robot/>', {}, port=0, sources=self.sources)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def request(self, path, body=None, origin=None):
        headers = {'Content-Type':'application/json'}
        if origin: headers['Origin'] = origin
        request = Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        with urlopen(request) as response:
            return json.load(response)

    def test_probe_and_build_and_restart_are_explicit(self):
        self.assertEqual(self.request('/api/source')['current']['available_N'], [48])
        self.assertEqual(self.request('/api/source/inspect', SELECTION)['error'], 'wrong grasp frame')
        self.assertEqual(self.request('/api/source/build', dict(N=[96]))['state'], 'running')
        self.assertEqual(self.events, [])
        self.assertTrue(self.request('/api/source/apply', SELECTION)['accepted'])
        deadline = time.monotonic()+2
        while len(self.events) < 2 and time.monotonic() < deadline: time.sleep(.01)
        self.assertEqual([kind for kind, _ in self.events], ['apply', 'restart'])
        self.assertIn('backend_id', self.request('/api/health'))

    def test_foreign_browser_cannot_select_or_build(self):
        with self.assertRaises(HTTPError) as caught:
            self.request('/api/source/build', dict(N=[96]), origin='http://unrelated.example')
        self.assertEqual(caught.exception.code, 403)


if __name__ == '__main__': unittest.main()
