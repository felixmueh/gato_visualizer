"""Task defaults and selective copies for one shared Live session."""
from copy import deepcopy

from native_cost import cost_weights


GROUPS = ("config", "task", "execution", "source_settings")
ATOMIC = {"config.cost"}


def settings_only(value):
    """Detach the four editable settings groups from an API snapshot."""
    return {key: deepcopy(value.get(key, {})) for key in GROUPS}


def merge_settings(current, patch):
    result = deepcopy(current)
    for key, value in patch.items():
        result[key] = (merge_settings(result[key], value)
                       if isinstance(value, dict) and isinstance(result.get(key), dict)
                       else deepcopy(value))
    return result


def resolve_task_settings(defaults, overrides):
    """Resolve one session without merging native objects into a different objective."""
    result = merge_settings(defaults, overrides)
    configuration = overrides.get("config", {})
    if "cost" in configuration:
        result["config"]["cost"] = deepcopy(configuration["cost"])
        if cost_weights(configuration["cost"]) is None:
            result["config"].pop("cost_weights", None)
    return result


def task_defaults(schema, kind):
    """Resolve general defaults and one task descriptor's default overrides."""
    descriptor = next((task for task in schema["tasks"] if task["kind"] == kind), None)
    if descriptor is None:
        raise ValueError(f"Unknown task kind: {kind}")
    defaults = settings_only(schema["defaults"])
    defaults["task"] = deepcopy(descriptor["defaults"])
    overrides = deepcopy(descriptor.get("settings_overrides", {}))
    # A source-owned custom objective never receives scalar tracking controls.
    if "cost_weights" not in defaults["config"]:
        overrides.get("config", {}).pop("cost_weights", None)
    defaults = resolve_task_settings(defaults, overrides)
    return defaults


def install_task_defaults(schema):
    """Advertise effective task defaults without changing the general defaults."""
    schema["task_defaults"] = {task["kind"]: task_defaults(schema, task["kind"])
                               for task in schema["tasks"]}
    schema["task_default_overrides"] = {
        kind: settings_diff(settings_only(schema["defaults"]), defaults)
        for kind, defaults in schema["task_defaults"].items()
    }
    return schema


def settings_diff(before, after, path=""):
    """Return session overrides; arrays and null are whole values, not mergeable objects."""
    result = {}
    for key, value in after.items():
        if key in before and before[key] == value:
            continue
        full_path = f"{path}.{key}" if path else key
        if isinstance(value, dict) and isinstance(before.get(key), dict) and full_path not in ATOMIC:
            changed = settings_diff(before[key], value, full_path)
            if changed:
                result[key] = changed
        else:
            result[key] = deepcopy(value)
    # The standard menu is generated from these settings, rather than a second override.
    if (isinstance(result.get("config"), dict) and "cost_weights" in after.get("config", {})
            and cost_weights(after["config"].get("cost")) is not None):
        result["config"].pop("cost", None)
        if not result["config"]:
            del result["config"]
    return result


def compatible_overrides(defaults, overrides, path=""):
    """Drop fields removed by a source change; normal validation checks retained values.

    Native menus are indivisible. An incompatible explicit menu is rejected by
    normal settings validation, rather than edited into a different objective.
    """
    if path in ATOMIC or not isinstance(defaults, dict) or not isinstance(overrides, dict):
        return deepcopy(overrides)
    return {key: compatible_overrides(defaults[key], value, f"{path}.{key}" if path else key)
            for key, value in overrides.items() if key in defaults}


def transfer_differences(source, destination):
    """List changed settings both tasks can represent; metadata is never transferable."""
    differences = []
    standard = "cost_weights" in source.get("config", {}) and "cost_weights" in destination.get("config", {})

    def visit(left, right, path):
        if left == right or path == "task.kind" or path.split(".")[-1] == "type":
            return
        if path == "config.cost" and standard:
            return
        if isinstance(left, dict) and isinstance(right, dict) and path not in ATOMIC:
            for key in left.keys() & right.keys():
                visit(left[key], right[key], f"{path}.{key}" if path else key)
        elif path:
            differences.append(dict(path=path, source=deepcopy(left), current=deepcopy(right)))

    for group in GROUPS:
        if group in source and group in destination:
            visit(source[group], destination[group], group)
    return sorted(differences, key=lambda item: item["path"])


def transfer_settings(source, destination, paths):
    """Copy selected changed leaves or branches; validate the resulting settings normally."""
    if (not isinstance(paths, list) or not paths or
            any(not isinstance(path, str) or not path or path.startswith(".") or path.endswith(".")
                for path in paths)):
        raise ValueError("paths requires a nonempty list of setting or branch paths")
    differences = transfer_differences(source, destination)
    selected = set()
    for path in paths:
        matches = {item["path"] for item in differences
                   if item["path"] == path or item["path"].startswith(path + ".")}
        if not matches:
            raise ValueError(f"No transferable difference at {path}")
        selected.update(matches)
    result = settings_only(destination)
    for item in differences:
        if item["path"] not in selected:
            continue
        keys = item["path"].split(".")
        target = result
        for key in keys[:-1]:
            target = target[key]
        target[keys[-1]] = deepcopy(item["source"])
    if "config.cost" in selected:
        weights = cost_weights(result["config"]["cost"])
        if weights is None:
            result["config"].pop("cost_weights", None)
        else:
            result["config"]["cost_weights"] = weights
    return result
