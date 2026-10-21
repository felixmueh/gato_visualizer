"""Public lightweight Python plotting SDK. Importing this package needs no solver."""
from .registry import plot_episode, plot_solve, Number, Boolean, Choice, Joint, Registry
from .views import EpisodeView, SolveView, Episode, Solve, InspectionContext, joint_index
from .spec import PlotSpec, Axis, Series, lines, series, table, unavailable, validate_spec
from .metrics import quantile, histogram, distance, path_length, peak

__all__ = ['plot_episode', 'plot_solve', 'Number', 'Boolean', 'Choice', 'Joint', 'Registry',
           'EpisodeView', 'SolveView', 'Episode', 'Solve', 'InspectionContext', 'PlotSpec',
           'Axis', 'Series', 'lines', 'series', 'table', 'unavailable', 'validate_spec',
           'joint_index', 'quantile', 'histogram', 'distance', 'path_length', 'peak']
