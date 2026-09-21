export function valuesEqual(left, right) {
  return Object.is(left, right);
}

export function changedFields(base = {}, values = {}) {
  const names = new Set([...Object.keys(base), ...Object.keys(values)]);
  return [...names].filter((name) => !valuesEqual(base[name], values[name]));
}

export function mergeChanges({ base = {}, localChanges = {}, remoteData = {}, allowedNames = [] }) {
  const mergedChanges = {};
  const conflicts = [];
  const autoMerged = [];

  for (const [name, localValue] of Object.entries(localChanges)) {
    if (!allowedNames.includes(name)) {
      conflicts.push({ name, base: base[name], local: localValue, remote: remoteData[name], reason: 'unknown-field' });
      continue;
    }

    const remoteChanged = !valuesEqual(base[name], remoteData[name]);
    if (!remoteChanged) {
      mergedChanges[name] = localValue;
      autoMerged.push(name);
      continue;
    }

    if (valuesEqual(localValue, remoteData[name])) {
      autoMerged.push(name);
      continue;
    }

    conflicts.push({ name, base: base[name], local: localValue, remote: remoteData[name], reason: 'both-changed' });
  }

  return { mergedChanges, conflicts, autoMerged };
}

export function applyChanges(data = {}, changes = {}) {
  return { ...data, ...changes };
}

export function projectionFromQueue({ remote, queue = [] }) {
  const ordered = queue
    .filter((item) => ['queued', 'flushing', 'conflict', 'failed'].includes(item.status))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const block = ordered.find((item) => ['conflict', 'failed'].includes(item.status));
  const active = ordered.filter(
    (item) => ['queued', 'flushing'].includes(item.status) && (!block || item.createdAt < block.createdAt)
  );

  const conflict = block?.status === 'conflict' ? block : null;
  let data = { ...(remote?.data ?? {}) };
  let version = remote?.version ?? 0;

  if (conflict?.resolution) {
    data = applyChanges(data, conflict.resolution.mergedChanges ?? {});
    version = conflict.resolution.serverVersion ?? version;
  }

  for (const item of active) {
    data = applyChanges(data, item.changes ?? {});
  }

  return { data, version, conflict, failed: block?.status === 'failed' ? block : null, block, active };
}
