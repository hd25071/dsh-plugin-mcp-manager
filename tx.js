/**
 * One staged, journalled bundle transaction.
 *
 * The published bundle is a directory other profiles link to, so replacing it takes two renames —
 * and two renames are not one operation. Windows refuses to rename onto an existing directory,
 * which is exactly why the old directory has to move aside first, and it is also why a crash
 * between the two leaves the bundle directory missing while its content sits in a backup.
 *
 * So neither rename is treated as safe on its own. Each one is announced in a journal first, and a
 * transaction that cannot finish keeps everything it could not put back and says so, instead of
 * guessing. The layout below is the whole state of a transaction:
 *
 *   <root>/.tx/<slug>/journal.json      what it was doing, and where it stopped
 *   <root>/.tx/<slug>/staging/<txid>/   the complete next version, before it is published
 *   <root>/.tx/<slug>/backup/<txid>/    the previous version, while the new one is applied
 *
 * Nothing here reads a config value: the journal carries identifiers, paths and a digest, never the
 * secrets that live in the bundle. The journal is replaced through a temporary file and a rename,
 * which is atomic against a concurrent reader, but that is NOT a durability barrier — nothing in
 * this process can promise the bytes reached the platter, only that the file system was asked to
 * store them. A transaction is therefore recoverable by inspection, never by assumption.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The shape of a journal record; bumped when a reader would have to read it differently. */
export const TX_SCHEMA = 1;
/** Every phase a transaction may be in. Only the last two are terminal. */
export const TX_PHASES = [
  'PREPARE', 'STAGED', 'JOURNALED', 'BACKED_UP', 'PUBLISHED', 'APPLYING', 'VERIFYING',
  'DONE', 'ROLLED_BACK', 'NEEDS_ATTENTION',
];
/** Phases a transaction never leaves by itself. Anything else found on disk is a stranded run. */
export const TX_TERMINAL = ['DONE', 'ROLLED_BACK'];

export function newTxid() {
  return randomUUID();
}

function messageOf(error) {
  return String((error && error.message) || error);
}

/** Where one slug's transaction state lives. */
export function txPaths(root, slug) {
  const slugRoot = join(root, '.tx', slug);
  return {
    slugRoot,
    journal: join(slugRoot, 'journal.json'),
    staging: join(slugRoot, 'staging'),
    backup: join(slugRoot, 'backup'),
    // A published version is moved here, never deleted in place: a recursive delete that partly
    // fails leaves a directory that is neither the old version nor the new one.
    quarantine: join(slugRoot, 'quarantine'),
  };
}

const listing = (dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/**
 * Make one step fail, for the cases that have to prove the compensation paths.
 *
 * It can only make an operation fail. It cannot skip a check, reorder a step, or reach a state the
 * code could not otherwise reach, so it cannot turn a guarded path into an unguarded one — but
 * without it the rollback after a failed rename would be a claim rather than something observed.
 */
function fault(step) {
  const named = String(process.env.MCP_MARKET_FAULT || '').split(',').map((part) => part.trim());
  if (!named.includes(step)) return;
  const error = new Error('injected fault: ' + step);
  error.code = 'injected-fault';
  error.step = step;
  throw error;
}

/**
 * Make one named step fail, for a caller that has to prove what happens when it does.
 *
 * Exported so a failure that is hard to produce on purpose — a rename Windows refuses, a handle it
 * holds — has a deterministic stand-in in a test. It can only fail a step; it cannot skip a check.
 */
export function faultForTest(step) {
  fault(step);
}

/** Read the journal, telling "no journal" apart from "a journal that cannot be read". */
export function readJournal(root, slug) {
  const { journal } = txPaths(root, slug);
  let text;
  try {
    text = readFileSync(journal, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, record: null };
    return { ok: false, reason: journal + ' could not be read (' + error.code + ')' };
  }
  try {
    return { ok: true, record: JSON.parse(text) };
  } catch {
    return { ok: false, reason: journal + ' is not readable JSON' };
  }
}

/** Replace the journal through a temporary file, so a reader never sees half a record. */
export function writeJournal(root, slug, record) {
  const { slugRoot, journal } = txPaths(root, slug);
  try {
    mkdirSync(slugRoot, { recursive: true });
    fault('journal-write');
    const temporary = journal + '.' + String(record.txid || 'unknown') + '.tmp';
    writeFileSync(temporary, JSON.stringify({ schema: TX_SCHEMA, at: new Date().toISOString(), ...record }, null, 2), 'utf8');
    renameSync(temporary, journal);
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
  return { ok: true };
}

export function clearJournal(root, slug) {
  try {
    rmSync(txPaths(root, slug).journal, { force: true });
  } catch {
    // A journal that cannot be removed is reported by the next residue check, not hidden here.
  }
}

/**
 * What is left over from an earlier run, whatever it was.
 *
 * A journal, a staged directory or a backup directory all mean the same thing to a new transaction:
 * this slug has state whose owner it cannot prove, and continuing would adopt somebody else's
 * half-finished work. Nothing is deleted here — this only reads.
 */
export function residue(root, slug) {
  const paths = txPaths(root, slug);
  const journal = readJournal(root, slug);
  const staging = listing(paths.staging);
  const backups = listing(paths.backup);
  const quarantined = listing(paths.quarantine);
  const reasons = [];
  if (journal.ok !== true) reasons.push(journal.reason);
  else if (journal.record !== null) {
    reasons.push('a journal from ' + String(journal.record.txid) + ' stopped at ' + String(journal.record.phase));
  }
  if (staging.length > 0) reasons.push('staged directories: ' + staging.join(', '));
  if (backups.length > 0) reasons.push('backup directories: ' + backups.join(', '));
  if (quarantined.length > 0) reasons.push('quarantined directories: ' + quarantined.join(', '));
  return {
    present: reasons.length > 0,
    journal: journal.ok === true ? journal.record : null,
    journalUnreadable: journal.ok !== true,
    staging,
    backups,
    quarantined,
    reason: reasons.join('; '),
  };
}

/** Make this transaction's staging directory. */
export function openStaging(root, slug, txid) {
  const dir = join(txPaths(root, slug).staging, txid);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, dir, reason: messageOf(error) };
  }
  return { ok: true, dir };
}

/**
 * Write the whole next version into staging.
 *
 * The renderer is handed the staging directory and nothing else, so there is no way for it to reach
 * the published bundle: a failure here cannot have touched it. A render that throws takes its own
 * staging directory with it.
 */
export function writeStaged(root, slug, txid, render) {
  const dir = join(txPaths(root, slug).staging, txid);
  try {
    fault('stage-write');
    const result = render(dir);
    return { ok: true, dir, result };
  } catch (error) {
    const discarded = discardStaging(root, slug, txid);
    return { ok: false, dir, reason: messageOf(error), discarded: discarded.ok === true };
  }
}

export function discardStaging(root, slug, txid) {
  const dir = join(txPaths(root, slug).staging, txid);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
  return { ok: true };
}

/** Drop a transaction's backup once it is finished with it. */
export function discardBackup(root, slug, txid) {
  const dir = join(txPaths(root, slug).backup, txid);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
  return { ok: true };
}

/**
 * Move the published bundle aside, then put the staged one in its place.
 *
 * The announce callback is called before each rename and must persist it: the caller owns what the
 * journal says, this function owns when it is written. The return says where it stopped, so the
 * caller knows whether a restore is owed and whether the published directory is this transaction's.
 */
export function publish({ root, slug, bundleDir, txid, existed, announce }) {
  const paths = txPaths(root, slug);
  const stagingDir = join(paths.staging, txid);
  const backupDir = join(paths.backup, txid);
  let backedUp = false;

  const announced = announce(existed ? 'BACKED_UP' : 'STAGED', existed ? 'move-existing-to-backup' : 'move-staging-into-place');
  if (announced.ok !== true) return { ok: false, stage: 'journal', reason: announced.reason, backedUp, published: false };

  if (existed) {
    try {
      mkdirSync(paths.backup, { recursive: true });
      if (existsSync(backupDir)) {
        return { ok: false, stage: 'backup', reason: 'a backup directory for ' + txid + ' already exists, so it cannot be proven free', backedUp, published: false };
      }
      fault('backup-rename');
      renameSync(bundleDir, backupDir);
      backedUp = true;
    } catch (error) {
      return { ok: false, stage: 'backup', reason: messageOf(error), backedUp, published: false };
    }
  }

  const second = announce('BACKED_UP', 'move-staging-into-place');
  if (second.ok !== true) return { ok: false, stage: 'journal', reason: second.reason, backedUp, published: false };

  try {
    fault('publish-rename');
    renameSync(stagingDir, bundleDir);
  } catch (error) {
    return { ok: false, stage: 'publish', reason: messageOf(error), backedUp, published: false };
  }

  const third = announce('PUBLISHED', 'apply');
  if (third.ok !== true) return { ok: false, stage: 'journal', reason: third.reason, backedUp, published: true };
  return { ok: true, stage: 'published', backedUp, published: true, backupDir: backedUp ? backupDir : '' };
}

/**
 * Undo a publish: remove this transaction's directory if it is really its own, then put the backup
 * back where the bundle belongs.
 *
 * The owns flag is the caller's proof that the published directory carries this transaction's id.
 * Without it nothing is removed: an unprovable directory may be somebody's only copy.
 */
export function restore({ root, slug, bundleDir, txid, announce, owns }) {
  const paths = txPaths(root, slug);
  const backupDir = join(paths.backup, txid);
  const backupExists = existsSync(backupDir);

  const announced = announce('BACKED_UP', 'restore-backup');
  if (announced.ok !== true) return { ok: false, reason: 'the restore could not be recorded: ' + announced.reason, restored: false };

  let removed = false;
  if (existsSync(bundleDir)) {
    if (owns !== true) {
      return { ok: false, reason: 'the published directory cannot be proven to belong to this transaction', restored: false, removed: false };
    }
    // Ownership is not enough: a directory that carries our id but not our content is a directory
    // somebody else has since changed, and removing it would destroy that change.
    const content = verifyBundleContent(bundleDir);
    if (content.ok !== true || content.verifiable !== true || content.matches !== true) {
      return {
        ok: false,
        reason: 'the published directory does not match the digest this transaction rendered, so it is not removed'
          + (content.reason === undefined ? '' : ': ' + content.reason),
        restored: false,
        removed: false,
      };
    }
    try {
      rmSync(bundleDir, { recursive: true, force: true });
      removed = true;
    } catch (error) {
      return { ok: false, reason: messageOf(error), restored: false, removed: false };
    }
  }
  if (backupExists) {
    try {
      fault('restore-rename');
      renameSync(backupDir, bundleDir);
    } catch (error) {
      return { ok: false, reason: messageOf(error), restored: false, removed };
    }
  }
  // \`restored\` answers one question only: was a previous version put back? A first install has
  // none, so removing what it published is a complete undo but not a restore, and saying otherwise
  // would make a reader look for a backup that was never taken.
  return { ok: true, restored: backupExists, removed };
}

/**
 * The digest recorded for one rendered bundle.
 *
 * Names and a hash only. A manifest that names the transaction which wrote it is what makes the
 * ownership question answerable later, and the digest is what makes "this is the version I wrote"
 * checkable without keeping a second copy of it.
 */
export function digestOf(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    hash.update(name);
    hash.update('\u0000');
    hash.update(files[name]);
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/**
 * Whether a bundle directory still holds exactly what the transaction that wrote it rendered.
 *
 * The manifest records a digest of the two files the renderer produces, so this answers a question
 * the transaction id alone cannot: is this directory still the one we wrote, or has something
 * changed inside it since? A directory that fails this test is nobody's to delete — not even the
 * transaction that created it, because the content that is there now is not the content it made.
 */
export function verifyBundleContent(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'market.meta.json'), 'utf8'));
  } catch (error) {
    return { ok: false, readable: false, txid: '', reason: 'the manifest could not be read (' + String((error && error.code) || 'invalid JSON') + ')' };
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, readable: false, txid: '', reason: 'the manifest is not an object' };
  }
  const txid = typeof manifest.txid === 'string' ? manifest.txid : '';
  const recorded = typeof manifest.renderDigest === 'string' ? manifest.renderDigest : '';
  const whole = typeof manifest.contentDigest === 'string' ? manifest.contentDigest : '';
  const configDigest = typeof manifest.configDigest === 'string' ? manifest.configDigest : '';
  if (whole !== '') {
    const scanned = digestDirectory(dir);
    if (scanned.ok !== true) {
      return { ok: false, readable: true, txid, configDigest, coverage: 'unverifiable', verifiable: false, matches: false, reason: scanned.reason };
    }
    return {
      ok: true, readable: true, txid, configDigest, recorded: whole, actual: scanned.digest, coverage: 'whole-bundle',
      verifiable: true, matches: scanned.digest === whole,
      reason: scanned.digest === whole ? '' : 'the bundle contains files that are not the ones this transaction wrote',
    };
  }
  if (recorded === '') {
    // Written before the digest existed: its content cannot be checked, which is a different answer
    // from "it is fine" and must not be read as one.
    return { ok: true, readable: true, txid, configDigest, recorded: '', coverage: 'none', verifiable: false, matches: false, reason: 'the manifest records no digest, so this content cannot be verified' };
  }
  let manifestJson;
  let patch;
  try {
    manifestJson = readFileSync(join(dir, 'package.json'), 'utf8');
    patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  } catch (error) {
    return { ok: false, readable: true, txid, configDigest, recorded, reason: 'the rendered files could not be read (' + String((error && error.code) || error) + ')' };
  }
  const actual = digestOf({ 'package.json': manifestJson, 'cordis.patch.yml': patch });
  // Only the two rendered files are covered by an older digest. Anything else in the directory —
  // an mcpb payload above all — is not, and the caller is told so rather than reassured.
  const extra = readdirSync(dir).filter((name) => name !== 'package.json' && name !== 'cordis.patch.yml' && name !== 'market.meta.json');
  return {
    ok: true, readable: true, txid, configDigest, recorded, actual, coverage: 'rendered-only', verifiable: true,
    matches: actual === recorded, unchecked: extra,
    reason: actual === recorded ? '' : 'the rendered files are not the ones this transaction wrote',
  };
}

/**
 * A digest of the configured values, so they can be compared without being stored.
 *
 * accept has to answer "is the value I rendered the value that is running", and storing the values
 * to answer it would put secrets in a file that a diagnostic then reports on. A digest answers the
 * same question one way only. It is not a secret-keeping device on its own — the rendered patch
 * beside it holds the plaintext — but it means no *new* copy of a value is created.
 */
export function configDigestOf(values) {
  const hash = createHash('sha256');
  for (const key of Object.keys(values === null || values === undefined ? {} : values).sort()) {
    hash.update(key);
    hash.update('\u0000');
    hash.update(String(values[key]));
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/** How much of a bundle this reader is willing to look at before calling it too big to verify. */
const BUNDLE_FILE_LIMIT = 4096;
const BUNDLE_BYTES_LIMIT = 64 * 1024 * 1024;

/**
 * A digest of everything in a bundle directory except its own manifest.
 *
 * Bounded on purpose: a digest is only useful if it terminates, and a directory somebody has filled
 * with a million files is not a bundle this plugin wrote. A symbolic link anywhere inside is a
 * reason to stop rather than follow — a link is not content this transaction rendered.
 *
 * @returns \`{ok, digest, files}\` or \`{ok: false, reason}\`.
 */
export function digestDirectory(dir, options = {}) {
  const exclude = options.exclude === undefined ? ['market.meta.json'] : options.exclude;
  const files = [];
  let bytes = 0;
  const walk = (current, prefix) => {
    let names;
    try {
      names = readdirSync(current);
    } catch (error) {
      return { ok: false, reason: 'a directory could not be listed (' + String(error.code) + ')' };
    }
    for (const name of names.sort()) {
      const full = join(current, name);
      const relative = prefix === '' ? name : prefix + '/' + name;
      let info;
      try {
        info = lstatSync(full);
      } catch (error) {
        return { ok: false, reason: 'an entry could not be inspected (' + String(error.code) + ')' };
      }
      if (info.isSymbolicLink()) return { ok: false, reason: 'a symbolic link (' + relative + ') is not content this plugin wrote' };
      if (info.isDirectory()) {
        const nested = walk(full, relative);
        if (nested !== null) return nested;
        continue;
      }
      if (!info.isFile()) return { ok: false, reason: 'an entry (' + relative + ') is neither a file nor a directory' };
      if (exclude.includes(relative)) continue;
      if (files.length >= BUNDLE_FILE_LIMIT) return { ok: false, reason: 'the bundle holds more files than this reader will verify' };
      bytes += info.size;
      if (bytes > BUNDLE_BYTES_LIMIT) return { ok: false, reason: 'the bundle is larger than this reader will verify' };
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch (error) {
        return { ok: false, reason: 'a file could not be read (' + String(error.code) + ')' };
      }
      files.push([relative, text]);
    }
    return null;
  };
  const failure = walk(dir, '');
  if (failure !== null) return failure;
  const hash = createHash('sha256');
  for (const [name, text] of files) {
    hash.update(name);
    hash.update('\u0000');
    hash.update(text);
    hash.update('\u0000');
  }
  return { ok: true, digest: hash.digest('hex'), files: files.map(([name]) => name) };
}

/** The transaction id a published bundle's own manifest claims, or an empty string. */
export function publishedTxid(bundleDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'market.meta.json'), 'utf8'));
    return typeof manifest.txid === 'string' ? manifest.txid : '';
  } catch {
    return '';
  }
}

/**
 * What a slug's transaction state can be, and how dangerous each one is.
 *
 * These are diagnoses, not instructions. Nothing in this module acts on them: naming a state is
 * what lets a person decide, and a name is not permission to delete or rename anything.
 */
export const DIAGNOSIS_STATES = [
  'clean',
  'staged-only',
  'backup-without-live',
  'published-not-verified',
  'applying-unknown',
  'needs-attention',
  'orphan-artifacts',
  'journal-corrupt',
  'txid-mismatch',
  'profile-unreadable',
  'lock-blocked',
  'legacy-orphan',
  'shared-live',
  'quarantine-pending',
];

/** Which of the three buckets a state falls into. */
const RISK_BY_STATE = {
  clean: 'safe',
  'staged-only': 'safe',
  'backup-without-live': 'manual',
  'published-not-verified': 'manual',
  'applying-unknown': 'stop',
  'needs-attention': 'stop',
  'orphan-artifacts': 'manual',
  'journal-corrupt': 'stop',
  'txid-mismatch': 'stop',
  'profile-unreadable': 'stop',
  'lock-blocked': 'stop',
  'legacy-orphan': 'manual',
  'shared-live': 'manual',
  'quarantine-pending': 'manual',
};

/** The sentence a person gets next to the state. Never an action taken by this code. */
const NEXT_STEP_BY_STATE = {
  clean: 'nothing to do',
  'staged-only': 'the published bundle was never replaced; the staged directory can be discarded, but only once the slug lock is free',
  'backup-without-live': 'the published bundle is missing and an earlier version is sitting in a backup: restore it by hand after checking the journal, or reinstall',
  'published-not-verified': 'the new version is published but was never confirmed: compare it with the backup before deciding which one should stay',
  'applying-unknown': 'the installer may or may not have changed the profile: read the profile before touching the bundle, because the change cannot be undone from here',
  'needs-attention': 'the transaction already decided it could not put things back: read the journal and the backup, and change nothing else',
  'orphan-artifacts': 'these directories are not claimed by any journal, so their owner is unknown: identify them before removing anything',
  'journal-corrupt': 'the journal cannot be read, so nothing about this slug can be attributed: inspect it by hand',
  'txid-mismatch': 'the journal and the published bundle describe different transactions: do not assume either one is the one to keep',
  'profile-unreadable': 'the profile could not be read, so its state is unknown: fix the profile read first',
  'lock-blocked': 'an operation holds this slug, or left a lock behind: the holder is named, and nothing may be touched while it is there',
  'legacy-orphan': 'this bundle was written before transactions existed and the profile does not list it as installed',
  'shared-live': 'another profile reads this bundle: changing it in place would change what that profile loads',
  'quarantine-pending': 'a recovery was interrupted between moving the published version aside and putting the previous one back: the quarantined copy is the only one, so it is read before anything else runs',
};

/** A path as this API reports one: inside the market root, or plainly marked as not. */
function reportedPath(root, full) {
  const rel = relative(root, full);
  if (rel === '') return '.';
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../')) return '<outside>';
  return rel.split(sep).join('/');
}

/** A directory entry name is a claim, and only a plain name is even a plausible one. */
function plausibleName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/**
 * The journal's own path fields, checked rather than trusted.
 *
 * A journal is a file on disk like any other, so its contents are input from outside this process:
 * a relative path that climbs out of the transaction directory, or an absolute one, is reported as
 * untrusted and then used for nothing at all.
 */
function trustPathClaim(root, slug, claim) {
  if (typeof claim !== 'string' || claim === '') return { ok: false, relative: '' };
  const normalized = claim.split('\\').join('/');
  if (isAbsolute(claim) || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return { ok: false, relative: '' };
  }
  const full = resolve(root, normalized);
  const inside = resolve(join(root, '.tx', slug));
  if (full !== inside && !full.startsWith(inside + sep)) return { ok: false, relative: '' };
  return { ok: true, relative: normalized };
}

/**
 * Read one slug's transaction state. Read-only: every call is a listing or a read.
 *
 * Symlinks are reported as symlinks and never followed, because what a link points at is not this
 * transaction's directory and the next reader must not be told that it is.
 */
export function readArtifacts(root, slug) {
  const paths = txPaths(root, slug);
  const journal = readJournal(root, slug);
  const scan = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return { entries: [], unreadable: '' };
      return { entries: [], unreadable: reportedPath(root, dir) + ' could not be listed (' + error.code + ')' };
    }
    const entries = [];
    for (const name of names.sort()) {
      const full = join(dir, name);
      let kind = 'other';
      try {
        const info = lstatSync(full);
        if (info.isSymbolicLink()) kind = 'link';
        else if (info.isDirectory()) kind = 'dir';
        else if (info.isFile()) kind = 'file';
      } catch {
        kind = 'other';
      }
      entries.push({ name, kind, trusted: kind === 'dir' && plausibleName(name), path: reportedPath(root, full) });
    }
    return { entries, unreadable: '' };
  };
  const staging = scan(paths.staging);
  const backup = scan(paths.backup);
  const quarantine = scan(paths.quarantine);
  return {
    journal: {
      present: journal.ok === true ? journal.record !== null : true,
      ok: journal.ok === true && journal.record !== null,
      readable: journal.ok === true,
      record: journal.ok === true ? journal.record : null,
      reason: journal.ok === true ? '' : 'the journal could not be read as JSON',
    },
    staging,
    backup,
    quarantine,
    paths: {
      journal: reportedPath(root, paths.journal),
      staging: reportedPath(root, paths.staging),
      backups: reportedPath(root, paths.backup),
      quarantine: reportedPath(root, paths.quarantine),
      root: reportedPath(root, paths.slugRoot),
    },
  };
}

/**
 * What the published directory claims about itself.
 *
 * Only identifiers, a digest and a count of configured keys are read out. The manifest also holds
 * the values a person typed — `argumentValues` above all — and those are not this reader's to
 * repeat into an answer.
 */
export function readLiveBundle(bundleDir) {
  let info;
  try {
    info = lstatSync(bundleDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, kind: 'missing', manifestOk: false, txid: '', reason: '' };
    return { present: true, kind: 'unreadable', manifestOk: false, txid: '', reason: 'the published path could not be inspected (' + error.code + ')' };
  }
  if (info.isSymbolicLink()) return { present: true, kind: 'link', manifestOk: false, txid: '', reason: 'the published path is a link, so it is not this transaction\'s directory' };
  if (!info.isDirectory()) return { present: true, kind: 'not-a-directory', manifestOk: false, txid: '', reason: 'the published path is not a directory' };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(bundleDir, 'market.meta.json'), 'utf8'));
  } catch (error) {
    return {
      present: true, kind: 'directory', manifestOk: false, txid: '', reason: 'the published manifest could not be read (' + (error.code || 'invalid JSON') + ')',
    };
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { present: true, kind: 'directory', manifestOk: false, txid: '', reason: 'the published manifest is not an object' };
  }
  const txid = typeof manifest.txid === 'string' ? manifest.txid : '';
  return {
    present: true,
    kind: 'directory',
    manifestOk: true,
    txid,
    untagged: txid === '',
    registryName: typeof manifest.registryName === 'string' ? manifest.registryName : '',
    rowId: typeof manifest.rowId === 'string' ? manifest.rowId : '',
    serverName: typeof manifest.serverName === 'string' ? manifest.serverName : '',
    renderDigest: typeof manifest.renderDigest === 'string' ? manifest.renderDigest : '',
    configDigest: typeof manifest.configDigest === 'string' ? manifest.configDigest : '',
    contentDigest: typeof manifest.contentDigest === 'string' ? manifest.contentDigest : '',
    // Names, never values: the manifest also holds what a person typed into the argument slots, and
    // a diagnostic answer is not the place to read that back out.
    configKeys: Array.isArray(manifest.configKeys) ? manifest.configKeys.filter((key) => typeof key === 'string') : [],
    command: typeof manifest.command === 'string' ? manifest.command : '',
    argCount: Array.isArray(manifest.args) ? manifest.args.length : 0,
    configKeyCount: Array.isArray(manifest.configKeys) ? manifest.configKeys.length : 0,
    reason: '',
  };
}

/**
 * One slug's transaction state, from evidence that has already been read.
 *
 * Pure: every input is a summary someone else read, and nothing here touches the filesystem. The
 * ordering below is by how little can still be trusted, not by how likely each state is — the
 * first state that fits is the answer, and every finding is kept alongside it so the parts that
 * fit more than one state are not lost.
 */
export function diagnoseTransaction({ slug, root: root0, journal, staging, backup, quarantine, live, official, lock, shared, dangling }) {
  const findings = [];
  const add = (code, detail) => findings.push({ code, detail });
  const entries = (scan) => (scan && Array.isArray(scan.entries) ? scan.entries : []);
  const dirs = (scan) => entries(scan).filter((entry) => entry.trusted === true).map((entry) => entry.name);
  const suspicious = (scan) => entries(scan).filter((entry) => entry.kind !== 'dir' || entry.trusted !== true);
  const record = journal && journal.record !== null && typeof journal.record === 'object' ? journal.record : null;
  const phase = record !== null && typeof record.phase === 'string' ? record.phase : '';
  const declaredTxid = record !== null && typeof record.txid === 'string' ? record.txid : '';
  const stagingTxids = dirs(staging);
  const backupTxids = dirs(backup);
  const quarantineTxids = dirs(quarantine);

  if (journal && journal.present === true && journal.readable !== true) add('journal-unreadable', journal.reason || 'the journal could not be read');
  if (journal && journal.unreadable) add('artifacts-unreadable', journal.unreadable);
  if (staging && staging.unreadable) add('artifacts-unreadable', staging.unreadable);
  if (backup && backup.unreadable) add('artifacts-unreadable', backup.unreadable);
  for (const entry of suspicious(staging)) add('suspicious-artifact-name', 'staging entry ' + entry.name + ' is a ' + entry.kind + ', which no transaction of this plugin creates');
  for (const entry of suspicious(backup)) add('suspicious-artifact-name', 'backup entry ' + entry.name + ' is a ' + entry.kind + ', which no transaction of this plugin creates');
  if (stagingTxids.length > 0) add('staged-artifacts', stagingTxids.length + ' staged director' + (stagingTxids.length === 1 ? 'y' : 'ies'));
  if (backupTxids.length > 0) add('backup-artifacts', backupTxids.length + ' backup director' + (backupTxids.length === 1 ? 'y' : 'ies'));
  if (quarantineTxids.length > 0) {
    add('quarantined-artifacts', 'a published version was moved aside while a recovery was under way: ' + quarantineTxids.join(', '));
  }
  for (const entry of suspicious(quarantine)) add('suspicious-artifact-name', 'quarantine entry ' + entry.name + ' is a ' + entry.kind + ', which no transaction of this plugin creates');
  if (live && live.present === true && live.manifestOk !== true) add('live-manifest-unreadable', live.reason || 'the published manifest could not be read');
  if (live && live.present === true && live.manifestOk === true && live.untagged === true) {
    add('legacy-manifest', 'the published manifest has no transaction id, so ownership cannot be settled by it');
  }
  // During a staged run the published bundle is still the PREVIOUS one, so a different transaction
  // id there is the expected shape of an update in progress. From BACKED_UP onwards the published
  // directory is supposed to be this transaction's, and a different id is a real disagreement.
  const liveShouldBeOurs = phase === 'BACKED_UP' || phase === 'PUBLISHED' || phase === 'APPLYING'
    || phase === 'VERIFYING' || phase === 'NEEDS_ATTENTION';
  const mismatch = live && live.present === true && live.manifestOk === true
    && live.txid !== '' && declaredTxid !== '' && live.txid !== declaredTxid;
  if (mismatch && liveShouldBeOurs) add('txid-mismatch', 'the journal describes ' + declaredTxid + ' and the published bundle claims ' + live.txid);
  else if (mismatch) add('live-is-previous-version', 'the published bundle still claims ' + live.txid + ', which is the version this transaction is replacing');
  if (live && live.present !== true) add('live-missing', 'the published directory does not exist');
  // A lock this request is holding itself is not a reason to refuse: the reader was asked to look
  // at the slug by the very operation that owns it.
  const lockBlocks = lock !== undefined && lock !== null && lock.state !== 'free' && lock.state !== 'self';
  if (lockBlocks) add('lock-held', 'a lock is present (' + lock.reason + ')');
  if (official && official.readable !== true) add('profile-unreadable', official.reason || 'the profile state could not be read');
  if (official && official.readable === true && official.installed !== true) add('not-installed-officially', 'the profile does not list this bundle as an installed dependency');
  if (official && official.readable === true && official.rowLive !== true) add('row-not-live', 'no row in the running configuration matches this manifest');
  if (shared && shared.ok !== true) add('shared-unknown', shared.reason || 'other profiles could not be ruled out');
  if (shared && shared.ok === true && Array.isArray(shared.others) && shared.others.length > 0) {
    add('shared-with-other-profiles', 'also read by: ' + shared.others.join(', '));
  }
  if (Array.isArray(dangling) && dangling.length > 0) {
    add('dangling-link', 'a profile link points at nothing: ' + dangling.map((item) => item.profile).join(', '));
  }

  // The journal's declared paths are input, so they are checked before they mean anything.
  let untrustedPaths = false;
  if (record !== null) {
    for (const field of ['staging', 'backup']) {
      if (record[field] === undefined || record[field] === null || record[field] === '') continue;
      const claim = trustPathClaim(root0, slug, record[field]);
      if (claim.ok !== true) {
        untrustedPaths = true;
        add('untrusted-journal-path', 'the journal names a ' + field + ' path that is not inside this transaction\'s directory, so it is not used');
      }
    }
    if (phase !== '' && !TX_PHASES.includes(phase)) add('unknown-phase', 'the journal names a phase this plugin does not define');
  }

  const ownership = {
    declaredTxid,
    liveTxid: live && typeof live.txid === 'string' ? live.txid : '',
    liveBasis: live === undefined || live === null ? 'unknown'
      : live.present !== true ? 'missing'
        : live.manifestOk !== true ? 'unreadable'
          : live.untagged === true ? 'manifest-missing-txid' : 'manifest-txid',
    stagingTxids,
    backupTxids,
    quarantineTxids,
    note: 'directory names are claims made by whoever created them; only a manifest that carries a transaction id is evidence',
  };

  const readable = journal ? journal.readable === true : true;
  const present = journal ? journal.present === true : false;
  const stop = { state: 'txid-mismatch', reason: 'the journal and the published bundle disagree' };
  let state;
  if (official && official.readable !== true) state = 'profile-unreadable';
  else if (present && !readable) state = 'journal-corrupt';
  else if (record !== null && phase !== '' && !TX_PHASES.includes(phase)) state = untrustedPaths ? 'orphan-artifacts' : 'journal-corrupt';
  else if (untrustedPaths) state = 'orphan-artifacts';
  else if (lockBlocks) state = 'lock-blocked';
  else if (record !== null && phase === 'NEEDS_ATTENTION') state = 'needs-attention';
  else if (mismatch && liveShouldBeOurs) state = stop.state;
  else if (record !== null && (phase === 'APPLYING' || phase === 'VERIFYING')) state = 'applying-unknown';
  else if (record !== null && phase === 'BACKED_UP' && (live === undefined || live.present !== true)) state = 'backup-without-live';
  else if (record !== null && phase === 'PUBLISHED') state = 'published-not-verified';
  else if (record !== null && phase === 'STAGED') state = 'staged-only';
  // A published version sitting in quarantine means a recovery stopped between its two renames:
  // the bundle directory is missing on purpose, and what is in quarantine is not garbage.
  else if (quarantineTxids.length > 0) state = 'quarantine-pending';
  else if (record === null && (stagingTxids.length > 0 || backupTxids.length > 0)) state = 'orphan-artifacts';
  else if (record !== null && (stagingTxids.some((name) => name !== declaredTxid) || backupTxids.some((name) => name !== declaredTxid))) state = 'orphan-artifacts';
  else if (live && live.present === true && live.manifestOk === true && live.untagged === true && official && official.installed !== true) state = 'legacy-orphan';
  else if (shared && shared.ok === true && Array.isArray(shared.others) && shared.others.length > 0) state = 'shared-live';
  else state = 'clean';

  const risk = state === 'orphan-artifacts' && (untrustedPaths || (record !== null && phase !== '' && !TX_PHASES.includes(phase)))
    ? 'stop'
    : RISK_BY_STATE[state];
  return {
    slug,
    state,
    risk,
    phase,
    txid: declaredTxid,
    findings,
    ownership,
    artifacts: {
      journal: journal && journal.present === true ? journalPathOf(root0, slug) : '',
      staging: stagingTxids,
      backup: backupTxids,
      quarantine: quarantineTxids,
      suspicious: suspicious(staging).concat(suspicious(backup)).concat(suspicious(quarantine)).map((entry) => entry.path),
    },
    official: official === undefined ? null : official,
    lock: lock === undefined ? null : { state: lock.state, alive: lock.alive === true, txid: lock.txid || '', op: lock.op || '' },
    shared: shared === undefined || shared.ok !== true ? null : { others: shared.others, current: shared.current || '' },
    nextStep: NEXT_STEP_BY_STATE[state],
  };
}

/** The journal's own path, as reported. Kept out of the classifier so it stays a pure function. */
function journalPathOf(root, slug) {
  return reportedPath(root, txPaths(root, slug).journal);
}

/** Read a slug's state and classify it. Every call below is a listing or a read. */
export function diagnoseSlug(options) {
  const { root, slug } = options;
  const artifacts = readArtifacts(root, slug);
  return diagnoseTransaction({ ...options, ...artifacts });
}
