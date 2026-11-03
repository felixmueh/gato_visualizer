import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, TRACK_PALETTE, sessionSpan, trackTime, outsideSpan, defaultOffset, snapOffset, settingsDiff } from './session.js';

test('Live is always the focused main track; session span includes hidden main but only visible comparisons', () => {
  const session = createSession();
  assert.equal(session.focusedId, 'live'); assert.deepEqual(session.span, [0, 0]);
  session.updateMain({ span: [5, 6], empty: false, visible: false });
  const replay = session.addTrack({ span: [10, 14], id: 'library' });
  assert.equal(replay.offset_s, -5); assert.equal(replay.letter, 'B');
  assert.deepEqual(session.span, [5, 9]);
  session.setVisible(replay.id, false); assert.deepEqual(session.span, [5, 6]);
  assert.equal(session.removeTrack('live'), false); assert.equal(session.setOffset('live', 3), false);
  session.setOffset(replay.id, -10); session.setVisible(replay.id, true); assert.deepEqual(session.span, [0, 6]);
  assert.equal(session.removeTrack(replay.id), true); assert.deepEqual(session.span, [5, 6]);
});

test('replay mode excludes Live without changing the retained tracks or session presentation', () => {
  const session = createSession();
  session.updateMain({ source: { kind: 'live', generation: 7 }, span: [-5, 30], empty: false });
  session.setDisplay('live', 'hidden');
  const replay = session.addTrack({ motion: { id: 'recording', time_s: [10, 14], q: [[1], [2]] }, offset_s: -8 });
  session.setName(replay.id, 'Saved reach');
  session.setCursor(3); session.setRate(2); session.setAggregate({ start: 2, end: 4 });
  const retained = [...session.tracks];
  let notices = 0;
  session.subscribe(() => notices++);

  session.setReplayOnly(true);
  assert.equal(session.replayOnly, true);
  assert.deepEqual(session.activeTracks, [replay]);
  assert.deepEqual(session.span, [2, 6]);
  assert.deepEqual(sessionSpan(session), [2, 6]);
  assert.deepEqual(session.tracks, retained);
  assert.equal(session.focusedId, 'live');
  assert.equal(session.cursor, 3); assert.equal(session.rate, 2);
  assert.deepEqual(session.aggregate, { start: 2, end: 4 });
  session.setReplayOnly(true); assert.equal(notices, 1);

  session.updateMain({ span: [-5, 60], empty: false });
  assert.deepEqual(session.span, [2, 6]);
  session.setReplayOnly(false);
  assert.equal(session.replayOnly, false);
  assert.deepEqual(session.activeTracks, retained);
  assert.deepEqual(session.span, [-5, 60]);
  assert.equal(session.focused.display, 'hidden');
  assert.equal(replay.displayName, 'Saved reach'); assert.equal(replay.offset_s, -8);
  assert.deepEqual(replay.motion.time_s, [10, 14]);
});

test('replay mode stays selected when its visible recordings are hidden or removed', () => {
  const session = createSession();
  session.updateMain({ span: [0, 100], empty: false });
  const first = session.addTrack({ span: [0, 2], offset_s: 1 });
  const second = session.addTrack({ span: [0, 4], offset_s: 5 });
  session.setReplayOnly(true);
  assert.deepEqual(session.span, [1, 9]);
  session.setVisible(second.id, false); assert.deepEqual(session.span, [1, 3]);
  session.removeTrack(first.id); assert.deepEqual(session.span, [0, 0]);
  assert.equal(session.replayOnly, true);
  session.setVisible(second.id, true); assert.deepEqual(session.span, [5, 9]);
  session.removeTrack(second.id); assert.deepEqual(session.activeTracks, []);
  assert.deepEqual(session.span, [0, 0]); assert.equal(session.replayOnly, true);
  session.setReplayOnly(false); assert.deepEqual(session.span, [0, 100]);
});

test('default offsets align library starts and retain simulation time for freezes without altering samples', () => {
  const session = createSession(), motion = { id: 'f', time_s: [3, 5], q: [[1], [2]], provenance: { live: { settings: { config: { N: 32 } } } } };
  const replay = session.addTrack({ motion: { ...motion, id: 'experiment' } });
  assert.equal(replay.offset_s, -3);
  const freeze = session.addTrack({ motion, catalogSource: 'freeze' });
  assert.equal(freeze.offset_s, 0); assert.equal(freeze.defaultOffset, 'zero');
  session.updateMain({ span: [2, 4], empty: false });
  session.setOffset(replay.id, 7); session.resetOffset(replay.id); assert.equal(replay.offset_s, -1);
  session.setOffset(freeze.id, 7); session.resetOffset(freeze.id); assert.equal(freeze.offset_s, 0);
  assert.deepEqual(motion.time_s, [3, 5]); assert.deepEqual(motion.q, [[1], [2]]);
  assert.equal(defaultOffset({ kind: 'live', span: [2, 4] }, session.focused), 0);
});

test('palette and letters advance deterministically without limiting the number of tracks', () => {
  const session = createSession(), tracks = Array.from({ length: 30 }, () => session.addTrack({ span: [0, 1] }));
  assert.deepEqual(tracks.slice(0, 5).map(track => track.color), TRACK_PALETTE);
  assert.equal(tracks[5].color, TRACK_PALETTE[0]); assert.equal(tracks[24].letter, 'Z'); assert.equal(tracks[25].letter, 'AA');
  assert.notEqual(tracks[0].id, tracks[29].id);
});

test('session cursor, aggregate window, identity and speed survive generation replacement', () => {
  const session = createSession(), id = session.id;
  session.updateMain({ source: { kind: 'live', generation: 1 }, span: [2, 4], empty: false });
  session.setAggregate({ start: 2.2, end: null }); session.setCursor(3); session.setRate(2);
  session.updateMain({ source: { kind: 'live', generation: 2 }, span: [3, 5], empty: false });
  assert.equal(session.id, id); assert.equal(session.cursor, 3); assert.equal(session.rate, 2);
  assert.deepEqual(session.aggregate, { start: 2.2, end: null });
  assert.throws(() => session.setOffset(session.addTrack({ span: [0, 1] }).id, NaN), /finite/);
  for (const rate of [0, -1, NaN]) assert.throws(() => session.setRate(rate), /positive/);
});

test('track cursor conversion and outside-span hold include both recorded endpoints', () => {
  const track = { kind: 'replay', span: [3, 5], offset_s: -2 };
  assert.equal(trackTime(track, 2), 4);
  assert.equal(outsideSpan(track, 1), false); assert.equal(outsideSpan(track, 3), false);
  assert.equal(outsideSpan(track, .9), true); assert.equal(outsideSpan(track, 3.1), true);
  assert.deepEqual(sessionSpan([{ ...track, visible: true }, { ...track, offset_s: 10, visible: false }]), [1, 3]);
});

test('offset snapping uses six screen pixels, either edge, and Alt disables it', () => {
  assert.equal(snapOffset(.047, [0, 1], .01, { span: [0, 2] }), 0);
  assert.equal(snapOffset(.047, [2], .01, { span: [0, 2] }), 0);
  assert.equal(snapOffset(.07, [0], .01), .07);
  assert.equal(snapOffset(.047, [0], .01, { alt: true }), .047);
});

test('settings differences read segment headers and experiment params without Live-only omissions', () => {
  const main = { context: { settings: { config: { N: 32, solver: { sqp: 5 }, plant: { clip: true } }, task: { kind: 'reach' }, execution: { duration_s: 10 } } } };
  const other = structuredClone(main); other.context.settings.config.solver.sqp = 10;
  assert.deepEqual(settingsDiff(main, other).map(({ path, main, other, text }) => ({ path, main, other, text })), [{ path: 'config.solver.sqp', main: 5, other: 10, text: 'sqp: 10' }]);
  assert.deepEqual(settingsDiff(main, { provenance: { params: { N: 64, solver: { sqp: 5 } } } }).map(diff => diff.path), ['config.N']);
  assert.deepEqual(settingsDiff(main, {}), []);
  const session = createSession(); session.updateMain({ context: main.context, settings: main.context.settings });
  const track = session.addTrack({ span: [0, 1], settings: other.context.settings });
  assert.equal(track.differences[0].other, 10);
  session.updateMain({ context: other.context, settings: other.context.settings }); assert.deepEqual(track.differences, []);
});

test('editable comparison names start at A, retain source labels and survive Live generations', () => {
  const session = createSession(), source = { id: 'freeze', label: 'Freeze · 14:32:05', provenance: { live: { complete: false } } };
  const a = session.addTrack({ span: [0, 1], motion: source }), b = session.addTrack({ span: [0, 2], label: 'Catalog recording' });
  assert.equal(session.focused.displayName, 'Live'); assert.equal(a.displayName, 'A'); assert.equal(b.displayName, 'B');
  assert.equal(a.label, source.label); assert.equal(a.badges.some(badge => badge.label === 'Incomplete'), false);
  session.setName(a.id, '  fast reach  '); assert.equal(a.displayName, 'fast reach'); assert.equal(a.label, source.label);
  session.updateMain({ source: { kind: 'live', generation: 2 } }); assert.equal(a.displayName, 'fast reach');
  session.setName(a.id, ' '); assert.equal(a.displayName, 'A');
  assert.equal(session.setName('live', 'changed'), false); assert.equal(session.focused.displayName, 'Live');
  assert.equal(source.label, 'Freeze · 14:32:05'); assert.equal(source.provenance.live.complete, false);
});
