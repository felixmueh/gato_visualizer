# Visualizer-owned settings adapters

This experimental visualizer branch owns standard display metadata in
`adapters/tiago.py`. Ordinary controls are generated from native parameters;
the bundled adapter adds no extra native fields and preserves the package's
objects and ordinary execution law. It works with every compatible checkout,
without a visualizer file in `tiago_mpc` or special treatment of a branch name.

An optional `<selected-tiago>/_visualizer/_settings.py` overrides the bundled
adapter. Keep this directory locally ignored through Git's `info/exclude`, so
it adds no tracked TIAGo files. The underscore prevents the plotter loader from
importing it as a plot. An invalid file or broken symlink is a visible source
error; the loader never silently falls back from a requested override.

The friction adapter and its tests live in this repository:
`adapters/friction_compensation.py` and `tests/test_friction_adapter.py`.
The current friction worktree's ignored override is a relative symlink to that
adapter, giving the code one owner. A local experiment can instead supply its
own ordinary Python file. When its native feature becomes standard, promote
the reviewed descriptors/builders into the bundled adapter and remove the
local override. Controller algorithms, physics, native defaults and experiment
presets stay in `tiago_mpc`; the browser receives ordinary JSON.

## Module API

```python
def describe():
    return {
        "simulation": {
            "defaults": {"armature_on": True, "armature": [.5] * 7},
            "parameters": [
                {"path": "armature_on", "kind": "bool", "label": "Plant armature"},
                {"path": "armature", "kind": "vector", "length": 7, "min": 0,
                 "label": "Reflected inertia", "unit": "kg m²",
                 "enabled_if": {"armature_on": True}},
            ],
            "controls": ["armature"],
        },
        "predictor": {"defaults": {}, "parameters": [], "controls": []},
    }

def build_simulation(values, base_sim_config):
    # Return this checkout's actual SimConfig and a callable ControlLaw.
    return sim_config, law

def build_predictor(values, base_mpc_params):
    # Return the active profile's actual MpcParams.
    return params
```

Only `describe()` is mandatory. A role with no extra parameters or claimed
controls needs no builder; the visualizer preserves its native base object and
default law. No default values are duplicated in an empty standard adapter.

The first real example is `adapters/friction_compensation.py`.
It exposes independent plant/predictor armature toggles, predictor friction,
scalar smoothing widths and default/PD/friction-FF/both. The per-joint armature
and friction coefficients stay in code; effective native objects still record
them. PD gains also stay in the tuned code preset. It changes no MPC costs or
timing.

Descriptors use relative dotted `path`, `label`, optional `group`/`unit`/
`description`, and `kind` (`bool`, `float`, `int`, `choice`, `vector`). A vector
has a fixed positive `length`. Numeric bounds are `min`/`max`; set
`min_exclusive`/`max_exclusive` to express an open bound such as tanh width > 0.
A choice contains values or `{value, label}` entries. `visible_if` and
`enabled_if` map another field in the same scope to an equal value or a list
of accepted values. Conditions only affect presentation: inactive values are
still complete, finite and validated. Defaults occur once in each role.
Optional `effect` is `runtime` or `compiled_model`; it supplies a tooltip and
declares whether an edit invalidates native-model readiness. Explicit runtime
fields reuse the current readiness result without another lookup. Unannotated
predictor fields are checked conservatively when changed. Annotate accurately:
a predictor builder must not change compiled dynamics based on a runtime field.
The package's lookup of the resolved native configuration still decides which
binary is compatible; these annotations do not construct a binary/cache key.

`controls` declares the native fields a builder may change, with prefix
ownership: `armature` covers that field, while `friction.coulomb_nm` covers
only those coefficients. `law` is the simulation role's execution-law slot.
The corresponding builtin parameter is read-only and displays the actual
resolved value. There are never two editable owners for one native field.
Simulation builders cannot change runtime q, qd or integration substep.

There is no registration/decorator API, arbitrary JavaScript or custom object
serialization across processes. Keep providers as small ordinary functions.

## Source, profile and effective values

Simulation adapter selection belongs to the simulator checkout. Its coordinator builds
the plant and law. Predictor settings belong to the active solver profile;
that profile's interpreter builds native `MpcParams`. Choosing a different
profile cannot replace the simulator's plant or law.

The schema publishes `source_settings.simulation` and `.predictor` descriptor
sections; defaults and accepted settings carry values in the same two scopes.
For example, the existing agent CLI can patch the law:

```bash
python scripts/control.py --url http://127.0.0.1:8094 patch live \
  '{"source_settings":{"simulation":{"law":"both"}}}'
```

The accepted response also contains `effective_settings` with native serialized
`params`, `plant`, `law`, and the two loaded module identities. Native predictor
values are resolved before accepting an exact-model settings change. Simulation
objects are resolved in the coordinator before stepping; a source-specific
cross-field/builder error stops that affected generation through the normal
worker error path. This is not a promise that every arbitrary provider's
semantic errors can be detected by descriptors alone.

The segment header records requested values, the selected adapter and actual native
objects. Freeze retains them. Replay display reads this captured JSON and
motion; it does not import current provider code to reconstruct a historical
law. Native Run again/inspection uses captured predictor parameters and skips
all current provider import, description and build functions.
Recordings from the previous nested `Friction.law` API remain viewable, but
Run again reports that the original checkout is required. The viewer does not
convert their captured native parameters or substitute current defaults.

## Compiled models and explicit Build

The Live form offers all `supported_N` values, including uncompiled ones. That
domain is separate from `available_N`, which describes cached modules. A missing
draft remains editable and visibly shaded; it does not replace accepted native
settings. The same centered Compile action covers knot count, predictor
armature, friction and combinations of these settings. Existing cached models
apply normally without compiling. The advanced Backend build panel remains
available for preparing other sources.

Goal position, orientation, task shape, execution timing and simulator/law
settings never invalidate predictor-model readiness. Native settings marked
`effect: runtime` also bypass redundant checks. Runtime edits during an existing
lookup share its result, and submitting settings reads the latest values.
Unknown native/predictor fields remain check dependencies. Source, profile,
cache and adapter identity still invalidate readiness. Checks run asynchronously
without a viewport banner; only a missing model, build or error shows the
Compile prompt. Task handles remain editable while checking or selecting a
missing model; calculation still waits for a compatible model.

`POST /api/source/model` is a read-only draft check. It takes the active
profile's `selection`, full serialized native `params` without the plant group,
predictor `source_settings`, and `source_settings_module` pin. It resolves those
objects in the selected interpreter and calls the package's `find_binary`.
The result includes actual effective params and
`compilation={ready,N,supported_N,available_N,binary_path}`. Missing binaries are
a valid `ready:false` status. This endpoint never accepts settings or compiles.

Thus runtime-only edits reuse their native binary, while predictor armature
on/off, predictor friction and N select their actual native compiled variant.
The visualizer does not reconstruct a binary name or maintain a separate
compilation-key algorithm. Model hashes, native sources/toolchain and Python
ABI remain the package/cache's responsibility. All seven armature values enter
the predictor's native model identity; off is the actual zero-armature model.
Plant armature, external FF and PD gains do not change the predictor binary.

Compile freezes the current full draft and passes exactly those values/pin to
the existing explicit Build service with just its selected N. The prompt shows
progress and failure logs. On completion, the browser rechecks its latest
draft; it applies only a ready model in the same active profile, interpreter,
effective cache and adapter scope. Edits during compilation survive, and a
completed old draft is never substituted for a different current one. Source
Apply/profile changes invalidate stale checks. No compilation is automatic.

`exact_availability: true` means `available_N` describes the resolved predictor
model, including armature, friction coefficients and width. It is not inferred
from an on/off label. The selected interpreter calls the package's
`find_binary(replace(actual_params, N=n))`; ordinary edits never compile.
A bundled adapter identity with no predictor controls does not itself narrow
the ordinary off/on module catalog. Explicit native params and model-changing
predictor adapters retain exact checks.

Explicit Build accepts the frozen requested native base `params`, predictor
`source_settings`, and `source_settings_module` identity. It resolves that same
draft and calls `compile_binary` with those actual parameters. A foreign target
without a draft uses that target's own defaults/provider. Plant and law changes
do not themselves require a predictor binary.

An uncompiled draft X is rejected without replacing accepted model Y. A matching
Build may compile X, but the active availability/effective values remain Y until
X is submitted and accepted normally. A matching-source completion can trigger
that retry without a restart; a different interpreter or cache cannot refresh
the active model. Draft values remain available for explicit Build.

## Code lifetime and identity

The module is loaded once per owning process. Its identity contains `origin`
(`bundled` or `worktree`), the resolved absolute target path, and SHA256 of the
exact Python bytes executed. A symlink records its target, rather than only a
forwarding file whose imports could change unnoticed. Source Apply, including reapplying
the same path, reloads source-bound processes. Profile activation loads the new
predictor's provider. Editing a provider file does not hot-patch an active law.
Build and exact-model probes can pin the active module identity; a changed file
requires Apply rather than silently mixing new code with old UI values.

Field shape is fixed until Apply; law choices change visibility within that
shape. Existing compatible-setting restoration uses new explicit defaults for
new/unsupported fields. Historical segments and replays are never rewritten.

## Local setup

The current friction checkout's ignored `_visualizer/_settings.py` points to
`../../tiago_mpc_visualizer-friction-compensation/adapters/friction_compensation.py`.
That relative sibling layout works on the host and in the container. Its local
ignore entry is `/_visualizer/` in the TIAGo repository's `info/exclude`; no
tracked `.gitignore` or package API was changed. Git shares that exclude file
between linked worktrees. Tracked files would remain tracked despite this rule.

Check with `git check-ignore -v _visualizer/_settings.py` from the checkout.
Remove the override to use the bundled adapter, then use Source Apply.
Apply reloads changed code; ordinary parameter edits do not hot-patch it.
