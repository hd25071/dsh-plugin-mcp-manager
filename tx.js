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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const reasons = [];
  if (journal.ok !== true) reasons.push(journal.reason);
  else if (journal.record !== null) {
    reasons.push('a journal from ' + String(journal.record.txid) + ' stopped at ' + String(journal.record.phase));
  }
  if (staging.length > 0) reasons.push('staged directories: ' + staging.join(', '));
  if (backups.length > 0) reasons.push('backup directories: ' + backups.join(', '));
  return {
    present: reasons.length > 0,
    journal: journal.ok === true ? journal.record : null,
    journalUnreadable: journal.ok !== true,
    staging,
    backups,
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

/** The transaction id a published bundle's own manifest claims, or an empty string. */
export function publishedTxid(bundleDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'market.meta.json'), 'utf8'));
    return typeof manifest.txid === 'string' ? manifest.txid : '';
  } catch {
    return '';
  }
}
