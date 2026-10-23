import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchShell } from './workbench-shell.js';

test('Live transport exposes explicit session speed and freeze beside calculation', () => {
  const shell = workbenchShell(name => `<svg data-icon="${name}"></svg>`);
  const live = shell.slice(shell.indexOf('<section id="live-controls"'), shell.indexOf('<section class="playback transport-bar" id="replay-controls"'));
  assert.match(live, /id="live-freeze"[^>]*disabled[^>]*aria-label="Freeze for comparison"/);
  assert(live.indexOf('id="live-freeze"') > live.indexOf('id="live-precalculate"'));
  assert.match(live, /id="live-speed"[^>]*aria-label="Session playback speed"/);
  assert.match(live, /value="1" selected>1×/);
  for (const value of ['0.25', '0.5', '2', '4']) assert(live.includes(`value="${value}"`));
  assert.match(shell, /id="timeline-add-track"[^>]*aria-haspopup="dialog"/);
  assert.match(shell, /id="timeline-lanes"[^>]*aria-label="Session tracks"/);
  assert.match(shell, /id="timeline-track-message"[^>]*role="status"[^>]*hidden/);
});

test('the shell starts with one session transport and task settings, keeping legacy Replay mounts hidden', () => {
  const shell = workbenchShell(() => '');
  assert.match(shell, /<section id="live-panel">/);
  assert.match(shell, /<section id="live-controls"[^>]*aria-label="Session playback">/);
  assert(!shell.includes('aria-label="Workspace mode"')); assert(!shell.includes('class="mode-tabs"'));
  assert(!shell.includes('>Live MPC<')); assert(!shell.includes('<summary>Import recordings</summary>'));
  assert.match(shell, /<div hidden inert aria-hidden="true"><button id="replay-mode"/);
  assert.match(shell, /<div hidden inert aria-hidden="true"><section id="replay-section" hidden>/);
  assert.match(shell, /<div hidden inert aria-hidden="true"><section[^>]*id="replay-controls"[^>]* hidden>/);
  assert.match(shell, /id="live-history"[^>]*aria-label="Session time"/);
  for (const id of ['upload-files', 'upload-folder', 'recording-files', 'recording-folder', 'library-message', 'library-errors', 'recording-select', 'trajectory-select']) {
    assert.equal(shell.match(new RegExp(`id="${id}"`, 'g')).length, 1);
  }
});
