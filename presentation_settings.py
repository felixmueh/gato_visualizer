"""Local display/report preferences, independent of numerical MPC settings."""
from copy import deepcopy
import math
import threading

from gato_visualizer.plotting.limit_use import LIMIT_DEFAULTS, validate_limit_settings

# Limit-use states (near/at/beyond) share their thresholds with plots; see
# gato_visualizer/plotting/limit_use.py for definitions and ranges.
DEFAULT_PRESENTATION = dict(report_hz=20, buffer_ms=200, interpolate=False, limit_tint=True,
                            ghost_start_opacity_percent=55, ghost_end_opacity_percent=25,
                            **LIMIT_DEFAULTS)


def validate_presentation(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_PRESENTATION):
        raise ValueError('presentation requires ' + ', '.join(DEFAULT_PRESENTATION))
    result = dict(value)
    for name, minimum, maximum in (('report_hz', 1, 120), ('buffer_ms', 0, 10000),
                                    ('ghost_start_opacity_percent', 0, 100),
                                    ('ghost_end_opacity_percent', 0, 100)):
        number = value[name]
        if (isinstance(number, bool) or not isinstance(number, (int, float))
                or not math.isfinite(number) or not minimum <= number <= maximum):
            raise ValueError(f'{name} must be finite within [{minimum}, {maximum}]')
    if not isinstance(value['interpolate'], bool):
        raise ValueError('interpolate must be a boolean')
    if not isinstance(value['limit_tint'], bool):
        raise ValueError('limit_tint must be a boolean')
    validate_limit_settings({name: value[name] for name in LIMIT_DEFAULTS})
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

    def patch(self, changes):
        """Validate and apply selected fields against the current value atomically."""
        if not isinstance(changes, dict) or set(changes) - set(DEFAULT_PRESENTATION):
            raise ValueError('Unknown presentation setting or non-object patch')
        with self.lock:
            return self.update(dict(self.value, **changes))

    def update(self, value):
        from visualizer_config import save_local_settings
        value = validate_presentation(value)
        with self.lock:
            if value == self.value:
                return deepcopy(value)
            save_local_settings(self.path, presentation=value)
            try:
                if self.live is not None and value['report_hz'] != self.value['report_hz']:
                    self.live.set_report_hz(value['report_hz'])
            except (ValueError, RuntimeError):
                save_local_settings(self.path, presentation=self.value)
                raise
            self.value = value
            return deepcopy(value)
