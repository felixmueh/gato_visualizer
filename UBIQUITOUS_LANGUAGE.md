# Ubiquitous Language

## Optimization and execution

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Solve** | An optimization run for a fixed starting state, task/reference, and effective problem configuration, identified independently of an MPC episode. | SQP iteration, MPC episode |
| **MPC episode** | One closed-loop MPC execution over time, whose recording may contain robot states, applied controls, references, and associated solves. | Solve, prediction, trajectory when the whole execution is meant |
| **Prediction** | The candidate state/control trajectory returned by a solve, including its prediction horizon. | Executed trajectory, episode |
| **Robot state** | The native joint positions and velocities at a specified task/simulation time. | Joint positions alone when defining a continuation state |
| **Reseed** | Preparing the Live controller to solve from a robot state: `tiago_mpc`'s `Mpc.warmup` with the task reference at that time, which runs GATO's warm-up solve unless warm-up is off. It is not a solve and produces no prediction. | Reset (the Live command), restart |
| **SQP time limit** | `MpcParams.max_sqp_time_s`: wall time for a Live solve's SQP iterations within the SQP cap; none by default in Live, which runs on simulation time. | SQP wall budget, `budget_s` (Run again's separate wall budget) |

## Inspection and continuation

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Episode cursor** | The selected time in an MPC episode's recorded history. | Solve iteration, prediction time |
| **Selected solve** | The solve chosen for inspection, either standalone or associated with an episode. | Current solve when selection versus newest computation is ambiguous |
| **SQP iteration cursor** | The selected discrete SQP iteration within the selected solve. | Episode cursor, horizon-time cursor |
| **Pinned solve** | A selected solve whose identity and selected SQP iteration remain fixed while the episode cursor or Live computation advances. | Paused episode |
| **Continuation** | A new active episode segment starting from the displayed robot state and task time after an execution-setting change. | Resume from latest when the user selected an earlier state |
| **Run again** | A separate cold inspection solve from the selected solve's captured problem, with a finite SQP cap and optional wall budget. | Exact replay, resume, continue SQP |
| **Solve continuation** | Additional optimization from a retained optimizer checkpoint, a capability currently unavailable. | Episode continuation, new warm-seeded solve |

## Clocks and presentation

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Simulation time** | The task/plant clock recorded with robot states, independent of time spent computing them. | Solver time, wall time |
| **Simulation frequency** | The nominal RK4 integration rate, with steps split at control or replanning boundaries. | Display rate |
| **Control frequency** | The rate at which the current prediction supplies a held actuator command. | MPC frequency, replanning frequency |
| **TO frequency** | The trajectory-optimization/replanning rate requesting new solves. | Control frequency, reporting frequency |
| **Record every** | `record_every`: the Live history records the state and command at every n-th physics step (and at every TO boundary); plans and timing intervals stay complete. It changes the recording, never the simulation or the solves; 1 records every step. | Report frequency, display reduction, sample rate |
| **Knot interval** | The time spacing of states in a prediction horizon. | Control period |
| **Report frequency** | The wall-clock cadence for publishing batches of completed numerical records. | Simulation frequency, sample reduction |
| **Aggregate window** | The episode time range, selected on the timeline with independently unbounded left/right bounds, over which episode plots and aggregates are computed; an unbounded end follows new history. | Visible window, zoom, analysis range selector |
| **Playback buffer** | The desired amount of received simulation-time history ahead of the Live cursor. | Integration delay, reporting interval |

## Simulator and predictor

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Simulator source** | The selected checkout providing the fixed plant (`tiago_mpc`'s `SimPlant`), robot assets, initial state and task geometry. | Solver profile |
| **Solver profile** | A named checkout/interpreter/cache selection providing a compatible predictor and optimizer. | Simulator source, warm-state checkpoint |
| **Compiled module** | The GATO module `tiago_mpc` compiles for one `MpcParams` variant (knot count N, predictor friction). `find_binary` finds it; only an explicit Build compiles it. | Prebuilt binary, compatible binary |
| **Clip effort** | The simulation setting that clips each command to ± the raw URDF effort limit before it reaches the simulated plant; the robot path never clips. | Torque saturation of the MPC, effort bound (the MPC's `effort_fraction` row) |
| **Limit breach** | A simulated position, velocity or applied (clipped) torque that starts to be beyond its raw URDF limit, checked at every physics step or command; with **Stop on breach** Live pauses there. Planned knots never breach. | Limit use near/at (presentation states), MPC bound violation |
| **Native coordinates** | The canonical robot joint coordinates used by plant states, portable replays and public Live predictions. | GPU coordinates |

## Relationships

- An **MPC episode** contains repeated **Solves**, although its recording may omit their detailed results.
- A saved **Solve** can exist without an **MPC episode**; a recording without saved solves can still represent an episode.
- A **Solve** can produce a **Prediction**; that prediction is distinct from the episode's actual executed motion and does not establish convergence or task success.
- Previewing a **Solve** from an episode state does not itself execute more motion.
- A **Solve** contains recorded SQP iterations when that diagnostic detail is available; the initial guess is a separately labelled seed, not a completed SQP iteration.
- An **SQP iteration cursor** selects recorded iteration data and its prediction without advancing the episode clock or plant.
- A **Pinned solve** is visibly distinguished with a muted-red treatment and a text label; pinning fixes inspection, not execution.
- **Run again** produces a standalone **Solve**, automatically pinned, without advancing or rewriting the episode.
- Changing **Report frequency** or **Playback buffer** does not start a **Continuation** or reset the controller.
- A **Solve continuation** would preserve the source solve and any episode's historically applied result; it is distinct from continuing robot execution.
- Changing execution settings captures the displayed **Robot state** once, including velocity and task time, and starts a **Continuation** from that frozen state.

## Continuation decision — Felix, 2026-10-21

After playing to 10 s, scrubbing to 5 s, and changing execution settings, further computation starts from the displayed state at 5 s. Computing another 10 s covers task/simulation time 5–15 s. Figure-eight task phase follows that preserved task time.

For the current version, the continuation replaces the active episode history in the UI; earlier history is not stitched into the new segment. Existing history files remain on disk. This does not introduce an episode-branch browser or change ordinary Play: with no execution-setting edit, Play extends the existing history tip. Plot settings, camera edits and inspection alone do not start a continuation.

## Example dialogue

> **Developer:** “Does Pin solve stop the MPC episode?”
>
> **Domain expert:** “It retains the selected solve and SQP iteration; the episode can keep advancing.”
>
> **Developer:** “Does Run again resume that solver, and does changing Report frequency alter the next solve?”
>
> **Domain expert:** “Run again creates a separate cold solve; exact solve continuation is unavailable. Report frequency only changes publication of completed records.”

## Flagged ambiguities

- A **Solve** is not one SQP, PCG or ADMM iteration: those iterations belong inside a solve and require their own labels.
- “Trajectory” can mean a task reference, a solve prediction, or recorded executed motion; qualify it whenever the distinction matters.
- “Continue” must distinguish extending an unchanged episode at its history tip from starting a **Continuation** after editing settings at the episode cursor.
- Episode/Solve inspection, pinning, SQP iteration selection, the aggregate window and cold **Run again** are implemented; see [the inspection contract](docs/inspection.md). Ordinary solves may lack intermediate snapshots.
- Prediction-horizon time, episode time, SQP iteration index and measured wall time are distinct axes; horizon scrubbing is deferred and the plotting contract must preserve their identities.
- Exact **Solve continuation** requires a retained optimizer checkpoint; supplying a previous trajectory as a new solve's initial guess is a **new warm-seeded solve**, not an exact resume.
- “MPC frequency” is ambiguous: specify **TO frequency** for replanning or **Control frequency** for actuator updates.
- The thesis vocabulary names these differently: the visualizer's **TO frequency** is the thesis's control rate (the rate of control updates), and its **Control frequency** is the command rate at which the execution controller sends held torque commands. The field names `to_hz` and `control_hz` keep the visualizer's terms.
- “Buffer ms” means received **Simulation time** ahead of the cursor; **Report frequency** uses wall time and neither changes recorded samples.
