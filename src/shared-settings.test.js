import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsPatch, rebaseSettings } from './shared-settings.js';

test('partial transactions retain nulls and replace arrays and task kinds', () => {
  const before = { config: { budget: .01, joints: [1, 2], solver: { q: 4, pcg: 10 } }, task: { kind: 'reach', offset: [0, 0, 0] } };
  const after = structuredClone(before);
  after.config.budget = null; after.config.joints = [3, 4]; after.config.solver.pcg = 20;
  after.task = { kind: 'figure8', width: .2 };
  assert.deepEqual(settingsPatch(before, after), { config: { budget: null, joints: [3, 4], solver: { pcg: 20 } }, task: after.task });
  assert.deepEqual(settingsPatch(before, before), {});
});

test('remote changes win conflicts while unrelated pending browser edits survive', () => {
  const before = { config: { solver: { q: 4, pcg: 10 } }, task: { kind: 'reach', offset: [0, 0, 0] } };
  const draft = structuredClone(before), remote = structuredClone(before);
  draft.config.solver.pcg = 30; remote.config.solver.q = 8;
  assert.deepEqual(rebaseSettings(before, draft, remote).config.solver, { q: 8, pcg: 30 });
  remote.config.solver.pcg = 40;
  assert.deepEqual(rebaseSettings(before, draft, remote).config.solver, { q: 8, pcg: 40 });
  remote.task = { kind: 'figure8', width: .2 };
  assert.deepEqual(rebaseSettings(before, draft, remote).task, remote.task);
});

test('own acknowledged snapshot retains edits made after submitting it', () => {
  const sent = { config: { solver: { q: 8 } } }, draft = { config: { solver: { q: 9 } } };
  assert.deepEqual(rebaseSettings(sent, draft, sent), draft);
});
