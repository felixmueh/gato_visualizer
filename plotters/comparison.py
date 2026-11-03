"""Bundled comparative plots; direct-callable functions over captured episodes."""
import math

from gato_visualizer.plotting import (
    Channel, Choice, ComparisonView, lines, plot_comparison, series, unavailable,
)
from gato_visualizer.plotting.comparison import clipped_segments, intersect, signal_rms
from gato_visualizer.plotting.metrics import distance
from gato_visualizer.plotting.views import finite


def errors(run):
    raw = run.episode.raw
    reference = raw.get('scene', {}).get('retained_replay', {}).get('reference') or {}
    reference_times = reference.get('time_s')
    support = (min(reference_times), max(reference_times)) if reference_times else None
    result = []
    for state in run.episode.all_states:
        if not finite(state.get('sim_time_s')):
            continue
        original_time = state.get('recorded_time_s', state['sim_time_s']+raw.get('time_origin_s', 0))
        # Scene interpolation holds reference endpoints visually; analysis must
        # not extend a timed reference beyond the data that was recorded.
        value = (None if support and not support[0] <= original_time <= support[1] and not finite(state.get('distance_m'))
                 else distance(state))
        result.append((state['sim_time_s']+run.offset_s, value))
    return tuple(result)


def _windowed(samples, bounds):
    return [(time, value) for time, value in samples if bounds is not None and bounds[0] <= time <= bounds[1]]


def _labels(data):
    labels = [run.label for run in data.runs]
    return {run.key: run.label if labels.count(run.label) == 1 else f'{run.label} ({run.key})' for run in data.runs}


def _bars(data, title, values, unit, notes=()):
    labels = _labels(data)
    curves = []
    for run, value, detail in values:
        item = series(labels[run.key], [labels[run.key]], [value], color=run.color, style='bar')
        item['hover'] = [f'{labels[run.key]} · {detail}']
        curves.append(item)
    return lines(title, curves, identity='category', x_label='Run', x_unit='', y_label=title, unit=unit, kind='bars', notes=notes)


def coverage(run, valid_s, bounds):
    total = max(0., bounds[1]-bounds[0]) if bounds else 0.
    span = run.bounds
    duration = max(0., span[1]-span[0]) if span else 0.
    return f'valid {valid_s:.4g}/{total:.4g} s; recorded span {duration:.4g} s'


@plot_comparison(id='comparison.tracking_error', title='Tracking error by run', requires=('runs',),
                 optional=('states.ee_xyz', 'states.target_xyz', 'states.distance_m'))
def tracking_error(data: ComparisonView):
    curves, notes = [], []
    for run in data.runs:
        samples = _windowed(errors(run), data.run_bounds(run))
        if not any(value is not None for _, value in samples):
            notes.append(f'{run.label}: no recorded error or matching end-effector/reference positions.')
            continue
        curves.append(series(run.label, [t for t, _ in samples], [None if v is None else v*1000 for _, v in samples], color=run.color))
    if not curves or len(data.available_runs) < 2:
        return unavailable('Tracking error by run', 'Load at least two recorded episodes with tracking data. Missing references are not reconstructed.')
    return lines('Tracking error by run', curves, identity='session_time', x_label='Session time', unit='mm', y_label='Position error',
                 notes=[*notes, "Each run uses its own recorded reference. Curves end at recorded support; offsets only place them on session time."])


@plot_comparison(id='comparison.tracking_summary', title='Tracking comparison', requires=('runs',),
    inputs={'metric': Choice(('rms', 'peak'), 'rms', 'Metric', labels=('Time-weighted RMS error', 'Peak error'))})
def tracking_summary(data: ComparisonView, metric='rms'):
    bounds = data.common_bounds
    if bounds is None or bounds[1] <= bounds[0]:
        return unavailable('Tracking comparison', 'The selected runs have no shared recorded time interval in this window.')
    values = []
    for run in data.runs:
        samples = errors(run)
        rms, valid_s = signal_rms(samples, bounds)
        peaks = [max(abs(a), abs(b)) for _, _, a, b in clipped_segments(samples, bounds)]
        value = rms if metric == 'rms' else max(peaks, default=None)
        values.append((run, None if value is None else value*1000,
                       ('unavailable; ' if value is None else f'{value*1000:.4g} mm; ')+coverage(run, valid_s, bounds)))
    return _bars(data, 'Tracking RMS error' if metric == 'rms' else 'Peak tracking error', values, 'mm',
                 notes=[f'Common session interval {bounds[0]:.6g}–{bounds[1]:.6g} s. Error is linearly interpolated only between consecutive valid recorded values; RMS integrates its square over valid duration.',
                        'Unequal coverage and early termination remain in hover/context; the shared prefix does not establish task success.'])


def _vector(record, names):
    value = next((record[name] for name in names if name in record), None)
    return tuple(float(v) for v in value) if isinstance(value, (tuple, list)) and value and all(finite(v) for v in value) else None


def _speed_metric(run, bounds, acceleration):
    samples = [(s['sim_time_s']+run.offset_s, _vector(s, ('qd', 'qd_rad_s')))
               for s in run.episode.all_states if finite(s.get('sim_time_s'))]
    integral = duration = 0.
    for (t0, v0), (t1, v1) in zip(samples, samples[1:]):
        if v0 is None or v1 is None or len(v0) != len(v1) or t1 <= t0:
            continue
        clipped = intersect((t0, t1), bounds)
        if clipped is None or clipped[1] <= clipped[0]:
            continue
        lo, hi = clipped
        if acceleration:
            integral += (hi-lo)*sum(((b-a)/(t1-t0))**2 for a, b in zip(v0, v1))
        else:
            for a, b in zip(v0, v1):
                slope = (b-a)/(t1-t0)
                x, y = a+slope*(lo-t0), a+slope*(hi-t0)
                integral += (hi-lo)*(x*x+x*y+y*y)/3
        duration += hi-lo
    return (math.sqrt(max(0., integral/duration)) if duration else None), duration


def _command_variation(run, bounds):
    raw = run.episode.raw
    records = raw.get('torque_samples', raw.get('controls', ()))
    samples = [(s['sim_time_s']+run.offset_s, _vector(s, ('torque_nm',))) for s in records if finite(s.get('sim_time_s'))]
    variation = duration = 0.
    for (t0, u0), (t1, u1) in zip(samples, samples[1:]):
        if u0 is None or u1 is None or len(u0) != len(u1) or t1 <= t0:
            continue
        clipped = intersect((t0, t1), bounds)
        if clipped is not None:
            duration += max(0., clipped[1]-clipped[0])
        # The command is held until t1; count jumps within (lo, hi].
        if bounds[0] < t1 <= bounds[1]:
            variation += math.sqrt(sum((b-a)**2 for a, b in zip(u0, u1)))
    return (variation/duration if duration else None), duration


@plot_comparison(id='comparison.smoothness', title='Motion and command smoothness', requires=('runs',),
    inputs={'metric': Choice(('command_tv_rate', 'acceleration_rms', 'velocity_rms'), 'command_tv_rate', 'Metric',
        labels=('Command total variation / duration', 'Acceleration RMS from recorded velocity', 'Joint speed RMS'))})
def smoothness(data: ComparisonView, metric='command_tv_rate'):
    bounds = data.common_bounds
    if bounds is None or bounds[1] <= bounds[0]:
        return unavailable('Motion and command smoothness', 'The selected runs have no shared recorded time interval in this window.')
    title, unit = {'command_tv_rate': ('Command total variation / duration', 'Nm/s'),
                   'acceleration_rms': ('Joint acceleration RMS', 'rad/s²'),
                   'velocity_rms': ('Joint speed RMS', 'rad/s')}[metric]
    values = []
    for run in data.runs:
        value, valid_s = (_command_variation(run, bounds) if metric == 'command_tv_rate' else
                          _speed_metric(run, bounds, metric == 'acceleration_rms'))
        values.append((run, value, ('unavailable; ' if value is None else f'{value:.4g} {unit}; ')+coverage(run, valid_s, bounds)))
    return _bars(data, title, values, unit, notes=[
        f'Common session interval {bounds[0]:.6g}–{bounds[1]:.6g} s; Euclidean norm across the recorded joints.',
        'Command variation sums recorded torque jumps and divides by covered duration. Acceleration is finite differences of recorded velocity; speed RMS integrates piecewise-linear recorded velocity. No velocity is inferred from positions.',
        'Sampling, sensor filtering and command semantics affect smoothness. Missing channels stay unavailable; short successful-looking prefixes do not establish task success.'])


def _control_effort_integral(run, bounds):
    """Observed integral of applied torque squared, with command ZOH support.

    A missing command ends support until another finite complete vector arrives.
    The last command can hold to the recorded episode end, never past it.
    """
    bounds = intersect(run.bounds, bounds) if bounds is not None else None
    if bounds is None:
        return [], [], None, 0.
    raw = run.episode.raw
    records = raw.get('torque_samples') or raw.get('controls', ())
    joints = len(run.episode.joint_names)
    xs, ys, total, valid_s, last_end = [], [], 0., 0., bounds[0]
    for index, record in enumerate(records):
        time = record.get('sim_time_s')
        next_time = records[index+1].get('sim_time_s') if index+1 < len(records) else run.bounds[1]-run.offset_s
        torque = _vector(record, ('torque_nm',))
        if not finite(time) or not finite(next_time) or torque is None or len(torque) != joints:
            continue
        span = intersect((time+run.offset_s, next_time+run.offset_s), bounds)
        if span is None or span[1] <= span[0]:
            continue
        lo, hi = span
        increment = sum(value*value for value in torque)*(hi-lo)
        if not math.isfinite(increment) or not math.isfinite(total+increment):
            continue
        if lo > last_end:
            xs.append((last_end+lo)/2); ys.append(None)
        if not xs or xs[-1] != lo or ys[-1] is None:
            xs.append(lo); ys.append(total)
        total += increment
        valid_s += hi-lo
        xs.append(hi); ys.append(total)
        last_end = hi
    if last_end < bounds[1]:
        xs.extend(((last_end+bounds[1])/2, bounds[1])); ys.extend((None, None))
    return xs, ys, total if valid_s else None, valid_s


@plot_comparison(id='comparison.control_effort', title='Squared control effort', requires=('runs',),
    description='Integral of the recorded applied torque norm squared. Effort cost proxy, not mechanical work or energy.',
    optional=('torque_samples', 'controls'),
    inputs={'view': Choice(('cumulative', 'total'), 'cumulative', 'View',
                           labels=('Cumulative integral', 'Total by run'))})
def control_effort(data: ComparisonView, view='cumulative'):
    bounds = data.common_bounds
    if bounds is None or bounds[1] <= bounds[0]:
        return unavailable('Squared control effort', 'The selected runs have no shared recorded time interval in this window.')
    curves, values, notes = [], [], [
        f'Common session interval {bounds[0]:.6g}–{bounds[1]:.6g} s. Integral starts at zero at this interval, using zero-order-held recorded applied torque.',
        'Effort cost proxy ∫Σⱼτ_applied,j² dt, not mechanical work or energy. No predicted or requested torque is substituted.',
        'The last recorded command holds only to the episode end. Missing/nonfinite/incomplete vectors break support; partial integrals exclude gaps rather than treating them as zero effort. Compare valid coverage before totals.']
    labels = _labels(data)
    for run in data.runs:
        xs, ys, total, valid_s = _control_effort_integral(run, bounds)
        detail = coverage(run, valid_s, bounds)
        values.append((run, total, ('unavailable; ' if total is None else f'{total:.6g} Nm²·s; ')+detail))
        if total is None:
            notes.append(f'{run.label}: no supported recorded applied torque in this interval; {detail}.')
            continue
        item = series(labels[run.key], xs, ys, color=run.color)
        item['hover'] = [None if value is None else f'{labels[run.key]} · observed integral {value:.6g} Nm²·s; {detail}' for value in ys]
        curves.append(item)
    if view == 'total':
        return _bars(data, 'Squared control effort', values, 'Nm²·s', notes=notes)
    if not curves:
        return unavailable('Squared control effort', 'No supported recorded applied torque in the common interval; predicted/requested torques are not substituted.')
    return lines('Squared control effort', curves, identity='session_time', x_label='Session time',
                 y_label='∫ ||τ applied||² dt', unit='Nm²·s', notes=notes)


@plot_comparison(id='comparison.channel', title='Recorded channel by run', requires=('runs',), inputs={'channel': Channel()})
def recorded_channel(data: ComparisonView, channel=''):
    descriptor = next((item for item in data.channels if item['value'] == channel), None)
    if descriptor is None:
        return unavailable('Recorded channel by run', 'Choose a genuinely recorded numeric channel from the current runs.')
    curves, notes = [], []
    bucket = channel.split('.')[0]
    for run in data.runs:
        bounds = data.run_bounds(run)
        samples = list(_windowed(run.channel(channel), bounds))
        if bucket == 'intervals':
            # Interval values are complete measurements on their own support.
            samples = []
            values = dict(run.channel(channel))
            for item in run.episode.raw.get('intervals', ()):
                start, end = item.get('start_time_s'), item.get('end_time_s')
                if bounds is None or not finite(start) or not finite(end):
                    continue
                span = intersect((start+run.offset_s, end+run.offset_s), bounds)
                if span is None:
                    continue
                value = values.get(start+run.offset_s)
                samples.extend(((span[0], value), (span[1], None)))
        if not any(v is not None for _, v in samples):
            notes.append(f'{run.label}: channel unavailable in the selected window.')
            continue
        curves.append(series(run.label, [t for t, _ in samples], [v for _, v in samples], color=run.color,
                             style='step' if bucket in ('controls', 'torque_samples', 'intervals') else 'line'))
    if not curves or len(data.available_runs) < 2:
        return unavailable('Recorded channel by run', 'Load at least two recorded episodes; this channel has no usable values in the selected window.')
    return lines(descriptor['label'], curves, identity='session_time', x_label='Session time', unit=descriptor['unit'],
                 y_label=descriptor['label'], notes=[*notes, 'Recorded numeric values on their own clocks, offset onto session seconds. No extrapolation; absent values break the curve.'])
