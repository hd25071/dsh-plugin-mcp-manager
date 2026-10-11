/**
 * Explicit recovery for a transaction that could not finish.
 *
 * A repair is not a decision the caller makes and this code carries out: the caller says which
 * action it wants, and everything that decides whether that action is *allowed* is recomputed here
 * from the disk and the profile. A client may ask; it may not assert. So this module reads the
 * same diagnosis the listing shows, verifies the content of every directory it is about to touch,
 * and refuses with a reason whenever the evidence is not there.
 *
 * Two rules shape every action:
 *
 * 1. a directory is only removed when its own manifest names this transaction AND its content still
 *    matches the digest that transaction rendered — a directory somebody has edited since is not
 *    this transaction's to delete, whatever its id says;
 * 2. nothing here calls the installer or the uninstaller. Recovery puts directories back; it never
 *    asks the plugin manager to change the profile, because that call has effects of its own.
 *
 * The plan is a pure function of what was read; the executor is the only part that writes, and it
 * announces its intent in the journal before each dangerous step.
 */
import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative as relativeTo, sep } from 'node:path';
import * as tx from './tx.js';

/** The actions a caller may ask for. Nothing else is accepted. */
export const REPAIR_ACTIONS = ['discard-staging', 'rollback', 'accept', 'retry-recovery'];

/** Phases before anything is published: a staged run can still be thrown away harmlessly. */
const UNPUBLISHED_PHASES = ['PREPARE', 'STAGED', 'JOURNALED'];

function messageOf(error) {
  return String((error && error.message) || error);
}

/** One directory's evidence, read and never followed. */
function artifact(dir) {
  let info;
  try {
    info = lstatSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false };
    return { present: true, usable: false, reason: 'it could not be inspected (' + String(error.code) + ')' };
  }
  if (info.isSymbolicLink()) return { present: true, usable: false, reason: 'it is a symbolic link, and a link is not followed' };
  if (!info.isDirectory()) return { present: true, usable: false, reason: 'it is not a directory' };
  const content = tx.verifyBundleContent(dir);
  if (content.ok !== true) return { present: true, usable: false, reason: content.reason };
  if (content.verifiable !== true) return { present: true, usable: false, reason: content.reason };
  if (content.matches !== true) return { present: true, usable: false, reason: 'its content does not match the digest its manifest records' };
  return { present: true, usable: true, txid: content.txid, digest: content.recorded };
}

function sorted(values) {
  return [...values].sort();
}

function sameSet(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

/**
 * What the running row says, against what the published manifest says it should be.
 *
 * A row id and a server name matching is not proof that the configuration took effect, so as many
 * fields as both sides actually carry are compared. When nothing can be compared the answer is
 * `inconclusive`, which is a refusal — not a pass.
 */
function compareRow(row, live) {
  if (row === null || row === undefined || row.present !== true) return { verdict: 'absent', detail: 'no row for this manifest is in the running configuration' };
  const checked = [];
  const mismatched = [];
  if (typeof row.serverName === 'string' && row.serverName !== '' && typeof live.serverName === 'string' && live.serverName !== '') {
    checked.push('serverName');
    if (row.serverName !== live.serverName) mismatched.push('serverName is "' + row.serverName + '" and the manifest says "' + live.serverName + '"');
  }
  if (typeof row.command === 'string' && row.command !== '' && typeof live.command === 'string' && live.command !== '') {
    checked.push('command');
    if (row.command !== live.command) mismatched.push('command is "' + row.command + '" and the manifest says "' + live.command + '"');
  }
  if (Array.isArray(row.envKeys) && Array.isArray(live.configKeys)) {
    checked.push('configured keys');
    if (!sameSet(row.envKeys, live.configKeys)) mismatched.push('the configured keys are ' + JSON.stringify(sorted(row.envKeys)) + ' and the manifest records ' + JSON.stringify(sorted(live.configKeys)));
  }
  if (checked.length === 0) return { verdict: 'inconclusive', detail: 'nothing about the running row can be compared with the manifest' };
  if (mismatched.length > 0) return { verdict: 'mismatched', detail: mismatched.join('; '), checked };
  return { verdict: 'matches', detail: '', checked };
}

/**
 * Whether an action may run, and exactly what it would change.
 *
 * @returns `{allowed, code, reasons, changes, evidence, outcome, ...}` — a plan, never an effect.
 */
export function planRepair({ action, slug, txid, diagnosis, live, row, root, bundleDir }) {
  const reasons = [];
  const changes = [];
  const evidence = [];
  const base = diagnosis === null || diagnosis === undefined ? {} : diagnosis;
  const state = typeof base.state === 'string' ? base.state : '';
  const phase = typeof base.phase === 'string' ? base.phase : '';
  const declared = typeof base.txid === 'string' ? base.txid : '';
  const findings = Array.isArray(base.findings) ? base.findings : [];
  const official = base.official === null || base.official === undefined ? { readable: false } : base.official;
  const shared = base.shared === null || base.shared === undefined ? null : base.shared;
  const paths = tx.txPaths(root, slug);
  const effective = txid !== '' ? txid : declared;
  // Every path this module reports is relative to the market root, and anything that would climb
  // out of it is marked rather than printed: a diagnostic answer is not a place to leak an absolute
  // path, which is also why the shapes below are checked instead of trusted.
  const relative = (full) => {
    const value = relativeTo(root, full);
    if (value === '' || isAbsolute(value) || value === '..' || value.startsWith('..' + sep)) return '<outside>';
    return value.split(sep).join('/');
  };
  const refuse = (code) => ({
    action, slug, txid: effective, allowed: false, code: code === undefined ? 'repair-refused' : code,
    reasons: reasons.length === 0 ? ['the action is not allowed in this state'] : reasons,
    changes: [], evidence, outcome: 'refused', state, phase, pendingRestart: false, verified: false, live: false,
  });

  // Guards that apply to every action, before any of them gets to argue for itself.
  if (state === 'lock-blocked') { reasons.push('a lock is present on this slug, so nothing may be changed'); return refuse('lock-blocked'); }
  if (state === 'journal-corrupt') reasons.push('the journal cannot be read, so nothing on this slug can be attributed');
  if (state === 'profile-unreadable') reasons.push('the profile cannot be read, so its state is unknown');
  for (const finding of findings) {
    if (finding.code === 'untrusted-journal-path') reasons.push('the journal names a path outside this transaction\'s own directory');
    if (finding.code === 'unknown-phase') reasons.push('the journal names a phase this plugin does not define');
    if (finding.code === 'suspicious-artifact-name') reasons.push('an artifact is not a directory of the shape this plugin creates');
  }
  if (reasons.length > 0) return refuse();
  if (txid !== '' && declared !== '' && txid !== declared) {
    reasons.push('the requested transaction (' + txid + ') is not the one on disk (' + declared + ')');
    return refuse();
  }
  if (effective === '') { reasons.push('no transaction was named, and none is on disk for this slug'); return refuse(); }

  const stagingDir = join(paths.staging, effective);
  const backupDir = join(paths.backup, effective);
  const staging = artifact(stagingDir);
  const backup = artifact(backupDir);
  const published = live !== null && live !== undefined && live.present === true ? live : null;
  const publishedIsOurs = published !== null && published.manifestOk === true && published.txid === effective;

  const planDiscard = () => {
    const hasJournal = declared !== '';
    if (!staging.present && !hasJournal) {
      evidence.push('no staged directory and no journal for this transaction');
      return { allowed: true, already: true, changes: [], outcome: 'already-completed' };
    }
    if (!staging.present) { reasons.push('the journal describes a staged run, but no staged directory is there'); return null; }
    if (staging.usable !== true) { reasons.push('the staged directory cannot be discarded: ' + staging.reason); return null; }
    if (staging.txid !== effective) { reasons.push('the staged directory claims a different transaction (' + staging.txid + ')'); return null; }
    if (hasJournal && !UNPUBLISHED_PHASES.includes(phase) && phase !== 'NEEDS_ATTENTION') {
      reasons.push('the journal has already moved past staging (phase ' + phase + '), so the published bundle is involved and this is not a discard');
      return null;
    }
    evidence.push('manifest names ' + effective, 'content matches the recorded digest');
    return {
      allowed: true, already: false,
      changes: [{ path: relative(stagingDir), kind: 'remove-directory' }, { path: relative(paths.journal), kind: 'delete-journal' }],
      outcome: 'discarded',
    };
  };

  const planRollback = () => {
    if (shared !== null && Array.isArray(shared.others) && shared.others.length > 0) {
      reasons.push('another profile reads this bundle (' + shared.others.join(', ') + '), so replacing it is not this request\'s to do');
      return null;
    }
    if (official.readable !== true) { reasons.push('the profile state cannot be read, so a rollback cannot be shown to be safe'); return null; }
    if (!published && !backup.present) { reasons.push('there is no published directory and no backup, so there is nothing to roll back to'); return null; }
    if (published !== null && !publishedIsOurs) {
      reasons.push('the published directory does not claim this transaction (' + (published.txid === '' ? 'no transaction id' : published.txid) + ')');
      return null;
    }
    if (publishedIsOurs) {
      const content = tx.verifyBundleContent(bundleDir);
      if (content.ok !== true || content.verifiable !== true || content.matches !== true) {
        reasons.push('the published directory is not the content this transaction rendered: ' + (content.reason || 'the digest does not match'));
        return null;
      }
      evidence.push('published directory names ' + effective, 'its content still matches the recorded digest');
    }
    if (backup.present) {
      if (backup.usable !== true) { reasons.push('the backup cannot be verified: ' + backup.reason); return null; }
      evidence.push('backup content matches the digest its own manifest records');
      if (official.installed !== true) {
        reasons.push('the profile no longer lists this bundle as installed, so restoring the previous version would resurrect something nothing refers to');
        return null;
      }
      changes.push({ path: relative(backupDir), kind: 'rename-to-published', to: relative(bundleDir) });
    } else {
      evidence.push('no backup exists, so this was a first install');
      if (official.installed === true) {
        reasons.push('the profile lists this bundle as installed, so this is not a first install that can simply be undone');
        return null;
      }
    }
    if (publishedIsOurs) changes.unshift({ path: relative(bundleDir), kind: 'remove-directory' });
    changes.push({ path: relative(paths.journal), kind: 'delete-journal' });
    return { allowed: true, already: false, changes, outcome: 'rolled-back' };
  };

  const planAccept = () => {
    if (state !== 'published-not-verified') {
      reasons.push('accept is only for a published version whose verification never ran; this state is ' + (state === '' ? 'unknown' : state));
      return null;
    }
    if (published === null || !publishedIsOurs) { reasons.push('the published directory does not claim this transaction'); return null; }
    const content = tx.verifyBundleContent(bundleDir);
    if (content.ok !== true || content.verifiable !== true || content.matches !== true) {
      reasons.push('the published directory is not the content this transaction rendered: ' + (content.reason || 'the digest does not match'));
      return null;
    }
    evidence.push('published directory names ' + effective, 'its content still matches the recorded digest');
    if (official.readable !== true) { reasons.push('the profile state cannot be read, so the persisted result cannot be verified'); return null; }
    if (official.installed !== true) { reasons.push('the profile does not list this bundle as installed, so the persisted state is not correct'); return null; }
    evidence.push('the profile lists the bundle as an installed dependency');
    const comparison = compareRow(row, published);
    if (comparison.verdict === 'mismatched') { reasons.push('the running configuration is not this version: ' + comparison.detail); return null; }
    if (comparison.verdict === 'inconclusive') { reasons.push('the running configuration cannot be compared with the manifest: ' + comparison.detail); return null; }
    const pendingRestart = comparison.verdict === 'absent';
    if (comparison.verdict === 'matches') evidence.push('the running row matches the manifest on ' + comparison.checked.join(', '));
    return {
      allowed: true, already: false, outcome: 'accepted', pendingRestart, verified: true, live: comparison.verdict === 'matches',
      changes: [{ path: relative(paths.journal), kind: 'delete-journal' }],
    };
  };

  let chosen = null;
  if (action === 'discard-staging') chosen = planDiscard();
  else if (action === 'rollback') {
    if (declared === '' && !backup.present && !publishedIsOurs) {
      evidence.push('no journal and no artifact for this transaction');
      chosen = { allowed: true, already: true, changes: [], outcome: 'already-completed' };
    } else chosen = planRollback();
  } else if (action === 'accept') {
    if (declared === '' && !existsSync(paths.journal)) {
      evidence.push('no journal for this transaction');
      chosen = { allowed: true, already: true, changes: [], outcome: 'already-completed' };
    } else chosen = planAccept();
  } else if (action === 'retry-recovery') {
    if (state !== 'needs-attention') { reasons.push('retry-recovery is only for a transaction already marked as needing attention; this state is ' + (state === '' ? 'unknown' : state)); }
    else chosen = planRollback();
    if (chosen === null) { reasons.length = 0; chosen = planDiscard(); if (chosen !== null) reasons.length = 0; }
  } else {
    reasons.push('unknown action');
  }

  if (chosen === null) return refuse();
  if (chosen.already === true) {
    return { action, slug, txid: effective, allowed: true, code: '', reasons: [], changes: [], evidence, outcome: 'already-completed', state, phase, pendingRestart: false, verified: false, live: false };
  }
  return {
    action, slug, txid: effective, allowed: true, code: '', reasons: [], changes: chosen.changes, evidence,
    outcome: chosen.outcome, state, phase,
    pendingRestart: chosen.pendingRestart === true, verified: chosen.verified === true, live: chosen.live === true,
  };
}

/**
 * Carry out a plan that was just allowed.
 *
 * The intent is written to the journal before each dangerous step, so an interruption is a state
 * somebody can read rather than a directory that vanished. A step that fails stops everything: the
 * backup, the published directory and the journal are all left for a person.
 */
export function executeRepair({ action, root, slug, txid, plan, bundleDir, expected }) {
  const paths = tx.txPaths(root, slug);
  const stagingDir = join(paths.staging, txid);
  const backupDir = join(paths.backup, txid);
  const announce = (phase, intent) => tx.writeJournal(root, slug, {
    txid, slug, operation: 'repair', phase, intent,
    expected: expected === undefined || expected === null ? {} : expected,
    staging: '.tx/' + slug + '/staging/' + txid,
    backup: '.tx/' + slug + '/backup/' + txid,
    repair: action,
  });
  const attention = (cause, reason) => {
    announce('NEEDS_ATTENTION', 'restore-failed');
    return { ok: false, code: 'needs-attention', message: cause + ' — ' + reason, changes: plan.changes, outcome: 'needs-attention' };
  };

  if (plan.outcome === 'already-completed') return { ok: true, outcome: 'already-completed', changes: [] };

  if (action === 'discard-staging') {
    const written = announce('ROLLED_BACK', 'discard-staging');
    if (written.ok !== true) return { ok: false, code: 'repair-refused', message: 'the intent could not be recorded, so nothing was discarded: ' + written.reason, changes: [], outcome: 'refused' };
    try {
      tx.discardStaging(root, slug, txid);
    } catch (error) {
      return attention('the staged directory could not be discarded', messageOf(error));
    }
    tx.clearJournal(root, slug);
    return { ok: true, outcome: 'discarded', changes: plan.changes };
  }

  if (action === 'accept') {
    // Nothing dangerous happens here: the transaction already published what it published, and the
    // only effect is that its journal stops describing it as unfinished.
    tx.clearJournal(root, slug);
    return { ok: true, outcome: 'accepted', changes: plan.changes, pendingRestart: plan.pendingRestart === true, verified: plan.verified === true, live: plan.live === true };
  }

  // rollback and retry-recovery both end with the previous version in place.
  const written = announce('ROLLED_BACK', 'restore-backup');
  if (written.ok !== true) return { ok: false, code: 'repair-refused', message: 'the intent could not be recorded, so nothing was changed: ' + written.reason, changes: [], outcome: 'refused' };
  const removingPublished = plan.changes.some((change) => change.kind === 'remove-directory');
  if (removingPublished && existsSync(bundleDir)) {
    const verified = tx.verifyBundleContent(bundleDir);
    if (verified.ok !== true || verified.matches !== true || verified.txid !== txid) {
      return attention('the published directory changed since the check', 'it is left exactly as it is');
    }
    try {
      tx.faultForTest('repair-remove');
      rmSync(bundleDir, { recursive: true, force: true });
      // An rm that does not throw is not proof the directory is gone: on Windows a file another
      // process holds open is skipped, and the call still returns. The effect is checked, and a
      // directory that survived is not renamed over.
      if (existsSync(bundleDir)) return attention('the published directory survived its removal', 'a file inside it is held by another process, so nothing was renamed over it');
    } catch (error) {
      return attention('the published directory could not be removed', messageOf(error));
    }
  }
  if (existsSync(backupDir)) {
    let info;
    try {
      info = lstatSync(backupDir);
    } catch (error) {
      return attention('the backup could not be inspected', messageOf(error));
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return attention('the backup is not a directory', 'a link or a file is never renamed into place');
    const verified = tx.verifyBundleContent(backupDir);
    if (verified.ok !== true || verified.matches !== true) return attention('the backup changed since the check', 'it is left exactly as it is');
    try {
      tx.faultForTest('repair-restore');
      renameSync(backupDir, bundleDir);
    } catch (error) {
      return attention('the previous version could not be put back', messageOf(error));
    }
  }
  tx.clearJournal(root, slug);
  return { ok: true, outcome: 'rolled-back', changes: plan.changes };
}
