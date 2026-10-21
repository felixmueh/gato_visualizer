# Ubiquitous Language

## Optimization and execution

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Solve** | One trajectory-optimization invocation for a specified starting state, task/reference, and effective configuration. | Iteration, MPC episode |
| **MPC episode** | One closed-loop MPC execution over time, whose recording may contain robot states, applied controls, references, and associated solves. | Solve, prediction, trajectory when the whole execution is meant |
| **Prediction** | The candidate state/control trajectory returned by a solve, including its prediction horizon. | Executed trajectory, episode |
| **Robot state** | The native joint positions and velocities at a specified task/simulation time. | Joint positions alone when defining a continuation state |

## Inspection and continuation

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Episode cursor** | The selected time in an MPC episode's recorded history. | Solve iteration, prediction time |
| **Selected solve** | The solve chosen for inspection, either standalone or associated with an episode. | Current solve when selection versus newest computation is ambiguous |
| **Continuation** | A new active episode segment starting from the displayed robot state and task time after an execution-setting change. | Resume from latest when the user selected an earlier state |

## Relationships

- An **MPC episode** contains repeated **Solves**, although its recording may omit their detailed results.
- A saved **Solve** can exist without an **MPC episode**; a recording without saved solves can still represent an episode.
- A **Solve** can produce a **Prediction**; that prediction is distinct from the episode's actual executed motion and does not establish convergence or task success.
- Previewing a **Solve** from an episode state does not itself execute more motion.
- Changing execution settings captures the displayed **Robot state** once, including velocity and task time, and starts a **Continuation** from that frozen state.

## Continuation decision — Felix, 2026-10-21

After playing to 10 s, scrubbing to 5 s, and changing execution settings, further computation starts from the displayed state at 5 s. Computing another 10 s covers task/simulation time 5–15 s. Figure-eight task phase follows that preserved task time.

For the current version, the continuation replaces the active episode history in the UI; earlier history is not stitched into the new segment. Existing history files remain on disk. This does not introduce an episode-branch browser or change ordinary Play: with no execution-setting edit, Play extends the existing history tip. Plot settings, camera edits and inspection alone do not start a continuation.

## Example dialogue

> **Developer:** “Are we inspecting one solve or the entire MPC episode?”
>
> **Domain expert:** “The episode; select one of its solves to inspect that solve's prediction and solver data.”
>
> **Developer:** “After scrubbing to 5 s and changing controller settings, does Play resume from the old 10 s tip?”
>
> **Domain expert:** “It starts a continuation from the displayed state at 5 s, including velocity and task phase; the new active history contains that segment.”

## Flagged ambiguities

- A **Solve** is not one SQP, PCG or ADMM iteration: those iterations belong inside a solve and require their own labels.
- “Trajectory” can mean a task reference, a solve prediction, or recorded executed motion; qualify it whenever the distinction matters.
- “Continue” must distinguish extending an unchanged episode at its history tip from starting a **Continuation** after editing settings at the episode cursor.
- Episode/Solve tabs, automatic selection versus pinned selection, and episode analysis ranges are under design discussion; they are not implemented UI behavior.
- Prediction-horizon time, episode time, solver-iteration index and measured wall time are distinct axes; the plotting contract must preserve their identities.
