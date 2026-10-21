"""Local display/report preferences, independent of numerical MPC settings."""
from copy import deepcopy
import math
import threading

DEFAULT_PRESENTATION = dict(report_hz=20, buffer_ms=200, interpolate=False)


def validate_presentation(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_PRESENTATION):
        raise ValueError('presentation requires report_hz, buffer_ms and interpolate')
    result = dict(value)
    for name, minimum, maximum in (('report_hz', 1, 120), ('buffer_ms', 0, 10000)):
        number = value[name]
        if (isinstance(number, bool) or not isinstance(number, (int, float))
                or not math.isfinite(number) or not minimum <= number <= maximum):
            raise ValueError(f'{name} must be finite within [{minimum}, {maximum}]')
    if not isinstance(value['interpolate'], bool):
        raise ValueError('interpolate must be a boolean')
    return result


class PresentationSettings:
    def __init__(self, config_path, live=None, initial=None):
        from visualizer_config import load_visualizer_config
        self.path, self.live = config_path, live
        self.lock = threading.RLock()
        self.value = (load_visualizer_config(config_path).presentation if initial is None
                      else validate_presentation(initial))

    def settings(self):
        with self.lock:
            return deepcopy(self.value)

    def update(self, value):
        from visualizer_config import save_local_settings
        value = validate_presentation(value)
        with self.lock:
            save_local_settings(self.path, presentation=value)
            try:
                if self.live is not None and value['report_hz'] != self.value['report_hz']:
                    self.live.set_report_hz(value['report_hz'])
            except (ValueError, RuntimeError):
                save_local_settings(self.path, presentation=self.value)
                raise
            self.value = value
            return deepcopy(value)
