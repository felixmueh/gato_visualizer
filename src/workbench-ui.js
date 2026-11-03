import { setupTransportPopovers } from './transport-popover.js';

// Keep Stop a playback preference. Its inversion dispatches only the existing
// local Continue change handler, never a settings submission or new calculation.
export function bindStopPreference(stop, continueInput) {
  const update = () => { stop.checked = !continueInput.checked; };
  stop.addEventListener('change', () => { continueInput.checked = !stop.checked; continueInput.dispatchEvent(new Event('change', { bubbles: true })); });
  continueInput.addEventListener('change', update); update();
  return update;
}

// Legacy modules still bind these mounts while their data sources move onto
// session tracks. They never become a second selectable workspace or transport.
export function showSessionWorkspace(doc = document) {
  for (const id of ['live-panel', 'live-controls']) { const element = doc.getElementById(id); if (element) element.hidden = false; }
  for (const id of ['replay-section', 'replay-controls', 'replay-mode', 'live-mode']) { const element = doc.getElementById(id); if (element) element.hidden = true; }
  doc.body.classList.toggle('live-mode', true);
}

export function setupWorkbench({ document: doc = document, onLayout = () => {} } = {}) {
  const $ = id => doc.getElementById(id), shell = $('workbench');
  setupTransportPopovers(doc);
  let currentTab = 'views';
  const tabs = ['views', 'episode', 'solve', 'comparison', 'joints'].filter(name => $(`inspection-tab-${name}`));
  if ($('inspection-tab-comparison')) $('inspection-tab-comparison').hidden = true;
  const selectTab = name => {
    if (!tabs.includes(name) || $(`inspection-tab-${name}`).hidden) return;
    currentTab = name;
    for (const tab of tabs) {
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
  for (const name of tabs) {
    const button = $(`inspection-tab-${name}`);
    button.addEventListener('click', () => selectTab(name));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const shown = tabs.filter(tab => !$(`inspection-tab-${tab}`).hidden), index = shown.indexOf(name);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + shown.length) % shown.length;
      selectTab(shown[next]); $(`inspection-tab-${shown[next]}`).focus();
    });
  }
  // The metrics module fills this mount with recorded series.
  const updateStop = bindStopPreference($('live-stop-at-end'), $('live-continue'));
  const update = () => {
    showSessionWorkspace(doc);
    updateStop();
    const play = $('live-play'), playing = /pause/i.test(play.textContent);
    play.dataset.playing = String(playing);
    play.title = playing ? 'Pause' : 'Play';
  };
  update();
  const setComparisonAvailable = value => {
    const tab = $('inspection-tab-comparison');
    if (tab) tab.hidden = !value && currentTab !== 'comparison';
  };
  return { update, setComparisonAvailable, get activeTab() { return currentTab; }, get auxiliaryVisible() { return currentTab === 'views' && !$('right-sidebar').hidden; }, selectTab };
}
