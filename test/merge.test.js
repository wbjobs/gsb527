import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, changedFields, mergeChanges, projectionFromQueue } from '../src/merge.js';

test('merges non-overlapping field changes', () => {
  const result = mergeChanges({
    base: { title: 'a', content: 'old' },
    localChanges: { title: 'local' },
    remoteData: { title: 'a', content: 'remote' },
    allowedNames: ['title', 'content']
  });

  assert.deepEqual(result.mergedChanges, { title: 'local' });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.autoMerged, ['title']);
});

test('reports same-field edits as conflicts', () => {
  const result = mergeChanges({
    base: { title: 'a', content: 'old' },
    localChanges: { title: 'local' },
    remoteData: { title: 'remote', content: 'old' },
    allowedNames: ['title']
  });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].name, 'title');
  assert.deepEqual(result.mergedChanges, {});
});

test('projects queued changes in chronological order', () => {
  const projection = projectionFromQueue({
    remote: { version: 2, data: { title: 'server', content: 'c' } },
    queue: [
      { id: '2', status: 'queued', createdAt: 2, changes: { content: 'later' } },
      { id: '1', status: 'queued', createdAt: 1, changes: { title: 'local' } }
    ]
  });

  assert.deepEqual(projection.data, { title: 'local', content: 'later' });
  assert.equal(projection.active.length, 2);
});

test('conflict resolution rolls conflicting fields back and keeps queued predecessors', () => {
  const projection = projectionFromQueue({
    remote: { version: 3, data: { title: 'remote', content: 'server' } },
    queue: [
      {
        id: 'conflict',
        status: 'conflict',
        createdAt: 1,
        changes: { title: 'local' },
        resolution: { serverVersion: 3, mergedChanges: {} }
      },
      { id: 'after', status: 'queued', createdAt: 2, changes: { content: 'queued-after' } }
    ]
  });

  assert.deepEqual(projection.data, { title: 'remote', content: 'server' });
});

test('failed item blocks later optimistic changes', () => {
  const projection = projectionFromQueue({
    remote: { version: 1, data: { title: 'server', content: 'c' } },
    queue: [
      { id: 'failed', status: 'failed', createdAt: 1, changes: { title: 'invalid' } },
      { id: 'after', status: 'queued', createdAt: 2, changes: { content: 'later' } }
    ]
  });

  assert.equal(projection.failed.id, 'failed');
  assert.deepEqual(projection.data, { title: 'server', content: 'c' });
});

test('applyChanges is immutable and changedFields detects edits', () => {
  const base = { title: 'a', count: 1 };
  assert.deepEqual(applyChanges(base, { count: 2 }), { title: 'a', count: 2 });
  assert.deepEqual(base, { title: 'a', count: 1 });
  assert.deepEqual(changedFields(base, { title: 'a', count: 3 }), ['count']);
});
