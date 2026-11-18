import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { id } from './common.mjs';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Use a private data directory');
    chmodSync(directory, 0o700);
    const file = join(directory, 'coordinator.db');
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Use a regular database');
    const existing = existsSync(file);
    if (existing) {
      const probe = new DatabaseSync(file, { readOnly: true });
      try {
        if (probe.prepare('PRAGMA application_id').get().application_id !== 1095911473
          || probe.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Unrecognized database; choose an empty data directory');
      } finally { probe.close(); }
    }
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    if (!existing) this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }
  load() { const r = this.db.prepare('SELECT value FROM room WHERE singleton=1').get(); return r ? JSON.parse(r.value) : null; }
  save(state) { this.db.prepare('INSERT INTO room VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value').run(JSON.stringify(state)); }
  ids(namespace) {
    return {
      fromProvider: (kind, provider) => {
        if (typeof provider !== 'string' || !provider || provider.length > 1024) throw new Error('Invalid provider response');
        let row = this.db.prepare('SELECT opaque FROM provider_ids WHERE namespace=? AND kind=? AND provider=?').get(namespace, kind, provider);
        if (!row) {
          row = { opaque: id() };
          this.db.prepare('INSERT INTO provider_ids VALUES(?,?,?,?)').run(namespace, kind, provider, row.opaque);
        }
        return row.opaque;
      },
      toProvider: (kind, opaque) => this.db.prepare('SELECT provider FROM provider_ids WHERE namespace=? AND kind=? AND opaque=?').get(namespace, kind, opaque)?.provider ?? null,
    };
  }
  close() { this.db.close(); }
}
