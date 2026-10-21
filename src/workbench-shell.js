import { expandedTimelineShell } from './expanded-timeline.js';

export function workbenchShell(icon) {
  return `<div class="workspace workbench" id="workbench">
    <aside class="sidebar left-sidebar" id="left-sidebar" aria-label="Task and settings">
      <div class="mode-tabs" role="group" aria-label="Workspace mode"><button id="replay-mode" class="active" aria-pressed="true">Replay</button><button id="live-mode" disabled aria-pressed="false">Live MPC</button></div>
      <p id="live-availability" class="availability" role="status"></p>
      <section id="live-panel" hidden>
        <label class="field-label" for="live-task">TASK</label><div class="select-wrap"><select id="live-task" aria-label="Live task"><option value="reach">Reaching</option></select></div>
        <div class="execution-rate-row" aria-label="Execution rates in hertz">
          <label>Simulation Hz<input id="live-simulation-hz" type="number" min=".01" step="any" value="1000" required></label>
          <label>Control Hz<input id="live-control-hz" type="number" min=".01" step="any" value="100" required></label>
          <label>TO Hz<input id="live-to-hz" type="number" min=".01" step="any" value="100" required></label>
        </div>
        <div id="live-horizon-settings" class="compact-horizon"></div>
        <div id="live-settings"></div>
        <details class="task-position settings-group"><summary>Task position</summary>
          <div class="target-offsets">${['X', 'Y', 'Z'].map((axis, i) => `<label>${axis}<input id="target-offset-${i}" aria-label="Target ${axis} offset in metres" type="number" step="0.01" value="0"></label>`).join('')}</div>
          <div id="live-task-parameters"></div>
          <button id="target-move" class="secondary-action" disabled>Move in viewport</button>
          <p id="target-move-note" class="settings-note"></p><p id="live-task-note" class="settings-note"></p>
        </details>
      </section>
      <section id="replay-section">
        <label class="field-label" for="recording-select">RECORDING</label>
        <div class="select-wrap"><select id="recording-select" aria-label="Recording library"><option value="default">Default recording</option></select></div>
        <p id="recording-path" class="recording-path"></p><p id="recording-update" class="recording-update" role="status"></p>
        <button id="recording-reload" class="secondary-action recording-reload" hidden>Reload recording</button>
        <div class="upload-actions"><button id="upload-files" class="secondary-action">Upload .npz</button><button id="upload-folder" class="secondary-action">Upload folder</button></div>
        <input id="recording-files" class="sr-only" type="file" accept=".npz" multiple tabindex="-1" aria-label="Choose recordings to upload">
        <input id="recording-folder" class="sr-only" type="file" webkitdirectory directory multiple tabindex="-1" aria-label="Choose folder to upload">
        <p id="library-message" class="library-message" role="status" aria-live="polite"></p>
        <details id="library-errors" class="library-errors" hidden><summary id="library-errors-summary"></summary><ul id="library-errors-list"></ul></details>
        <label class="field-label trajectory-label" for="trajectory-select">TRAJECTORY</label>
        <div class="select-wrap"><select id="trajectory-select" disabled><option>Loading trajectories…</option></select></div>
      </section>
    </aside>
    <main class="main">
      <section class="viewport" id="viewport" aria-label="Interactive 3D robot workspace">
        <div class="viewport-top">
          <button id="left-sidebar-toggle" class="viewport-tool" aria-label="Hide settings sidebar" aria-expanded="true" aria-controls="left-sidebar" title="Toggle settings sidebar">${icon('panelLeft')}</button>
          <div class="camera-controls"><button id="source-settings-open" title="Source / Build settings" aria-label="Source / Build settings">${icon('settings')}</button><button id="camera-home" title="Fit robot" aria-label="Fit robot">${icon('robot')}</button><button id="camera-arm" title="Fit trajectory" aria-label="Fit trajectory">${icon('focus')}</button><button id="right-sidebar-toggle" aria-label="Hide inspection sidebar" aria-expanded="true" aria-controls="right-sidebar" title="Toggle inspection sidebar">${icon('panelRight')}</button></div>
        </div>
        <p id="live-message" class="live-message workbench-toast" role="status" aria-live="polite"></p>
        <div class="load-overlay" id="load-overlay" role="status"><div class="spinner"></div><strong id="load-title">Opening workspace</strong><p id="load-detail">Loading robot description…</p></div>
        <div hidden><span id="scene-title">TIAGo Pro</span><div id="path-legend"></div></div>
      </section>
      ${expandedTimelineShell()}
      <section id="live-controls" class="playback transport-bar live-controls" aria-label="Live MPC playback" hidden>
        <button id="live-play" class="transport-button primary-action" disabled aria-label="Play live history" title="Play / pause">${icon('play')}</button>
        <button id="live-reset" class="transport-button" disabled aria-label="Reset state" title="Reset state">${icon('restart')}</button>
        <div class="live-history-track transport-track"><div id="live-history-intervals" aria-hidden="true"></div><input id="live-history" type="range" min="0" max="0" step="any" value="0" disabled aria-label="Live history time"></div>
        <span id="live-history-position" class="transport-time">0 / 0 s</span>
        <label class="stop-option" title="Stop at the recorded end; uncheck to continue simulation"><input id="live-stop-at-end" type="checkbox" checked>Stop</label>
        <div class="transport-calculation"><label class="sr-only" for="live-calculation">Calculation mode</label><select id="live-calculation" aria-label="Calculation mode"><option value="on_play">On Play</option><option value="manual">Manual</option><option value="automatic">Automatic</option></select>
          <button id="live-precalculate" class="transport-button" disabled aria-label="Precalculate" title="Precalculate closed-loop motion">${icon('calculate')}</button>
          <label class="duration-input"><input id="live-duration" type="number" min=".01" step="any" value="10" aria-label="Calculation duration seconds"><span>s</span></label>
        </div>
        <button id="live-timeline-expand" class="transport-button timeline-expand" aria-label="Expand timeline" aria-expanded="false" aria-controls="expanded-timeline" title="Expand timeline">${icon('chevron')}</button>
        <div hidden><input id="live-continue" type="checkbox"><button id="live-preview">Preview</button><button id="live-cancel">Cancel calculation</button><button id="live-history-latest">Go latest</button></div>
      </section>
      <section class="playback transport-bar" id="replay-controls" aria-label="Recorded trajectory playback">
        <div class="transport-replay-content" id="replay-timeline">
          <button id="play" class="transport-button play-button" disabled aria-label="Play trajectory" title="Play / pause">${icon('play')}</button>
          <button id="restart" class="transport-button" disabled title="Reset playback" aria-label="Reset playback">${icon('restart')}</button>
          <div class="transport-track"><input type="range" id="timeline" min="0" max="1" step="any" value="0" disabled aria-label="Trajectory time"></div>
          <div class="transport-time"><strong id="time-current">0.00</strong> / <span id="time-total">—</span> s</div>
          <label class="stop-option" title="Stop at the end; uncheck to loop this recording"><input id="replay-stop-at-end" type="checkbox" checked>Stop</label>
          <label class="replay-speed"><span class="sr-only">Playback speed</span><select id="speed" aria-label="Playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
        </div>
        <button id="replay-timeline-expand" class="transport-button timeline-expand" aria-label="Expand timeline" aria-expanded="false" aria-controls="expanded-timeline" title="Expand timeline">${icon('chevron')}</button>
        <div class="transport-metadata" hidden><span id="timeline-middle"></span><span id="timeline-end"></span><span class="keyboard-hint"></span></div>
      </section>
    </main>
    <aside class="sidebar right-sidebar" id="right-sidebar" aria-label="Views, graphs and joints">
      <div class="inspection-tabs" role="tablist" aria-label="Inspection panels">${['Views','Graphs','Joints'].map((name, i) => `<button id="inspection-tab-${name.toLowerCase()}" role="tab" aria-selected="${i === 0}" aria-controls="inspection-${name.toLowerCase()}" tabindex="${i === 0 ? 0 : -1}">${name}</button>`).join('')}</div>
      <section id="inspection-views" class="inspection-panel" role="tabpanel" aria-labelledby="inspection-tab-views"><div class="auxiliary-view" id="auxiliary-top"><span>Top</span></div><div class="auxiliary-view" id="auxiliary-right"><span>Right</span></div></section>
      <section id="inspection-graphs" class="inspection-panel" role="tabpanel" aria-labelledby="inspection-tab-graphs" hidden>
        <div id="demonstration-graph"></div>
        <div class="live-metrics"><div class="metric-heading"><span id="live-status">IDLE</span><span id="live-playback-rate">Paused</span></div><div class="timing-legend" aria-label="History timing colors"><span><i class="interval-key red"></i>MPC over budget</span><span><i class="interval-key yellow"></i>Simulation / combined</span></div><h2 id="live-plan-label">Waiting for a prediction</h2>
          <div class="solver-stats"><div><span>Solve wall</span><strong><b id="live-solve">—</b> ms</strong></div><div><span>SQP / PCG</span><strong><b id="live-sqp">—</b> / <b id="live-pcg">—</b></strong></div><div><span>ADMM / linear</span><strong><b id="live-admm">—</b> / <b id="live-linsys">—</b></strong></div><div><span>Row violation</span><strong id="live-violation">—</strong></div><div><span>Target distance</span><strong id="live-distance">—</strong></div><div><span>Calculation RTF</span><strong id="live-rtf">—</strong></div><div><span>Simulation time</span><strong id="live-sim-time">0.00</strong></div></div>
          <p id="live-rates" class="settings-note"></p><p id="live-history-window" class="settings-note"></p><p id="live-horizon" class="settings-note"></p><p id="live-arrival" class="settings-note"></p><p id="live-restarted" class="settings-note" hidden>Controller restarted</p><p id="live-history-note" class="settings-note"></p>
        </div>
        <div class="replay-metrics"><h2 id="playback-title">Motion timeline</h2><span id="playback-kind" class="eyebrow">RECORDED MOTION</span><span id="playback-state">READY TO LOAD</span><div class="trajectory-kind" id="trajectory-kind"></div><p id="trajectory-description" class="settings-note"></p><p id="timing-note" class="settings-note"></p>
          <div class="stats-grid"><div><span class="stat-label">Duration</span><strong id="duration-stat">—</strong></div><div><span class="stat-label">Samples</span><strong id="samples-stat">—</strong></div><div><span class="stat-label">Tool path</span><strong id="distance-stat">—</strong></div><div><span class="stat-label">End / target</span><strong id="error-stat">—</strong></div></div>
        </div>
        <details class="source-section"><summary>Source</summary><span id="mode-label">TRAJECTORY REPLAY</span><div class="connection"><i></i><span id="connection-label">Connecting</span></div><div class="source-name">tiago_mpc <span id="source-commit"></span></div><p id="source-run"></p><p id="live-source" class="settings-note source-live"></p></details>
      </section>
      <section id="inspection-joints" class="inspection-panel" role="tabpanel" aria-labelledby="inspection-tab-joints" hidden><div class="section-heading"><h2>Right arm</h2><span class="unit-label">NATIVE</span></div><div class="joint-list" id="joint-list"></div><p class="joint-limit-note"><span class="limit-yellow">Near limit</span> · <span class="limit-red">At limit</span> · — unavailable</p></section>
    </aside>
  </div>`;
}
