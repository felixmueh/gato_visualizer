"""Tiny deterministic author inputs. Deliberately starts at episode time 10 s."""
from .views import EpisodeView, SolveView, InspectionContext


def example_solve(*, missing=False, context=None):
    raw = dict(id='solve-1', seq=1, sim_time_s=10., N=3, dt_s=.1,
               knot_time_s=[0., .1, .2], q=[[0., 1.], [.1, 1.1], [.2, 1.2]],
               qd_rad_s=[[1., 0.], [1., .5], [0., 0.]], torque_nm=[[2., -3.], [4., -1.]],
               ee_xyz=[[0., 0., 0.], [.1, 0., 0.], [.2, 0., 0.]],
               stats=dict(sqp_iters=2, pcg_iters=5, admm_iters=3, solve_time_ms=4., initial_merit=12., final_merit=3.),
               diagnostics=dict(initial_merit=12., final_merit=3., min_merit=[7., 3.], step_size=[1., .5], pcg_iters=[3, 2]),
               iterations=[dict(index=1, stats=dict(merit=7., pcg_iters=3, step_size=1.)),
                           dict(index=2, stats=dict(merit=3., pcg_iters=2, step_size=.5))],
               joint_limits=dict(q_min=[-1., -2.], q_max=[1., 2.], qd_max=[2., 2.], torque_max=[5., 5.]),
               extra_experiment=dict(tag='retained'))
    if missing:
        for key in ('qd_rad_s', 'torque_nm', 'diagnostics', 'iterations'):
            raw.pop(key)
        raw['stats'] = {}
    return SolveView(raw, context or InspectionContext())


def example_episode(*, missing=False, context=None):
    states = [dict(sim_time_s=10.+i*.1, q=[i*.1, .5], qd=[i*.5, 0.], torque_nm=[i+1., -1.],
                   ee_xyz=[i*.1, 0., 0.], target_xyz=[.3, 0., 0.], plan_seq=1 if i < 2 else 2)
              for i in range(4)]
    intervals = [dict(start_time_s=10.+i*.1, end_time_s=10.+(i+1)*.1, to_budget_s=.05,
                      solve_wall_s=[.02, .06, .01][i], physics_wall_s=[.01, .02, .11][i],
                      total_wall_s=[.04, .09, .12][i]) for i in range(3)]
    plan = dict(example_solve().raw)
    plan['request_time_s'] = plan['sim_time_s']
    second = dict(plan, id='solve-2', seq=2, sim_time_s=10.2,
                  request_time_s=10.2,
                  stats=dict(sqp_iters=1, pcg_iters=2, admm_iters=1, solve_time_ms=2.))
    if missing:
        states = [{key: value for key, value in state.items() if key not in ('qd', 'torque_nm', 'ee_xyz', 'target_xyz')} for state in states]
        intervals = []
    return EpisodeView(dict(states=states, plans=[plan, second] if not missing else [], intervals=intervals,
                            joint_limits=plan['joint_limits'], extra_experiment={'known': 42},
                            # Physical (scene) limits; here equal to the recorded bounds.
                            scene_joint_limits=dict(lower_position_rad=[-1., -2.], upper_position_rad=[1., 2.],
                                                    velocity_rad_s=[2., 2.], effort_nm=[5., 5.])), context or InspectionContext())


def example_comparison(*, missing=False, context=None):
    """Two linear signals with distinct clocks/rates and one early termination.

    Both are placed at session zero. Error is t metres in A and 2t in B;
    the common interval is [0, 1], giving RMS sqrt(1/3) and sqrt(4/3).
    """
    from .comparison import ComparisonView, ComparisonRun
    runs = []
    for key, origin, times, scale, color in [('a', 10., [0., .5, 1., 2.], 1., '#b48cff'),
                                            ('b', 20., [0., .25, .5, .75, 1.], 2., '#6fa8ff')]:
        states = [dict(sim_time_s=origin+t, q=[scale*t], qd_rad_s=[scale*t],
                       ee_xyz=[scale*t, 0., 0.], target_xyz=[0., 0., 0.], sensor=dict(temperature_c=20+t)) for t in times]
        controls = [dict(sim_time_s=origin+t, torque_nm=[scale*t]) for t in times]
        if missing and key == 'b':
            states = [{k: v for k, v in state.items() if k not in ('qd_rad_s', 'ee_xyz', 'target_xyz')} for state in states]
            controls = []
        episode = EpisodeView(dict(states=states, controls=controls, torque_samples=controls, joint_names=['arm_right_1_joint']))
        runs.append(ComparisonRun(key, 'Run '+key.upper(), episode, -origin, color, dict(kind='replay', id=key)))
    return ComparisonView(tuple(runs), context or InspectionContext(clock='session:fixture'))
