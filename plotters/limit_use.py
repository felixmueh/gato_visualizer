"""Joint limit use over episode time, against the physical (scene / URDF) limits."""
from bisect import bisect_left, bisect_right

from gato_visualizer.plotting import plot_episode, Choice, EpisodeView, lines, series, unavailable
from gato_visualizer.plotting.views import number
from gato_visualizer.plotting.limit_use import (
    QUANTITIES, UNITS, at_tolerance, limit_settings, limit_state, limit_use, physical_limits,
)

JOINTS = tuple(f'arm_right_{i}_joint' for i in range(1, 8))
JOINT_CHOICES = ('all', 'worst', *JOINTS)
QUANTITY_CHOICES = ('all', 'worst', 'torque', 'velocity', 'position')
# One colour identity per quantity: the shared CSS tokens, with fallbacks for
# hosts (offline previews) that do not define them.
COLORS = dict(position='var(--limit-position, #6fb2ee)', velocity='var(--limit-velocity, #b398f3)',
              torque='var(--limit-torque, #85c99c)')
WORST_COLOR = '#d7e4ef'
TITLE = 'Joint limit use'


def recorded_tracks(data: EpisodeView, quantity):
    """Per joint (times, values) of one recorded quantity in the analysis range.

    Torque has its own clock (torque samples / torque_time_s) and is a held
    command. Absent values stay absent; velocity and torque are never derived.
    """
    if quantity == 'torque':
        source = data.raw.get('torque_samples') or data.states
        key = 'torque_nm'
    else:
        source, key = data.states, 'q' if quantity == 'position' else 'qd'
    samples = sorted((s for s in source if data.in_range(s.get('sim_time_s'))), key=lambda s: s['sim_time_s'])
    tracks = []
    for joint in range(len(JOINTS)):
        times, values = [], []
        for sample in samples:
            row = sample.get(key)
            if row is None and key == 'qd':
                row = sample.get('qd_rad_s')
            value = number(row[joint]) if row is not None and len(row) > joint else None
            if value is not None:
                times.append(sample['sim_time_s']); values.append(value)
        tracks.append((times, values))
    return tracks


class Track:
    """One joint's quantity; evaluates its limit use where the plot draws it."""
    def __init__(self, quantity, joint, times, values, limits, settings):
        self.quantity, self.joint, self.times, self.values = quantity, joint, times, values
        self.limits, self.settings = limits, settings
        self.tolerance = at_tolerance(quantity, joint, limits, settings)

    def use(self, value):
        return limit_use(self.quantity, value, self.joint, self.limits)

    def value_at(self, t):
        """Exact sample, else the drawn curve: held torque, interpolated q/qd."""
        times, values = self.times, self.values
        i = bisect_left(times, t)
        if i < len(times) and times[i] == t:
            return values[i]
        if self.quantity == 'torque':
            j = bisect_right(times, t) - 1
            return values[j] if 0 <= j < len(times) - 1 else None
        if 0 < i < len(times):
            (t0, v0), (t1, v1) = (times[i - 1], values[i - 1]), (times[i], values[i])
            return v0 + (v1 - v0) * (t - t0) / (t1 - t0)
        return None


def describe(track, use):
    state = limit_state(use, track.tolerance, track.settings)
    unit = UNITS[track.quantity]
    where = (f'at {use.bound}' if state == 'at' else
             f'{abs(use.distance):.3g} {unit} beyond {use.bound}' if state == 'beyond' else
             f'{use.distance:.3g} {unit} from {use.bound}')
    return f'J{track.joint + 1} {track.quantity} {use.fraction * 100:.0f} % · {where}'


def envelope(label, tracks, color=None):
    """The maximum limit use over tracks at each sample, naming the binding one."""
    if len(tracks) == 1:
        grid = tracks[0].times
    else:
        grid = sorted({t for track in tracks for t in track.times})
    y, hover = [], []
    for t in grid:
        best = None
        for track in tracks:
            use = track.use(track.value_at(t))
            if use is not None and (best is None or use.fraction > best[1].fraction):
                best = track, use
        y.append(best[1].fraction * 100 if best else None)
        hover.append(describe(*best) if best else None)
    step = all(track.quantity == 'torque' for track in tracks)
    result = series(label, grid, y, style='step' if step else 'line', color=color)
    result['hover'] = hover
    return result


@plot_episode(id='episode.joint_limit_use', title=TITLE, requires=('states',),
              optional=('states.qd', 'states.torque_nm', 'torque_samples', 'scene_joint_limits'),
              description='Use of the physical joint limits: position from the range centre, |velocity| '
                          'and |torque| against the URDF limits; 100 % is the limit. Worst takes the '
                          'maximum at each sample; hover names the binding joint or quantity.',
              inputs={'joint': Choice(JOINT_CHOICES, 'worst', 'Joint', labels=('All', 'Worst', *(f'J{i}' for i in range(1, 8))),
                                      disabled_when={'all': {'quantity': 'all'}}),
                      'quantity': Choice(QUANTITY_CHOICES, 'all', 'Quantity',
                                         labels=('All', 'Worst', 'Torque', 'Velocity', 'Position'),
                                         disabled_when={'all': {'joint': 'all'}})})
def episode_joint_limit_use(data: EpisodeView, joint='worst', quantity='all'):
    if joint not in JOINT_CHOICES or quantity not in QUANTITY_CHOICES:
        raise ValueError(f'invalid joint/quantity {joint!r}/{quantity!r}')
    if joint == 'all' and quantity == 'all':
        raise ValueError('Joint and Quantity cannot both be All')
    joints = range(len(JOINTS)) if joint in ('all', 'worst') else [JOINTS.index(joint)]
    title = f"{TITLE} · {dict(all='all joints', worst='worst joint').get(joint) or f'J{joints[0] + 1}'}"
    if quantity not in ('all',):
        title += f" · {'worst quantity' if quantity == 'worst' else quantity}"
    limits = physical_limits(data.raw)
    if limits is None:
        return unavailable(title, 'No physical joint limits for this source.')
    settings = limit_settings(data.raw)
    quantities = QUANTITIES if quantity in ('all', 'worst') else (quantity,)
    tracks = {}  # quantity -> Tracks of the selected joints with recorded values and a limit
    for name in quantities:
        recorded = recorded_tracks(data, name)
        found = [Track(name, j, *recorded[j], limits, settings) for j in joints
                 if recorded[j][0] and limit_use(name, 0., j, limits) is not None]
        if found:
            tracks[name] = found
    if not tracks:
        return unavailable(title, f'No recorded {" / ".join(quantities)} with a physical limit in this range.')
    curves = []
    if quantity == 'all':
        for name in QUANTITIES:
            if name in tracks:
                curves.append(envelope(name.capitalize(), tracks[name], COLORS[name]))
            else:  # Visibly absent, never a zero line.
                curves.append(dict(series(f'{name.capitalize()}: not recorded', [], [], color=COLORS[name]), hover=[]))
    elif joint == 'all':
        for j in joints:
            selected = [track for name in tracks for track in tracks[name] if track.joint == j]
            if selected:
                curves.append(envelope(f'J{j + 1}', selected))
    else:
        selected = [track for name in tracks for track in tracks[name]]
        if quantity == 'worst':
            missing = [name for name in QUANTITIES if name not in tracks]
            label = 'Worst' if not missing else 'Worst of ' + ', '.join(name for name in QUANTITIES if name in tracks)
            curves.append(envelope(label, selected, WORST_COLOR))
        else:
            curves.append(envelope('Worst joint' if joint == 'worst' else f'J{joints[0] + 1}', selected, COLORS[quantity]))
    near = settings['limit_near_percent']
    spec = lines(title, curves, unit='%', y_label='Limit use',
                 guides=[dict(axis='y', value=100, label='limit', style='hard')],
                 notes=['100 % is the physical (URDF / scene) limit, not the MPC bounds. Position use is the '
                        'distance from the range centre over the half range.'])
    spec['bands'] = [dict(axis='y', start=near, end=100, tone='near', label=f'near ≥ {near:g} %'),
                     dict(axis='y', start=100, end=None, tone='beyond', label='beyond the limit')]
    spec['y']['span'] = [0, 105]
    return spec
