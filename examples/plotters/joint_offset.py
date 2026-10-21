"""Typed project plot: save in <selected tiago_mpc>/_visualizer/ to discover it."""
from gato_visualizer.plotting import (
    EpisodeView, Joint, Number, PlotSpec, joint_index, lines, plot_episode, series,
)


@plot_episode(
    id='example.joint_offset',
    title='Joint displacement from first retained sample',
    description='A small example using host analysis range and native joint names.',
    requires=('states.q',),
    inputs={'joint': Joint(), 'scale': Number(1., 'Scale', '', 0., 10.)},
)
def joint_offset(data: EpisodeView, joint: str = 'arm_right_1_joint', scale: float = 1.) -> PlotSpec:
    index = joint_index(joint, data.joint_names)
    positions = [state.get('q') for state in data.states]
    initial = next((q[index] for q in positions if q is not None and len(q) > index), None)
    values = [(q[index] - initial) * scale if initial is not None and q is not None and len(q) > index else None
              for q in positions]
    return lines('Joint displacement', [series('Native joint displacement', data.time_s, values)],
                 y_label='Displacement', unit='rad')
