"""Bundled plots use the same public API as project-authored plots."""
from gato_visualizer.plotting import (
    plot_episode, plot_solve, Joint, Number, Choice, Boolean, EpisodeView, SolveView,
    lines, series, table, unavailable, histogram, quantile, distance, path_length, peak,
)
from gato_visualizer.plotting.views import number, finite, joint_index
from gato_visualizer.plotting.metrics import joint_value, bound_values, interval_coverage


def limit_guides(limits, mpc_bounds, quantity, joint):
    """URDF limits (hard, the limit-use reference) and MPC bounds (dashed), labelled.

    Live histories before 2026-10-22 stored the MPC bounds as joint_limits."""
    legacy = 'MPC' in str((limits or {}).get('source', ''))
    sets = [((limits or {}), 'MPC' if legacy else 'URDF', not legacy)]
    if mpc_bounds:
        sets.append((mpc_bounds, 'MPC', False))
    guides = []
    for values, name, urdf in sets:
        for label, value in bound_values(values, quantity, joint):
            if value is not None:
                guide = dict(axis='y', value=value, label=f"{name} {label.split()[0].lower()}")
                guides.append(dict(guide, style='hard') if urdf else guide)
    return guides


def scaled(value, factor=1000):
    value = number(value)
    return value * factor if value is not None else None


def row(label, value, unit='', note=''):
    return dict(label=label, value=value, unit=unit, note=note)


def interval_series(data, label, getter):
    x, y = [], []
    bounds = data.bounds
    for item in data.intervals:
        start, end = item['start_time_s'], item['end_time_s']
        if bounds:
            start, end = max(start, bounds[0]), min(end, bounds[1])
        if end <= start:
            continue
        if x and x[-1] == start and y[-1] is None:
            x.pop(); y.pop()
        x.extend([start, end]); y.extend([getter(item), None])
    return series(label, x, y, style='step')


@plot_episode(id='episode.timing', title='Timing and budgets', requires=('intervals',),
              inputs={'component': Choice(('mpc', 'physics', 'combined', 'all'), 'all', 'Component')})
def episode_timing(data: EpisodeView, component='all'):
    """Recorded host wall times against each interval's actual nominal budget."""
    definitions = {
        'mpc': [('MPC wall', lambda i: scaled(i.get('solve_wall_s', i.get('mpc_wall_s')))),
                ('TO deadline', lambda i: None if i.get('to_back_to_back') else scaled(i.get('to_budget_s', i.get('budget_s'))))],
        'physics': [('Physics wall', lambda i: scaled(i.get('physics_wall_s', i.get('simulation_wall_s')))),
                    ('Interval budget', lambda i: scaled(i['end_time_s']-i['start_time_s']))],
        'combined': [('Combined wall', lambda i: scaled(i.get('total_wall_s'))),
                     ('Interval budget', lambda i: scaled(i['end_time_s']-i['start_time_s']))],
    }
    selected = list(definitions) if component == 'all' else [component]
    curves = [interval_series(data, label, getter) for key in selected for label, getter in definitions[key]]
    return lines('Timing and budgets', curves, unit='ms', y_label='Measured wall time / budget',
                 notes=['Wall time is distinct from episode time. Back-to-back TO has no deadline; its deadline curve is absent. Combined-only overload is not a physics-only overrun.'])


@plot_episode(id='episode.iterations', title='Solver iteration counts', requires=('plans',))
def episode_iterations(data: EpisodeView):
    plans = data.plans
    return lines('Solver iteration counts', [series(key.upper(), [p['sim_time_s'] for p in plans],
                  [number(p.get('stats', {}).get(key + '_iters')) for p in plans], style='step') for key in ('sqp', 'pcg', 'admm')],
                 unit='iterations', y_label='Reported count')


@plot_episode(id='episode.tracking_error', title='End-effector tracking error', requires=('states',),
              optional=('states.ee_xyz', 'states.target_xyz', 'states.distance_m'))
def episode_tracking_error(data: EpisodeView):
    values = [scaled(distance(state)) for state in data.states]
    if not any(v is not None for v in values):
        return unavailable('End-effector tracking error', 'No recorded error or matching end-effector/reference positions.')
    return lines('End-effector tracking error', [series('Position error', [s['sim_time_s'] for s in data.states], values)], unit='mm', y_label='Position error')


@plot_episode(id='episode.joint', title='Recorded joint motion and bounds', requires=('states',),
              optional=('states.qd', 'states.torque_nm', 'joint_limits', 'mpc_bounds'),
              inputs={'joint': Joint(), 'quantity': Choice(('q', 'qd', 'torque_nm'), 'q', 'Quantity'), 'show_bounds': Boolean(True, 'Show URDF limits and MPC bounds')})
def episode_joint(data: EpisodeView, joint=0, quantity='q', show_bounds=True):
    joint = joint_index(joint, data.raw.get('joint_names', ()))
    states = data.states
    # Controls may have their own recording clock; never fabricate actuator measurements.
    source = data.raw.get('torque_samples', data.raw.get('torqueSamples', states)) if quantity == 'torque_nm' else states
    source = [s for s in source if data.in_range(s.get('sim_time_s'))]
    values = [joint_value(s, quantity, joint) for s in source]
    title = f'Recorded J{joint + 1} {quantity}'
    if not any(value is not None for value in values):
        return unavailable(title, f'No recorded {quantity} values for joint {joint + 1}.')
    units = {'q': 'rad', 'qd': 'rad/s', 'torque_nm': 'Nm'}
    guides = limit_guides(data.raw.get('joint_limits', {}), data.raw.get('mpc_bounds'), quantity, joint) if show_bounds else []
    return lines(title, [series('Recorded motion' if quantity != 'torque_nm' else 'Recorded actuator torque',
                 [s['sim_time_s'] for s in source], values, style='step' if quantity == 'torque_nm' else 'line')],
                 unit=units[quantity], y_label=quantity, guides=guides,
                 notes=['Native joint coordinates. Solid: URDF limits; dashed: MPC bounds. Recorded values only; absent bounds are not reconstructed.'])


@plot_episode(id='episode.timing_histogram', title='MPC wall-time histogram', requires=('intervals',),
              inputs={'bins': Number(10, 'Bins', '', 1, 100)})
def episode_timing_histogram(data: EpisodeView, bins=10):
    if int(bins) != bins:
        raise ValueError('bins must be an integer')
    values = [scaled(item.get('solve_wall_s', item.get('mpc_wall_s'))) for item in data.intervals]
    x, counts, edges = histogram(values, int(bins))
    bars = series('Recorded intervals', x, counts, style='bar')
    if edges:
        bars['bin_edges'] = edges
    return lines('MPC wall-time histogram', [bars], kind='bars',
                 identity='wall_time', x_label='MPC wall time', x_unit='ms', y_label='Count', unit='intervals',
                 notes=[f'{sum(counts)} intervals. Full intersecting interval measurements; no duration weighting.'])


@plot_episode(id='episode.summary', title='Episode aggregates', requires=('states',), optional=('plans', 'intervals'))
def episode_summary(data: EpisodeView):
    states = data.states
    walls = [scaled(i.get('solve_wall_s', i.get('mpc_wall_s'))) for i in data.intervals]
    shares = interval_coverage(data.intervals, data.bounds)
    covered = shares['covered_s']
    errors = [distance(s) for s in states]
    rows = [row('Analysis duration', max(0., data.bounds[1] - data.bounds[0]) if data.bounds else None, 's'),
            row('Retained states', len(states)),
            row('Recorded controller solves', sum(p.get('origin') != 'preview' for p in data.plans)),
            row('MPC wall median', quantile(walls, .5), 'ms'), row('MPC wall p95', quantile(walls, .95), 'ms'),
            row('Recorded EE path length', path_length([s.get('ee_xyz') for s in states]), 'm'),
            row('Final target error', scaled(errors[-1]) if errors else None, 'mm'),
            row('Minimum target error', scaled(min((e for e in errors if e is not None), default=None)), 'mm')]
    for key, label in [('mpc', 'MPC over-budget share'), ('physics', 'Physics over-budget share'), ('combined_only', 'Combined-only over-budget share')]:
        rows.append(row(label, shares[key]/covered*100 if covered else None, '%', 'Union of covered interval durations; MPC has precedence.'))
    return table('Episode aggregates', rows, notes=['Uses the host-selected analysis range. Timing is visualizer diagnostic evidence, not an experiment benchmark.'])


@plot_solve(id='solve.prediction_joint', title='Selected prediction joint profile', requires=('prediction',),
            optional=('joint_limits', 'mpc_bounds'),
            inputs={'joint': Joint(), 'quantity': Choice(('q', 'qd', 'torque_nm'), 'q', 'Quantity'), 'show_bounds': Boolean(True, 'Show URDF limits and MPC bounds')})
def solve_prediction_joint(data: SolveView, joint=0, quantity='q', show_bounds=True):
    joint = joint_index(joint, data.raw.get('joint_names', ()))
    prediction = data.prediction
    title = f'Predicted J{joint + 1} {quantity}'
    if prediction is None:
        return unavailable(title, 'No trajectory snapshot was recorded for the selected SQP iteration.')
    key = 'qd_rad_s' if quantity == 'qd' and 'qd_rad_s' in prediction else quantity
    values = [number(sample[joint]) if sample is not None and len(sample) > joint else None for sample in prediction.get(key, ())]
    times = prediction.get('torque_time_s', data.horizon_time_s[:len(values)]) if quantity == 'torque_nm' else data.horizon_time_s
    if not values or not times or len(values) != len(times):
        return unavailable(title, f'No matching prediction clock and {quantity} samples for this selection.')
    if quantity == 'torque_nm':
        end = prediction.get('torque_end_time_s', data.horizon_time_s[-1] if data.horizon_time_s else None)
        if finite(end) and times and end > times[-1]:
            times = list(times) + [end]
            values.append(None)  # End the held nonterminal command at the terminal knot.
    limits = prediction.get('joint_limits', data.raw.get('joint_limits', {}))
    mpc = prediction.get('mpc_bounds', data.raw.get('mpc_bounds'))
    guides = limit_guides(limits, mpc, quantity, joint) if show_bounds else []
    return lines(title, [series('Predicted motion' if quantity != 'torque_nm' else 'Predicted actuator torque', times, values,
                  style='step' if quantity == 'torque_nm' else 'line')], identity='prediction_time',
                 x_label='Prediction horizon offset', unit={'q': 'rad', 'qd': 'rad/s', 'torque_nm': 'Nm'}[quantity],
                 y_label=quantity, guides=guides, notes=['Prediction is distinct from executed episode motion.'])


def trace_values(data, field):
    aliases = {'merit': ('merit', 'min_merit'), 'pcg_iters': ('pcg_iters',), 'step_size': ('step_size',)}[field]
    values, indices = [], []
    for item in data.iterations:
        stats = item.get('stats', item)
        value = next((stats[key] for key in aliases if key in stats), None)
        indices.append(item['index']); values.append(number(value))
    if any(value is not None for value in values):
        return indices, values
    diagnostics = data.raw.get('diagnostics', {})
    for key in aliases:
        trace = diagnostics.get(key)
        if trace is not None:
            while isinstance(trace, (tuple, list)) and len(trace) == 1 and isinstance(trace[0], (tuple, list)):
                trace = trace[0]
            if isinstance(trace, (tuple, list)):
                return list(range(len(trace))), [number(v) for v in trace]
    return [], []


@plot_solve(id='solve.iteration_trace', title='Recorded SQP traces', optional=('iterations', 'diagnostics'),
            inputs={'metric': Choice(('merit', 'pcg_iters', 'step_size'), 'merit', 'Metric')})
def solve_iteration_trace(data: SolveView, metric='merit'):
    indices, values = trace_values(data, metric)
    if not values:
        return unavailable('Recorded SQP traces', f'No recorded {metric} trace. Missing iterations are not fabricated.')
    return lines('Recorded SQP traces', [series(metric, indices, values)], identity='sqp_iteration',
                 x_label='Recorded SQP iteration', x_unit='index', y_label=metric,
                 unit='iterations' if metric == 'pcg_iters' else '',
                 notes=['Graph marker follows the host SQP cursor. A finite result is not a convergence certificate.'])


@plot_solve(id='solve.summary', title='Solve summary', optional=('stats', 'prediction'))
def solve_summary(data: SolveView):
    prediction, stats = data.prediction or {}, data.stats
    times = data.horizon_time_s
    rows = [row('Solve identity', str(data.identity) if data.identity is not None else None),
            row('Prediction duration', times[-1]-times[0] if times else None, 's'),
            row('Predicted EE path length', path_length(prediction.get('ee_xyz', ())), 'm'),
            row('Peak predicted joint speed', peak(prediction.get('qd_rad_s', prediction.get('qd', ()))), 'rad/s'),
            row('Peak predicted actuator torque', peak(prediction.get('torque_nm', ())), 'Nm', 'Nonterminal controls only.'),
            row('Solver reported solve time', number(stats.get('solve_time_ms')), 'ms')]
    rows += [row(f'{key.upper()} iterations', number(stats.get(key + '_iters'))) for key in ('sqp', 'pcg', 'admm')]
    for key, label in [('initial_merit', 'Initial merit'), ('final_merit', 'Final merit')]:
        value = stats.get(key, data.raw.get('diagnostics', {}).get(key))
        while isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
        rows.append(row(label, number(value)))
    return table('Solve summary', rows, notes=['No residual/KKT acceptance gate. Missing telemetry remains unavailable.'])
