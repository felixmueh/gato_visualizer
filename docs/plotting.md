# Python plotting extension design

Discussion decisions from Felix, 2026-10-21. The Python plotting system,
directory settings and Episode/Solve inspectors implement this design.
See [plot-authoring.md](plot-authoring.md) for the runnable author workflow.
Inspection scopes and cursor behavior are defined in [inspection.md](inspection.md).

## Plot authorship and rendering

Python functions generate plot specifications. JavaScript renders those
specifications and handles presentation interactions, including zoom, hover,
selection markers, layout and dragging. Plot-specific numerical transforms,
aggregates and derived curves are computed in Python.

Use separate `@plot_solve` and `@plot_episode` decorators. Standard plots and
custom plots use the same API. A definition describes its name, configurable
inputs with defaults, and required/optional data as availability hints. Data
requirements do not impose a field-access restriction on the function.

Each function receives a broad, documented Solve or Episode view, with helpers
for common quantities and access to the complete retained record and additional
experiment-specific fields. Keep missing values and missing diagnostic records
explicit. An optional `.solver` exposes a genuinely attached local runtime
solver for prototyping; normal recorded/Replay contexts have no such handle.
The active MPC solver is not a historical selected Solve, and retaining a
Python reference does not freeze native/CUDA state.

## Discovery directories and settings

Always load the visualizer repository's bundled `plotters/` directory. Also
load a configurable project plotting directory, defaulting to
`<selected tiago_mpc checkout>/_visualizer`. Source/worktree selection determines
that default unless the user supplies an explicit plotting-directory override.
Expose the directory in the shared floating settings window and persist the
selection in local visualizer configuration. A missing project directory leaves
the bundled standard plots available.

## Catalog and plot instances

The Episode and Solve inspectors offer a + button opening the reusable floating
window with a searchable plot catalog. Adding a plot keeps that window open;
multiple instances of the same definition have independent settings. Plot cards
can be reordered by dragging. Compatible episode-time plots can be shown in
stacked rows above the episode timeline using a card button or drag-and-drop.
Dragging a timeline plot out removes that placement while preserving its sidebar
instance and configuration. Both placements share one instance's settings.

## Author verification: primary development requirement

Coding agents must be able to exercise a plot and verify its results without
starting the browser application, running MPC, or requiring a GPU. Code
completion is useful authoring support; an easy verification path is the higher
priority.

The design should provide:

- Small, deterministic example Solve and Episode inputs, including known
  expected values, missing optional telemetry and nonzero time origins.
- Direct invocation of the same Python plot functions used by the application;
  no separate testing implementation of their numerical logic.
- A reusable plot-spec validator checking supported kinds, axis identity,
  matching series lengths, valid values/gaps and serialization.
- Straightforward numerical assertions over the returned plot data, allowing
  agents to check representative values, units, selection and aggregation
  against the example input's known answers.
- A small command-line check that can select a plot, supply inputs, report
  useful failures and save its specification and a preview for inspection.
- The same browser renderer for previews and the application, so a preview can
  also reveal labels, scales, clipping and layout problems.

Structural validation and numerical assertions serve different purposes; the
validator alone does not establish the correctness of a derived metric. Each
standard plot should demonstrate a compact, meaningful correctness check that
custom plot authors can copy. Do not require a screenshot comparison for every
ordinary numerical plot.

## Authoring support

Expose decorators, Solve/Episode view types, helpers and plot-spec types through
a normal, lightweight Python package with type annotations and docstrings.
Dynamic discovery still uses ordinary imports in author-written plot files.
Provide a typed starter plot and editor/interpreter setup documentation. Public
GATO wrapper types can assist completion for an optional runtime solver; dynamic
native extension members may require additional stubs. No editor installation
or runtime changes are implied by this design document.
