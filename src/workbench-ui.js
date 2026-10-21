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
    for (const tab of ['views', 'episode', 'solve', 'joints']) {
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
  const tabs = ['views', 'episode', 'solve', 'joints'];
  for (const [i, name] of tabs.entries()) {
    const button = $(`inspection-tab-${name}`);
    button.addEventListener('click', () => selectTab(name));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
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
