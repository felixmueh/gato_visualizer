import { expandedTimelineShell } from './expanded-timeline.js';

function ghostControl(mode, icon) {
  return `<div class="transport-popover" data-transport-popover>
    <button id="${mode}-onion-skin" class="transport-button onion-skin-toggle" data-popover-trigger aria-controls="${mode}-ghost-settings" aria-expanded="false" aria-label="Onion skin" aria-pressed="false" title="Onion skin · off (O)">${icon('onion')}</button>
    <div id="${mode}-ghost-settings" class="transport-popover-panel" data-popover-panel role="group" aria-label="Ghost arm settings" hidden>
      <label>Fixed spacing<input id="${mode}-ghost-spacingEnabled" type="checkbox" checked aria-label="Fixed ghost spacing" data-tip="Off: distribute the maximum arms across the full aggregate range; keep only recorded positions."></label>
      <label>Spacing (s)<input id="${mode}-ghost-interval_s" type="number" min=".01" max="3600" step=".1" value=".5" aria-label="Ghost arm spacing seconds" data-tip="Time between keyframes from the aggregate range's start. Stops at the range end or maximum arm count." title="Time between keyframes from the aggregate range's start. Stops at the range end or maximum arm count."></label>
      <label>Maximum arms<input id="${mode}-ghost-maxCount" type="number" min="1" max="64" step="1" value="16" aria-label="Maximum ghost arms" data-tip="Maximum temporal ghost arms across the displayed tracks." title="Maximum temporal ghost arms across the displayed tracks."></label>
    </div>
  </div>`;
}

export function workbenchShell(icon) {
  return `<div class="workspace workbench" id="workbench">
    <aside class="sidebar left-sidebar" id="left-sidebar" aria-label="Task and settings">
      <div hidden inert aria-hidden="true"><button id="replay-mode" tabindex="-1" aria-pressed="false"></button><button id="live-mode" disabled tabindex="-1" aria-pressed="true"></button></div>
      <p id="live-availability" class="availability" role="status"></p>
      <section id="live-panel">
        <label class="field-label" for="live-task">TASK</label><div class="select-wrap"><select id="live-task" aria-label="Live task"><option value="reach">Reaching</option></select></div>
        <div class="execution-rate-row" aria-label="Execution rates in hertz">
          <label>Simulation Hz<input id="live-simulation-hz" type="number" min=".01" step="any" value="1000" required></label>
          <label>Control Hz<input id="live-control-hz" type="number" min=".01" step="any" value="500" required></label>
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
      <div hidden inert aria-hidden="true">
        <button id="upload-files">Upload .npz</button><button id="upload-folder">Upload folder</button>
        <input id="recording-files" class="sr-only" type="file" accept=".npz" multiple tabindex="-1" aria-label="Choose recordings to upload">
        <input id="recording-folder" class="sr-only" type="file" webkitdirectory directory multiple tabindex="-1" aria-label="Choose folder to upload">
      </div>
      <p id="library-message" class="library-message" role="status" aria-live="polite" hidden></p>
      <details id="library-errors" class="library-errors" hidden><summary id="library-errors-summary"></summary><ul id="library-errors-list"></ul></details>
      <div hidden inert aria-hidden="true"><section id="replay-section" hidden>
        <label class="field-label" for="recording-select">RECORDING</label>
        <div class="select-wrap"><select id="recording-select" aria-label="Recording library"><option value="default">Start pose</option></select></div>
        <div class="recording-path-row"><p id="recording-path" class="recording-path"></p><span id="recording-model-warning" class="recording-model-warning" role="img" hidden>⚠</span><button id="recording-link" class="recording-link" title="Copy a direct link to this recording" aria-label="Copy a direct link to this recording" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.5 2.5 0 013.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 01-3.5-3.5L5.5 8"/></svg></button></div><p id="recording-update" class="recording-update" role="status"></p>
        <button id="recording-reload" class="secondary-action recording-reload" hidden>Reload recording</button>
        <label class="field-label trajectory-label" for="trajectory-select">TRAJECTORY</label>
        <div class="select-wrap"><select id="trajectory-select" disabled><option>Loading trajectories…</option></select></div>
      </section></div>
    </aside>
    <main class="main">
      <section class="viewport" id="viewport" aria-label="Interactive 3D robot workspace">
        <div class="viewport-top">
          <button id="left-sidebar-toggle" class="viewport-tool" aria-label="Hide settings sidebar" aria-expanded="true" aria-controls="left-sidebar" title="Toggle settings sidebar">${icon('panelLeft')}</button>
          <div class="camera-controls"><button id="source-settings-open" title="Settings" aria-label="Settings">${icon('settings')}</button><button id="camera-home" title="Fit robot" aria-label="Fit robot">${icon('robot')}</button><button id="camera-arm" title="Fit trajectory" aria-label="Fit trajectory">${icon('focus')}</button><button id="right-sidebar-toggle" aria-label="Hide inspection sidebar" aria-expanded="true" aria-controls="right-sidebar" title="Toggle inspection sidebar">${icon('panelRight')}</button></div>
        </div>
        <p id="live-message" class="live-message workbench-toast" role="status" aria-live="polite"></p>
        <div id="onion-skin-tooltip" class="limit-tint-tooltip onion-skin-tooltip" role="tooltip" hidden></div>
        <div id="limit-tint-tooltip" class="limit-tint-tooltip" role="tooltip" hidden></div>
        <div class="load-overlay" id="load-overlay" role="status"><div class="spinner"></div><strong id="load-title">Opening workspace</strong><p id="load-detail">Loading robot description…</p></div>
        <div hidden><span id="scene-title">TIAGo Pro</span><div id="path-legend"></div></div>
      </section>
      ${expandedTimelineShell()}
      <section id="live-controls" class="playback transport-bar live-controls" aria-label="Session playback">
        <button id="live-play" class="transport-button primary-action" disabled aria-label="Play session" title="Play / pause">${icon('play')}</button>
        <button id="live-reset" class="transport-button" disabled aria-label="Reset state" title="Reset state">${icon('restart')}</button>
        <div class="live-history-track transport-track"><div id="live-history-intervals" aria-hidden="true"></div><div id="live-onion-ticks" class="onion-ticks"></div><input id="live-history" type="range" min="0" max="0" step="any" value="0" disabled aria-label="Session time"></div>
        <span id="live-history-position" class="transport-time">0 / 0 s</span>
        <label class="replay-speed live-speed"><span class="sr-only">Session playback speed</span><select id="live-speed" aria-label="Session playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
        <label class="stop-option" title="Stop at the recorded end; uncheck to continue simulation"><input id="live-stop-at-end" type="checkbox" checked>Stop</label>
        <div class="transport-calculation"><label class="sr-only" for="live-calculation">Calculation mode</label><select id="live-calculation" aria-label="Calculation mode"><option value="on_play">On Play</option><option value="manual">Manual</option><option value="automatic">Automatic</option></select>
          <div class="transport-popover" data-transport-popover>
            <button id="live-precalculate" class="transport-button" data-popover-trigger aria-controls="live-calculation-settings" aria-expanded="false" disabled aria-label="Precalculate" title="Precalculate closed-loop motion">${icon('calculate')}</button>
            <div id="live-calculation-settings" class="transport-popover-panel" data-popover-panel role="group" aria-label="Precalculation settings" hidden>
              <label>Duration (s)<input id="live-duration" type="number" min=".01" step="any" value="10" aria-label="Calculation duration seconds"></label>
            </div>
          </div>
          <button id="live-freeze" class="transport-button" disabled aria-label="Freeze for comparison" title="Freeze for comparison">${icon('freeze')}</button>
        </div>
        ${ghostControl('live', icon)}
        <button id="live-timeline-expand" class="transport-button timeline-expand" aria-label="Expand timeline" aria-expanded="false" aria-controls="expanded-timeline" title="Expand timeline">${icon('chevron')}</button>
        <div hidden><input id="live-continue" type="checkbox"><button id="live-preview">Preview</button><button id="live-cancel">Cancel calculation</button><button id="live-history-latest">Go latest</button></div>
      </section>
      <div hidden inert aria-hidden="true"><section class="playback transport-bar" id="replay-controls" aria-label="Recorded trajectory playback" hidden>
        <div class="transport-replay-content" id="replay-timeline">
          <button id="play" class="transport-button play-button" disabled aria-label="Play trajectory" title="Play / pause">${icon('play')}</button>
          <button id="restart" class="transport-button" disabled title="Reset playback" aria-label="Reset playback">${icon('restart')}</button>
          <div class="transport-track"><div id="replay-onion-ticks" class="onion-ticks"></div><input type="range" id="timeline" min="0" max="1" step="any" value="0" disabled aria-label="Trajectory time"></div>
          <div class="transport-time"><strong id="time-current">0.00</strong> / <span id="time-total">—</span> s</div>
          <label class="replay-speed"><span class="sr-only">Playback speed</span><select id="speed" aria-label="Playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
          <label class="stop-option" title="Stop at the end; uncheck to loop this recording"><input id="replay-stop-at-end" type="checkbox" checked>Stop</label>
        </div>
        ${ghostControl('replay', icon)}
        <button id="replay-timeline-expand" class="transport-button timeline-expand" aria-label="Expand timeline" aria-expanded="false" aria-controls="expanded-timeline" title="Expand timeline">${icon('chevron')}</button>
        <div class="transport-metadata" hidden><span id="timeline-middle"></span><span id="timeline-end"></span><span class="keyboard-hint"></span></div>
      </section></div>
    </main>
    <aside class="sidebar right-sidebar" id="right-sidebar" aria-label="Views, episode, solve and joints">
      <div class="inspection-tabs" role="tablist" aria-label="Inspection panels">${['Views','Episode','Solve','Joints'].map((name, i) => `<button id="inspection-tab-${name.toLowerCase()}" role="tab" aria-selected="${i === 0}" aria-controls="inspection-${name.toLowerCase()}" tabindex="${i === 0 ? 0 : -1}">${name}</button>`).join('')}</div>
      <section id="inspection-views" class="inspection-panel" role="tabpanel" aria-labelledby="inspection-tab-views"><div class="auxiliary-view" id="auxiliary-top"><span>Top</span></div><div class="auxiliary-view" id="auxiliary-right"><span>Right</span></div></section>
      <section id="inspection-episode" class="inspection-panel" role="tabpanel" aria-labelledby="inspection-tab-episode" hidden>
        <div id="episode-plots"></div><div hidden>
        <div class="live-metrics"><div class="metric-heading"><span id="live-status">IDLE</span><span id="live-playback-rate">Paused</span></div><div class="timing-legend" aria-label="History timing colors"><span><i class="interval-key red"></i>MPC over budget</span><span><i class="interval-key yellow"></i>Simulation / combined</span></div><h2 id="live-plan-label">Waiting for a prediction</h2>
          <div class="solver-stats"><div><span>Solve wall</span><strong><b id="live-solve">—</b> ms</strong></div><div><span>SQP / PCG</span><strong><b id="live-sqp">—</b> / <b id="live-pcg">—</b></strong></div><div><span>ADMM / linear</span><strong><b id="live-admm">—</b> / <b id="live-linsys">—</b></strong></div><div><span>Row violation</span><strong id="live-violation">—</strong></div><div><span>Target distance</span><strong id="live-distance">—</strong></div><div><span>Calculation RTF</span><strong id="live-rtf">—</strong></div><div><span>Simulation time</span><strong id="live-sim-time">0.00</strong></div></div>
          <p id="live-rates" class="settings-note"></p><p id="live-history-window" class="settings-note"></p><p id="live-horizon" class="settings-note"></p><p id="live-arrival" class="settings-note"></p><p id="live-restarted" class="settings-note" hidden>Controller restarted</p><p id="live-history-note" class="settings-note"></p>
        </div>
        <div class="replay-metrics"><h2 id="playback-title">Motion timeline</h2><span id="playback-kind" class="eyebrow">RECORDED MOTION</span><span id="playback-state">READY TO LOAD</span><div class="trajectory-kind" id="trajectory-kind"></div><p id="trajectory-description" class="settings-note"></p><p id="timing-note" class="settings-note"></p>
          <div class="stats-grid"><div><span class="stat-label">Duration</span><strong id="duration-stat">—</strong></div><div><span class="stat-label">Samples</span><strong id="samples-stat">—</strong></div><div><span class="stat-label">Tool path</span><strong id="distance-stat">—</strong></div><div><span class="stat-label">End / target</span><strong id="error-stat">—</strong></div></div>
        </div>
        </div>
        <details class="source-section"><summary>Source</summary><span id="mode-label">SESSION · SIMULATION</span><div class="connection"><i></i><span id="connection-label">Connecting</span></div><div class="source-name">tiago_mpc <span id="source-commit"></span></div><p id="source-run"></p><p id="live-source" class="settings-note source-live"></p></details>
      </section>
      <section id="inspection-solve" class="inspection-panel" role="tabpanel" aria-labelledby="inspection-tab-solve" hidden><div id="solve-plots"></div></section>
      <section id="inspection-joints" class="inspection-panel" role="tabpanel" aria-labelledby="inspection-tab-joints" hidden><div class="section-heading"><h2 title="Right arm, native joint values">Right arm</h2><button id="joint-start-reset" class="joint-start-reset" type="button" disabled></button><button id="joint-lock" class="joint-lock" type="button"></button><div class="joint-view-toggle" role="group" aria-label="Joints presentation"><button id="joint-view-gauges" type="button" title="Limit gauges">Gauges</button><button id="joint-view-numbers" type="button" title="Exact values">Numbers</button></div></div><div class="joint-list" id="joint-list" data-view="gauges"></div></section>
    </aside>
  </div>`;
}
