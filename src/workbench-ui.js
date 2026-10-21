export function demonstrationGraph() {
  const points = Array.from({ length: 81 }, (_, i) => {
    const x = 36 + i * 2.8, y = 74 - 28 * Math.sin(i * Math.PI / 20) * Math.exp(-i / 100);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return `<figure class="demo-graph"><figcaption>Demonstration graph</figcaption><p>Illustrative signal · not recorded solver data</p><svg viewBox="0 0 280 150" role="img" aria-label="Demonstration signal, not recorded experiment data"><path class="graph-grid" d="M36 24V120H264M36 48H264M36 72H264M36 96H264M92 24V120M148 24V120M204 24V120"/><polyline class="graph-example" points="${points}"/><text x="148" y="144">Time (s)</text><text x="13" y="73" transform="rotate(-90 13 73)">Example amplitude</text></svg></figure>`;
}

// Keep Stop a playback preference. Its inversion dispatches only the existing
// local Continue change handler, never a settings submission or new calculation.
export function bindStopPreference(stop, continueInput) {
  const update = () => { stop.checked = !continueInput.checked; };
  stop.addEventListener('change', () => { continueInput.checked = !stop.checked; continueInput.dispatchEvent(new Event('change', { bubbles: true })); });
  continueInput.addEventListener('change', update); update();
  return update;
}

export function setupWorkbench({ document: doc = document, onLayout = () => {} } = {}) {
  const $ = id => doc.getElementById(id), shell = $('workbench');
  let currentTab = 'views';
  const selectTab = name => {
    currentTab = name;
    for (const tab of ['views', 'graphs', 'joints']) {
      $(`inspection-${tab}`).hidden = tab !== name;
      $(`inspection-tab-${tab}`).setAttribute('aria-selected', String(tab === name));
      $(`inspection-tab-${tab}`).tabIndex = tab === name ? 0 : -1;
    }
    onLayout();
  };
  for (const side of ['left', 'right']) {
    $(`${side}-sidebar-toggle`).addEventListener('click', () => {
      const hidden = shell.classList.toggle(`${side}-hidden`);
      $(`${side}-sidebar`).hidden = hidden;
      $(`${side}-sidebar-toggle`).setAttribute('aria-expanded', String(!hidden));
      $(`${side}-sidebar-toggle`).setAttribute('aria-label', `${hidden ? 'Show' : 'Hide'} ${side === 'left' ? 'settings' : 'inspection'} sidebar`);
      onLayout();
    });
  }
  const tabs = ['views', 'graphs', 'joints'];
  for (const [i, name] of tabs.entries()) {
    const button = $(`inspection-tab-${name}`);
    button.addEventListener('click', () => selectTab(name));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (i + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
      selectTab(tabs[next]); $(`inspection-tab-${tabs[next]}`).focus();
    });
  }
  // The metrics module fills this mount with recorded series.
  const updateStop = bindStopPreference($('live-stop-at-end'), $('live-continue'));
  const update = () => {
    updateStop();
    const play = $('live-play'), playing = /pause/i.test(play.textContent);
    play.dataset.playing = String(playing);
    play.title = playing ? 'Pause' : 'Play';
  };
  update();
  return { update, get activeTab() { return currentTab; }, get auxiliaryVisible() { return currentTab === 'views' && !$('right-sidebar').hidden; }, selectTab };
}
