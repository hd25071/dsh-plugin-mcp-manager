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
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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
  // \`verifyBundleContent\` is the one predicate here: a directory is usable only when its content
  // matches what the transaction recorded, and only when that record covers everything inside it.
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
  const extra = Array.isArray(content.unchecked) ? content.unchecked : [];
  if (content.coverage !== 'whole-bundle' && extra.length > 0) {
    return { present: true, usable: false, reason: 'the bundle holds files this manifest does not cover (' + extra.join(', ') + ')' };
  }
  return { present: true, usable: true, txid: content.txid, digest: content.recorded, configDigest: content.configDigest, configDigestV2: content.configDigestV2, configEvidence: content.configEvidence, coverage: content.coverage };
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
  // The configuration itself, compared without any of it being written down. Only version 2
  // evidence is used: version 1 could not see the transport, the command, the order of the
  // arguments or which namespace the values belonged to, so agreeing with it does not show that the
  // running configuration is this version's. There is no fallback to it — a fallback would authorise
  // exactly the operations the weaker evidence could not distinguish.
  const evidence = typeof live.configEvidence === 'string' ? live.configEvidence : 'absent';
  if (evidence !== 'v2') {
    return { verdict: 'incomplete', detail: 'the manifest records no usable version 2 configuration evidence (' + evidence + ')' };
  }
  if (row === null || row === undefined || row.present !== true) {
    return { verdict: 'incomplete', detail: 'the running configuration has no row for this bundle' };
  }
  // A row that does not say how the server starts is not filled in from the manifest: a default
  // would be a claim about the running configuration that nothing observed.
  if (typeof row.transport !== 'string' || row.transport === '' || typeof row.command !== 'string' || row.command === '') {
    return { verdict: 'incomplete', detail: 'the running row does not record the transport and the command that the summary covers' };
  }
  checked.push('the launch fields: transport, command, arguments and the configured ' + evidence + ' values');
  const summary = tx.configSummaryOf({ transport: row.transport, command: row.command, args: row.args, env: row.env, headers: row.headers });
  if (live.configNamespace !== '' && summary.namespace !== live.configNamespace) {
    mismatched.push('the running row configures ' + summary.namespace + ' and the manifest summarised ' + live.configNamespace);
  } else if (summary.digest !== live.configDigestV2) {
    mismatched.push('the running configuration is not the one this version was installed with');
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
    // Whoever is running now has to be one of the two versions this transaction knows about: the
    // one it published, or the one it backed up. A third configuration means something changed
    // outside this transaction, and a rollback would overwrite it.
    // An update replaces a configuration that is running, so the running one has to be shown to be
    // one of the two versions this transaction knows — and only version 2 evidence can show it.
    // A first install has no running configuration to preserve: it never became one, so it is judged
    // on ownership and on the official install state instead, and none of this applies to it.
    if (backup.present) {
      const known = [
        live && live.configEvidence === 'v2' ? live.configDigestV2 : '',
        backup.configEvidence === 'v2' ? backup.configDigestV2 : '',
      ].filter((value) => typeof value === 'string' && value !== '');
      if (known.length === 0) {
        reasons.push('neither the published version nor the backup records usable version 2 configuration evidence (published: '
          + String((live && live.configEvidence) || 'absent') + ', backup: ' + String(backup.configEvidence || 'absent')
          + '), so the running configuration cannot be shown to be one of them');
        return null;
      }
      if (row === null || row === undefined || row.present !== true) {
        reasons.push('the running configuration has no row for this bundle, so the effect of a rollback cannot be predicted');
        return null;
      }
      if (typeof row.transport !== 'string' || row.transport === '' || typeof row.command !== 'string' || row.command === '') {
        reasons.push('the running row does not record the transport and the command, so a rollback cannot be shown to preserve it');
        return null;
      }
      const running = tx.configSummaryOf({ transport: row.transport, command: row.command, args: row.args, env: row.env, headers: row.headers });
      if (!known.includes(running.digest)) {
        reasons.push('the running configuration matches neither the published version nor the backup, so it changed outside this transaction');
        return null;
      }
      evidence.push('the running configuration is one of the two versions this transaction knows, on version 2 evidence');
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
    if (publishedIsOurs) {
      changes.unshift({ path: relative(join(paths.quarantine, effective)), kind: 'quarantine-published' });
      changes.splice(1, 0, { path: relative(bundleDir), kind: 'move-to-quarantine' });
    }
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
    if (comparison.verdict === 'incomplete') {
      // The persisted state checks out, but the values cannot be shown to be the ones that were
      // rendered — and a verification that cannot be completed is not a verification.
      reasons.push('the running configuration cannot be compared value by value with this version: ' + comparison.detail);
      return { incomplete: true };
    }
    if (comparison.verdict === 'mismatched') { reasons.push('the running configuration is not this version: ' + comparison.detail); return null; }
    if (comparison.verdict === 'inconclusive') { reasons.push('the running configuration cannot be compared with the manifest: ' + comparison.detail); return null; }
    if (comparison.verdict === 'absent') {
      // A restart is not inferred from an absence. Until an operation records the installer's own
      // restart requirement, a missing row means the running configuration cannot be verified at
      // all — an incomplete verification, never a success and never a live configuration.
      reasons.push('the running configuration does not carry this bundle, and this transaction records no restart requirement from the installer, so the effect of the publish cannot be verified');
      return { incomplete: true };
    }
    if (comparison.verdict === 'never') {
      if (official.rowPersisted !== true) {
        reasons.push('the running configuration has no row for this bundle, and the profile does not list that row as persisted either, so the install never took effect');
        return null;
      }
      return {
        allowed: true, already: false, outcome: 'accepted', pendingRestart: true, verified: true, live: false,
        restartEvidence: ['the profile lists this bundle as an installed dependency', 'the profile persists row ' + String(published.rowId) + ' for it', 'the published content matches what this transaction rendered', 'the running configuration does not carry that row yet'],
        changes: [{ path: relative(paths.journal), kind: 'delete-journal' }],
      };
    }
    evidence.push('the running row matches the manifest on ' + comparison.checked.join(', '));
    return {
      allowed: true, already: false, outcome: 'accepted', pendingRestart: false, verified: true, live: true,
      changes: [{ path: relative(paths.journal), kind: 'delete-journal' }],
    };
  };

  let chosen = null;
  let incomplete = false;
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
    } else {
      chosen = planAccept();
      if (chosen !== null && chosen.incomplete === true) incomplete = true;
    }
  } else if (action === 'retry-recovery') {
    if (state !== 'needs-attention' && state !== 'quarantine-pending') { reasons.push('retry-recovery is only for a transaction a recovery already interrupted; this state is ' + (state === '' ? 'unknown' : state)); }
    else {
      chosen = planRollback();
      if (chosen === null || chosen.incomplete === true) {
        // The reason a retry could not finish belongs to the recovery it was trying to finish, so
        // the rollback's reasons are kept and only replaced when a discard is the real answer.
        const refusedRollback = reasons.slice();
        reasons.length = 0;
        const discarded = chosen === null ? planDiscard() : null;
        if (discarded === null) {
          reasons.length = 0;
          reasons.push(...refusedRollback);
          chosen = null;
        } else {
          reasons.length = 0;
          chosen = discarded;
        }
      }
    }
  } else {
    reasons.push('unknown action');
  }

  if (chosen === null || chosen.incomplete === true) {
    if (incomplete) {
      return {
        action, slug, txid: effective, allowed: false, code: 'verification-incomplete', reasons,
        changes: [], evidence, outcome: 'refused', state, phase, pendingRestart: false, verified: false, live: false,
      };
    }
    return refuse();
  }
  if (chosen.already === true) {
    return { action, slug, txid: effective, allowed: true, code: '', reasons: [], changes: [], evidence, outcome: 'already-completed', state, phase, pendingRestart: false, verified: false, live: false };
  }
  return {
    action, slug, txid: effective, allowed: true, code: '', reasons: [], changes: chosen.changes, evidence,
    outcome: chosen.outcome, state, phase,
    pendingRestart: chosen.pendingRestart === true, verified: chosen.verified === true, live: chosen.live === true,
    restartEvidence: chosen.restartEvidence === undefined ? [] : chosen.restartEvidence,
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
    return { ok: true, outcome: 'accepted', changes: plan.changes, pendingRestart: plan.pendingRestart === true, verified: plan.verified === true, live: plan.live === true, restartEvidence: plan.restartEvidence === undefined ? [] : plan.restartEvidence };
  }

  // rollback and retry-recovery both end with the previous version in place, and neither of them
  // deletes the published bundle in place: it is moved aside first, so a recovery that stops
  // halfway leaves both versions on disk rather than one half of one.
  const quarantineDir = join(paths.quarantine, txid);
  const movingPublished = plan.changes.some((change) => change.kind === 'move-to-quarantine');
  if (movingPublished && existsSync(bundleDir)) {
    const verified = tx.verifyBundleContent(bundleDir);
    if (verified.ok !== true || verified.matches !== true || verified.txid !== txid) {
      return attention('the published directory changed since the check', 'it is left exactly as it is');
    }
    const written = announce('ROLLED_BACK', 'quarantine-published');
    if (written.ok !== true) return { ok: false, code: 'repair-refused', message: 'the intent could not be recorded, so nothing was changed: ' + written.reason, changes: [], outcome: 'refused' };
    try {
      if (existsSync(quarantineDir)) return attention('a quarantined copy of this transaction already exists', 'it is not overwritten');
      mkdirSync(paths.quarantine, { recursive: true });
      tx.faultForTest('repair-quarantine');
      renameSync(bundleDir, quarantineDir);
    } catch (error) {
      return attention('the published directory could not be moved aside', messageOf(error));
    }
  }
  const written = announce('ROLLED_BACK', 'restore-backup');
  if (written.ok !== true) return { ok: false, code: 'repair-refused', message: 'the intent could not be recorded, so nothing was changed: ' + written.reason, changes: [], outcome: 'refused' };
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
    // The restore is only done when the directory that is now published verifies as the version that
    // was just moved into place — otherwise a rename that "worked" would be the whole evidence.
    const restored = tx.verifyBundleContent(bundleDir);
    if (restored.ok !== true || restored.matches !== true) {
      return attention('the restored directory does not verify', 'the backup was moved into place but does not match its own digest');
    }
  }
  let quarantineLeft = false;
  if (existsSync(quarantineDir)) {
    // Cleaning up is the last step and the least important one: it may fail without the recovered
    // bundle being any worse off, and it is never reported as a failure of the rollback.
    try {
      tx.faultForTest('repair-quarantine-clean');
      rmSync(quarantineDir, { recursive: true, force: true });
      quarantineLeft = existsSync(quarantineDir);
    } catch {
      quarantineLeft = true;
    }
  }
  tx.clearJournal(root, slug);
  return { ok: true, outcome: 'rolled-back', changes: plan.changes, quarantineLeft };
}
