'use strict';
// E-Clinic regression tests: real Express, EJS, sessions, bcrypt, and in-memory
// SQLite SQL execution. No local eclinic.db file is read or modified.
// Requires Node.js 22+ for node:sqlite (experimental in some Node 22 releases).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcrypt');

// Adapt Node's in-memory SQLite API to the small better-sqlite3 API used by the
// application. Actual SQL, constraints and foreign keys are still executed.
class IsolatedDatabase {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); }
  exec(sql) { return this.sqlite.exec(sql); }
  prepare(sql) { return this.sqlite.prepare(sql); }
  pragma(text, opts = {}) {
    const rows = this.sqlite.prepare(`PRAGMA ${text}`).all();
    return opts.simple ? Object.values(rows[0] || {})[0] : rows;
  }
  transaction(callback) {
    return (...args) => {
      this.sqlite.exec('BEGIN');
      try {
        const result = callback(...args);
        this.sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      }
    };
  }
}

const previousCwd = process.cwd();
const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);
const oldLoad = Module._load;
let app;
let database;
try {
  Module._load = function (name, parent, isMain) {
    if (name === 'better-sqlite3' && parent?.filename === path.join(projectRoot, 'database.js')) {
      return IsolatedDatabase;
    }
    return oldLoad.apply(this, arguments);
  };
  // Keep the app from binding to port 3000 when imported for tests.
  const originalExpress = require('express');
  function testExpress(...args) {
    const instance = originalExpress(...args);
    testExpress._app = instance;
    instance.listen = () => undefined;
    return instance;
  }
  Object.assign(testExpress, originalExpress);
  require.cache[require.resolve('express')].exports = testExpress;
  process.env.ECLINIC_SESSION_SECRET = 'eclinic-automated-tests-only-secret-123456789';
  database = require('../database');
  require('../server');
  // The wrapped Express instance is returned by the factory above.
  app = testExpress._app;
} finally {
  Module._load = oldLoad;
  process.chdir(previousCwd);
}

function httpClient(base) {
  let cookie = '';
  return {
    async request(method, url, data) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      const options = { method, headers, redirect: 'manual' };
      if (data !== undefined) {
        options.body = new URLSearchParams(data);
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const response = await fetch(`${base}${url}`, options);
      if (response.headers.get('set-cookie')) {
        cookie = response.headers.get('set-cookie').split(';')[0];
      }
      return {
        status: response.status,
        location: response.headers.get('location'),
        text: await response.text()
      };
    },
    get(url) { return this.request('GET', url); },
    post(url, data) { return this.request('POST', url, data); },
    async csrf(url) {
      const response = await this.get(url);
      assert.equal(response.status, 200, `GET ${url}`);
      const match = response.text.match(/name="_csrf"\s+value="([a-f0-9]{64})"/);
      assert.ok(match, `${url} should contain a CSRF field`);
      return match[1];
    }
  };
}

test('E-Clinic HTTP, database and security regression suite', async (t) => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const guest = httpClient(base);
  const parent = httpClient(base);
  const worker = httpClient(base);
  const fixtures = { parentId: null, childId: null, vaccineId: null };

  await t.test('SQLite schema enforces relationships', () => {
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(database.pragma('foreign_key_check').length, 0);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
    for (const name of ['users', 'children', 'growth_records', 'vaccines']) assert.ok(tables.includes(name));
  });

  await t.test('guest redirect and CSRF protection', async () => {
    let r = await guest.get('/');
    assert.equal(r.status, 302);
    assert.equal(r.location, '/login');
    assert.equal((await guest.get('/dashboard')).status, 302);
    assert.equal((await guest.get('/manage-vaccines')).status, 302);
    assert.equal((await guest.post('/signup', {role: 'parent'})).status, 403);
    assert.equal((await guest.post('/login', {email: 'a@b.com'})).status, 403);
    const token = await guest.csrf('/signup');
    assert.equal((await guest.post('/signup', { _csrf: '0'.repeat(64), role:'parent' })).status, 403);
    assert.equal((await guest.post('/signup', {_csrf: token, role:'worker'})).status, 403);
  });

  await t.test('parent signup, input validation and duplicate protection', async () => {
    const token = await parent.csrf('/signup');
    const data = { _csrf: token, name:'Parent Test', email:'parent@example.test',password:'secretpass123', nic:'200012345678',role:'parent' };
    assert.equal((await parent.post('/signup', {...data, password:'short'})).status, 400);
    assert.equal((await parent.post('/signup', {...data, nic:'invalid'})).status, 400);
    assert.equal((await parent.post('/signup', data)).status, 302);
    fixtures.parentId = database.prepare('SELECT id FROM users WHERE nic = ?').get(data.nic).id;
    assert.ok(fixtures.parentId);
    assert.equal((await parent.post('/signup', data)).status, 409);
  });

  await t.test('parent login and worker role separation', async () => {
    let token = await parent.csrf('/login');
    assert.equal((await parent.post('/login', {_csrf:token, email:'parent@example.test', password:'wrong'})).status, 200);
    assert.equal((await parent.post('/login', {_csrf:token, email:'parent@example.test', password:'secretpass123'})).status, 302);
    assert.equal((await parent.get('/dashboard')).status, 200);
    assert.equal((await parent.get('/register-child')).status, 403);
    assert.equal((await parent.get('/add-growth')).status, 403);
    assert.equal((await parent.get('/manage-vaccines')).status, 403);
    token = await parent.csrf('/dashboard');
    assert.equal((await parent.post('/register-child/save', {_csrf:token, parentId:fixtures.parentId,childName:'Unauthorized',dob:'2022-05-01',sex:'male'})).status, 403);
  });

  await t.test('health worker existing-account login', async () => {
    const hash = await bcrypt.hash('workerpassword', 4);
    database.prepare('INSERT INTO users (name,email,password,role,slmc_number) VALUES (?,?,?,?,?)').run('Worker Test','worker@example.test',hash,'worker','TEST-123');
    const token = await worker.csrf('/login');
    const r = await worker.post('/login', {_csrf:token,email:'worker@example.test',password:'workerpassword'});
    assert.equal(r.status,302);
    assert.equal((await worker.get('/dashboard')).status,200);
    assert.equal((await worker.get('/register-child')).status,200);
    assert.equal((await worker.get('/add-growth')).status,200);
    assert.equal((await worker.get('/manage-vaccines')).status,200);
  });

  await t.test('child registration and future-date rejection', async () => {
    const token = await worker.csrf('/register-child');
    const baseData = {_csrf:token,parentId:String(fixtures.parentId),childName:'Demo Child',sex:'male'};
    const before = database.prepare('SELECT COUNT(*) n FROM children').get().n;
    assert.equal((await worker.post('/register-child/save', {...baseData,dob:'2030-01-01'})).status,400);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM children').get().n, before);
    const r = await worker.post('/register-child/save', {...baseData,dob:'2023-05-12'});
    assert.equal(r.status,200);
    fixtures.childId = database.prepare('SELECT id FROM children WHERE parent_id = ?').get(fixtures.parentId).id;
    assert.ok(fixtures.childId);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM vaccines WHERE child_id = ?').get(fixtures.childId).n, 8);
  });

  await t.test('growth record validation and persistence', async () => {
    const token = await worker.csrf('/add-growth');
    const payload = {_csrf:token,childId:String(fixtures.childId),date:'2025-03-01',weight:'12.5',height:'82'};
    assert.equal((await worker.post('/add-growth/save', {...payload,weight:'-4'})).status,400);
    assert.equal((await worker.post('/add-growth/save', {...payload,date:'2020-01-01'})).status,400);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM growth_records').get().n,0);
    assert.equal((await worker.post('/add-growth/save',payload)).status,200);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM growth_records WHERE child_id=?').get(fixtures.childId).n,1);
    assert.equal((await parent.get('/dashboard')).status,200);
  });

  await t.test('custom vaccine CRUD, association protection and reactions', async () => {
    const token = await worker.csrf('/manage-vaccines');
    const childId = String(fixtures.childId);
    assert.equal((await worker.post('/manage-vaccines/add-custom', {_csrf:token,childId,vaccineName:'Test Custom',dueDate:'2027-05-01'})).status,200);
    const v = database.prepare("SELECT * FROM vaccines WHERE child_id=? AND is_custom=1").get(fixtures.childId);
    assert.ok(v);
    fixtures.vaccineId = v.id;
    assert.equal((await worker.post('/manage-vaccines/edit-custom', {_csrf:token,childId,vaccineId:String(v.id),vaccineName:'Updated Custom',dueDate:'2027-06-01'})).status,200);
    assert.equal(database.prepare('SELECT vaccine_name FROM vaccines WHERE id=?').get(v.id).vaccine_name,'Updated Custom');
    assert.equal((await worker.post('/manage-vaccines/complete', {_csrf:token,childId:'99999',vaccineId:String(v.id)})).status,404);
    assert.equal((await worker.post('/manage-vaccines/complete', {_csrf:token,childId,vaccineId:String(v.id)})).status,200);
    assert.equal((await worker.post('/manage-vaccines/complete', {_csrf:token,childId,vaccineId:String(v.id)})).status,400);
    assert.equal((await worker.post('/manage-vaccines/delete-custom', {_csrf:token,childId,vaccineId:String(v.id)})).status,404);
    assert.equal((await worker.post('/manage-vaccines/report-reaction', {_csrf:token,childId,vaccineId:String(v.id),sideEffects:'Test reaction',severity:'unknown'})).status,400);
    assert.equal((await worker.post('/manage-vaccines/report-reaction', {_csrf:token,childId,vaccineId:String(v.id),sideEffects:'Test reaction',severity:'mild'})).status,200);
    assert.equal(database.prepare('SELECT side_effect_severity FROM vaccines WHERE id=?').get(v.id).side_effect_severity,'mild');
    assert.equal((await worker.post('/manage-vaccines/add-custom', {_csrf:token,childId,vaccineName:'Delete Me',dueDate:'2027-08-01'})).status,200);
    const removable = database.prepare("SELECT id FROM vaccines WHERE child_id=? AND is_custom=1 AND completed=0").get(fixtures.childId).id;
    assert.equal((await worker.post('/manage-vaccines/delete-custom', {_csrf:token,childId,vaccineId:String(removable)})).status,200);
    assert.equal(database.prepare('SELECT id FROM vaccines WHERE id=?').get(removable),undefined);
  });

  await t.test('logout rejects missing token and invalidates session', async () => {
    assert.equal((await worker.post('/logout',{})).status,403);
    const token = await worker.csrf('/dashboard');
    assert.equal((await worker.post('/logout',{_csrf:token})).status,302);
    assert.equal((await worker.get('/dashboard')).status,302);
  });

  await t.test('database relationships still valid after CRUD', () => {
    assert.equal(database.pragma('foreign_key_check').length,0);
  });
});
