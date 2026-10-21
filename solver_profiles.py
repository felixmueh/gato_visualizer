"""Named solver selections; these never replace the running simulator source."""
from copy import deepcopy
import re

from source_runtime import resolve_selection
from visualizer_config import save_local_settings


def validate_profile(profile):
    if not isinstance(profile, dict) or set(profile) - {"id", "name", "mpc_root", "python", "cache"}:
        raise ValueError("A solver profile requires id, name and mpc_root with optional python/cache")
    identifier, name = profile.get("id"), profile.get("name")
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", identifier):
        raise ValueError("Profile id must contain 1–80 letters, numbers, underscores or hyphens")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise ValueError("Profile name must contain 1–120 characters")
    if not isinstance(profile.get("mpc_root"), str):
        raise ValueError("Profile mpc_root must be a path")
    return dict(id=identifier, name=name.strip(), **resolve_selection(
        profile["mpc_root"], python=profile.get("python"), cache=profile.get("cache")))


class SolverProfiles:
    def __init__(self, live, selection, config_path, profiles=()):
        self.live, self.selection, self.config_path = live, deepcopy(selection), config_path
        default = dict(id="simulator", name="Simulator checkout", **selection)
        self.profiles = {"simulator": default}
        for profile in profiles:
            validated = validate_profile(profile)
            if validated["id"] == "simulator":
                continue  # Reserved alias always follows the fixed simulator source.
            self.profiles[validated["id"]] = validated

    def active_selection(self, profile_id=None):
        with self.live.condition:
            if self.live.closed or self.live.profile_switch["state"] == "switching":
                raise ValueError("A solver profile switch is in progress or Live is closed")
            active = self.live.active_profile_id
            if active is None or (profile_id is not None and profile_id != active):
                raise ValueError("Run again requires the currently active compatible solver profile")
            # Catalog edits do not change the already-active numerical process.
            return deepcopy(self.live.active_profile)

    def status(self):
        with self.live.condition:
            return dict(profiles=deepcopy(list(self.profiles.values())),
                active_profile_id=self.live.active_profile_id,
                simulator_source=self.selection, switch=deepcopy(self.live.profile_switch),
                generation=self.live.generation)

    def save(self, body):
        if not isinstance(body, dict) or set(body) != {"profile"}:
            raise ValueError("Expected {profile: {...}}")
        profile = validate_profile(body["profile"])
        if profile["id"] == "simulator":
            raise ValueError("The simulator profile follows Source / Build and cannot be overwritten")
        with self.live.condition:
            if self.live.profile_switch["state"] == "switching":
                raise ValueError("A solver profile switch is in progress")
            updated = dict(self.profiles, **{profile["id"]: profile})
            save_local_settings(self.config_path,
                solver_profiles=[value for key, value in updated.items() if key != "simulator"])
            self.profiles = updated
        return self.status()

    def activate(self, body):
        if not isinstance(body, dict) or set(body) - {"profile_id", "anchor"}:
            raise ValueError("Activation requires profile_id and optional native anchor")
        identifier = body.get("profile_id")
        if not isinstance(identifier, str) or identifier not in self.profiles:
            raise ValueError("Unknown solver profile")
        self.live.switch_solver_profile(deepcopy(self.profiles[identifier]), body.get("anchor"))
        return dict(state="switching", profile_id=identifier)
