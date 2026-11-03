"""Public lightweight Python plotting SDK. Importing this package needs no solver."""
from .registry import plot_episode, plot_solve, plot_comparison, Number, Boolean, Choice, Channel, Joint, Registry
from .views import EpisodeView, SolveView, Episode, Solve, InspectionContext, joint_index
from .comparison import ComparisonView, ComparisonRun
from .spec import PlotSpec, Axis, Series, lines, series, table, unavailable, validate_spec
from .metrics import quantile, histogram, distance, path_length, peak

__all__ = ['plot_episode', 'plot_solve', 'plot_comparison', 'Number', 'Boolean', 'Choice', 'Channel', 'Joint', 'Registry',
           'ComparisonView', 'ComparisonRun',
           'EpisodeView', 'SolveView', 'Episode', 'Solve', 'InspectionContext', 'PlotSpec',
           'Axis', 'Series', 'lines', 'series', 'table', 'unavailable', 'validate_spec',
           'joint_index', 'quantile', 'histogram', 'distance', 'path_length', 'peak']
