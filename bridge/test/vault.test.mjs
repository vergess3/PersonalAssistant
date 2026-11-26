import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EncryptedStore,acquireLock } from '../src/vault.mjs';
test('atomic encrypted file roundtrip rejects corrupt ciphertext',{skip:process.platform!=='win32'},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hilly-vault-test-'));
  const file=path.join(dir,'test.dpapi'),store=new EncryptedStore(file);
  store.save({test:'synthetic-private-value'});assert.deepEqual(store.load(),{test:'synthetic-private-value'});
  assert.equal(fs.readFileSync(file).includes(Buffer.from('synthetic-private-value')),false);
  store.save({test:'updated'});assert.deepEqual(store.load(),{test:'updated'});
  fs.writeFileSync(file,'invalid');assert.throws(()=>store.load(),/unreadable/);
  fs.unlinkSync(file);fs.rmdirSync(dir);
});
test('single-instance lock prevents simultaneous consumers',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hilly-lock-test-')),file=path.join(dir,'bridge.lock');
  const release=acquireLock(file);assert.throws(()=>acquireLock(file),/already_running/);release();assert.equal(fs.existsSync(file),false);fs.rmdirSync(dir);
});
