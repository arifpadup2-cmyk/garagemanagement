/*
 * gms-backend.js — drop-in Firebase-compat shim backed by the GMS REST API.
 *
 * Reimplements only the slice of the Firebase v10 compat API that the app uses:
 *   firebase.initializeApp / firestore() / storage()
 *   db.collection(name).orderBy().onSnapshot()/.get()/.add()/.doc(id)
 *   db.collection(name).doc(id).get()/.update()/.set()/.delete()/.onSnapshot()
 *   db.batch().set()/.update()/.delete()/.commit()
 *   storage.ref(path).put()/.getDownloadURL()/.delete()
 *
 * Data lives in PostgreSQL via the REST API. There is no cross-device realtime:
 * onSnapshot fires once on register and again after any local mutation to that
 * collection ("simple refresh"), which preserves the app's reactive rendering.
 */
(function () {
  'use strict';
  var API = (window.GMS_API_BASE || '') + '/api';

  function req(method, url, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(API + url, opts).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(method + ' ' + url + ' -> ' + r.status + ' ' + t); });
      var ct = r.headers.get('content-type') || '';
      return ct.indexOf('application/json') >= 0 ? r.json() : r.text();
    });
  }

  // ---- listener registries ----
  var collListeners = {}; // name -> [ {cb, err, order} ]
  var docListeners = {};  // "name/id" -> [ {cb, err} ]

  function fetchList(name) { return req('GET', '/' + name); }

  function applyOrder(arr, order) {
    if (!order || !order.field) return arr;
    var f = order.field, dir = (order.dir === 'desc') ? -1 : 1;
    return arr.slice().sort(function (a, b) {
      var av = a[f], bv = b[f];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function docSnap(d) {
    if (!d) return { id: null, exists: false, data: function () { return undefined; } };
    var copy = {}; for (var k in d) if (k !== 'id') copy[k] = d[k];
    return { id: d.id, exists: true, data: function () { return copy; } };
  }
  function querySnap(arr) {
    var docs = arr.map(docSnap);
    return {
      docs: docs, size: docs.length, empty: docs.length === 0,
      forEach: function (fn) { docs.forEach(fn); }
    };
  }

  function refreshColl(name) {
    var ls = collListeners[name];
    if (!ls || !ls.length) return Promise.resolve();
    return fetchList(name).then(function (arr) {
      ls.forEach(function (l) { try { l.cb(querySnap(applyOrder(arr, l.order))); } catch (e) { console.error(e); } });
    }).catch(function (e) { ls.forEach(function (l) { l.err && l.err(e); }); });
  }
  function refreshDoc(name, id) {
    var key = name + '/' + id, ls = docListeners[key];
    if (!ls || !ls.length) return Promise.resolve();
    var url = (name === 'settings') ? '/settings/company' : '/' + name + '/' + id;
    return req('GET', url).then(function (d) {
      ls.forEach(function (l) { try { l.cb(docSnap(d)); } catch (e) { console.error(e); } });
    }).catch(function () { ls.forEach(function (l) { try { l.cb(docSnap(null)); } catch (e) {} }); });
  }

  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10))); }

  // ---- DocRef ----
  function DocRef(name, id) { this._name = name; this._id = id || uid(); }
  DocRef.prototype.get = function () {
    var url = (this._name === 'settings') ? '/settings/company' : '/' + this._name + '/' + this._id;
    return req('GET', url).then(docSnap, function () { return docSnap(null); });
  };
  DocRef.prototype.update = function (data) {
    var self = this;
    var url = (this._name === 'settings') ? '/settings/company' : '/' + this._name + '/' + this._id;
    return req('PUT', url, data).then(function (r) { refreshColl(self._name); refreshDoc(self._name, self._id); return r; });
  };
  DocRef.prototype.set = function (data, opts) {
    var self = this;
    if (this._name === 'settings') { // always merge semantics on server
      return req('PUT', '/settings/company', data).then(function (r) { refreshDoc('settings', 'company'); refreshColl('settings'); return r; });
    }
    var body = {}; for (var k in data) body[k] = data[k]; body.id = this._id;
    return req('POST', '/' + this._name, body).then(function (r) { refreshColl(self._name); refreshDoc(self._name, self._id); return r; });
  };
  DocRef.prototype.delete = function () {
    var self = this;
    return req('DELETE', '/' + this._name + '/' + this._id).then(function (r) { refreshColl(self._name); return r; });
  };
  DocRef.prototype.onSnapshot = function (cb, err) {
    var key = this._name + '/' + this._id;
    (docListeners[key] = docListeners[key] || []).push({ cb: cb, err: err });
    refreshDoc(this._name, this._id);
    return function () {}; // unsubscribe (no-op; app never unsubscribes)
  };

  // ---- CollRef / Query ----
  function CollRef(name) { this._name = name; this._order = null; }
  CollRef.prototype.orderBy = function (field, dir) { var c = new CollRef(this._name); c._order = { field: field, dir: dir || 'asc' }; return c; };
  CollRef.prototype.where = function () { return this; }; // not used by the app; passthrough
  CollRef.prototype.doc = function (id) { return new DocRef(this._name, id); };
  CollRef.prototype.add = function (data) {
    var self = this;
    return req('POST', '/' + this._name, data).then(function (r) { refreshColl(self._name); return new DocRef(self._name, r.id); });
  };
  CollRef.prototype.get = function () {
    var self = this;
    return fetchList(this._name).then(function (arr) { return querySnap(applyOrder(arr, self._order)); });
  };
  CollRef.prototype.onSnapshot = function (cb, err) {
    (collListeners[this._name] = collListeners[this._name] || []).push({ cb: cb, err: err, order: this._order });
    refreshColl(this._name);
    return function () {};
  };

  // ---- Batch ----
  function Batch() { this._ops = []; }
  Batch.prototype.set = function (ref, data) { this._ops.push({ t: 'set', ref: ref, data: data }); return this; };
  Batch.prototype.update = function (ref, data) { this._ops.push({ t: 'update', ref: ref, data: data }); return this; };
  Batch.prototype.delete = function (ref) { this._ops.push({ t: 'delete', ref: ref }); return this; };
  Batch.prototype.commit = function () {
    var affected = {};
    var ps = this._ops.map(function (op) {
      affected[op.ref._name] = true;
      if (op.t === 'set') { var b = {}; for (var k in op.data) b[k] = op.data[k]; b.id = op.ref._id; return req('POST', '/' + op.ref._name, b); }
      if (op.t === 'update') return req('PUT', '/' + op.ref._name + '/' + op.ref._id, op.data);
      return req('DELETE', '/' + op.ref._name + '/' + op.ref._id);
    });
    return Promise.all(ps).then(function (r) { Object.keys(affected).forEach(refreshColl); return r; });
  };

  // ---- Firestore facade ----
  function Firestore() {}
  Firestore.prototype.collection = function (name) { return new CollRef(name); };
  Firestore.prototype.batch = function () { return new Batch(); };
  Firestore.prototype.doc = function (pathStr) { var p = pathStr.split('/'); return new DocRef(p[0], p[1]); };

  // ---- Storage facade (photos -> Postgres bytea) ----
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = fr.result; resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  function StorageRef(path) { this._path = path; }
  StorageRef.prototype.put = function (blob, meta) {
    var self = this;
    var mime = (meta && meta.contentType) || (blob && blob.type) || 'image/jpeg';
    var p = blobToBase64(blob).then(function (b64) { return req('POST', '/image', { path: self._path, mime: mime, base64: b64 }); })
      .then(function () { return { ref: self, metadata: { fullPath: self._path } }; });
    // return a thenable UploadTask-like object
    return { then: p.then.bind(p), catch: p.catch.bind(p), ref: self };
  };
  StorageRef.prototype.getDownloadURL = function () { return Promise.resolve(API + '/image?p=' + encodeURIComponent(this._path)); };
  StorageRef.prototype.delete = function () { return req('DELETE', '/image?p=' + encodeURIComponent(this._path)); };
  StorageRef.prototype.child = function (sub) { return new StorageRef(this._path.replace(/\/$/, '') + '/' + sub); };
  function Storage() {}
  Storage.prototype.ref = function (path) { return new StorageRef(path || ''); };
  Storage.prototype.refFromURL = function (url) {
    var m = /[?&]p=([^&]+)/.exec(url); return new StorageRef(m ? decodeURIComponent(m[1]) : url);
  };

  // ---- global firebase facade ----
  var _fs = new Firestore();
  var _st = new Storage();
  function firestore() { return _fs; }
  firestore.FieldValue = {
    serverTimestamp: function () { return Date.now(); },
    delete: function () { return undefined; },
    increment: function (n) { return n; }
  };
  window.firebase = {
    initializeApp: function () { return { name: '[DEFAULT]' }; },
    firestore: firestore,
    storage: function () { return _st; }
  };
})();
