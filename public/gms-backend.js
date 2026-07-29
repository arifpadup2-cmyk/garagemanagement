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

  function authToken() {
    try {
      var raw = localStorage.getItem('gms_session') || sessionStorage.getItem('gms_session') ||
                localStorage.getItem('gms_tech_session') || sessionStorage.getItem('gms_tech_session');
      if (!raw) return null;
      return (JSON.parse(raw) || {}).token || null;
    } catch (e) { return null; }
  }
  function onUnauthorized() {
    // Token missing/expired: clear stored sessions and return to the login screen.
    try {
      localStorage.removeItem('gms_session'); sessionStorage.removeItem('gms_session');
      localStorage.removeItem('gms_tech_session'); sessionStorage.removeItem('gms_tech_session');
    } catch (e) {}
    if (!window._gmsAuthReloading) { window._gmsAuthReloading = true; location.reload(); }
  }

  function req(method, url, body) {
    var opts = { method: method, headers: {} };
    var tok = authToken();
    if (tok) opts.headers['Authorization'] = 'Bearer ' + tok;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(API + url, opts).then(function (r) {
      if (r.status === 401 && url !== '/login' && url !== '/tech-login') { onUnauthorized(); throw new Error('Session expired — please sign in again.'); }
      if (!r.ok) return r.text().then(function (t) {
        var msg = method + ' ' + url + ' -> ' + r.status + ' ' + t;
        try { var j = JSON.parse(t); if (j && j.error) msg = j.error; } catch (e) {}
        var err = new Error(msg); err.status = r.status; throw err;
      });
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

  // Per-collection cache of the last full fetch. Single-doc mutations patch it
  // in place and re-emit — no full re-download per write (the old O(collection)
  // write amplification). refreshColl is still used for a true resync and for
  // multi-collection atomic operations.
  var collCache = {};
  function emitColl(name) {
    var ls = collListeners[name]; if (!ls || !ls.length) return;
    var arr = collCache[name] || [];
    ls.forEach(function (l) { try { l.cb(querySnap(applyOrder(arr, l.order))); } catch (e) { console.error(e); } });
  }
  function refreshColl(name) {
    var ls = collListeners[name];
    if (!ls || !ls.length) return Promise.resolve();
    return fetchList(name).then(function (arr) {
      collCache[name] = arr;
      emitColl(name);
    }).catch(function (e) { ls.forEach(function (l) { l.err && l.err(e); }); });
  }
  // Patch the cached collection from a mutation response (or remove by id) and
  // re-emit, avoiding a full GET. Falls back to a full refresh if uncached, and
  // never used for 'technicians' (list GET redacts the PIN) or 'settings'.
  function patchColl(name, doc, removedId) {
    if (name === 'technicians' || name === 'settings' || !collCache[name]) return refreshColl(name);
    var arr = collCache[name].slice();
    if (removedId) {
      arr = arr.filter(function (d) { return d.id !== removedId; });
    } else if (doc && doc.id) {
      var found = false;
      for (var i = 0; i < arr.length; i++) { if (arr[i].id === doc.id) { arr[i] = doc; found = true; break; } }
      if (!found) arr.unshift(doc);
    }
    collCache[name] = arr;
    emitColl(name);
    return Promise.resolve();
  }
  function refreshDoc(name, id) {
    var key = name + '/' + id, ls = docListeners[key];
    if (!ls || !ls.length) return Promise.resolve();
    var url = (name === 'settings') ? '/settings/company' : '/' + name + '/' + id;
    return req('GET', url).then(function (d) {
      ls.forEach(function (l) { try { l.cb(docSnap(d)); } catch (e) { console.error(e); } });
    }).catch(function (e) {
      // A transport/server failure is NOT "document does not exist" — only a
      // real 404 reports a missing doc; anything else surfaces as an error.
      if (e && e.status === 404) { ls.forEach(function (l) { try { l.cb(docSnap(null)); } catch (e2) {} }); return; }
      ls.forEach(function (l) { if (l.err) { try { l.err(e); } catch (e2) {} } else { console.error('refreshDoc(' + key + '):', e); } });
    });
  }

  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10))); }

  // ---- DocRef ----
  function DocRef(name, id) { this._name = name; this._id = id || uid(); }
  DocRef.prototype.get = function () {
    var url = (this._name === 'settings') ? '/settings/company' : '/' + this._name + '/' + this._id;
    return req('GET', url).then(docSnap, function (e) {
      if (e && e.status === 404) return docSnap(null);
      throw e; // network/server failures must not masquerade as "missing doc"
    });
  };
  DocRef.prototype.update = function (data) {
    var self = this;
    var url = (this._name === 'settings') ? '/settings/company' : '/' + this._name + '/' + this._id;
    return req('PUT', url, data).then(function (r) { patchColl(self._name, r); refreshDoc(self._name, self._id); return r; });
  };
  DocRef.prototype.set = function (data, opts) {
    var self = this;
    if (this._name === 'settings') { // always merge semantics on server
      return req('PUT', '/settings/company', data).then(function (r) { refreshDoc('settings', 'company'); refreshColl('settings'); return r; });
    }
    var body = {}; for (var k in data) body[k] = data[k]; body.id = this._id;
    return req('POST', '/' + this._name, body).then(function (r) { patchColl(self._name, r); refreshDoc(self._name, self._id); return r; });
  };
  DocRef.prototype.delete = function () {
    var self = this;
    return req('DELETE', '/' + this._name + '/' + this._id).then(function (r) { patchColl(self._name, null, self._id); return r; });
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
    return req('POST', '/' + this._name, data).then(function (r) {
      patchColl(self._name, r); // patch cache from the created doc — no full GET
      var ref = new DocRef(self._name, r.id);
      ref.id = r.id; // callers read ref.id after add()
      // Expose the server-authoritative document (incl. assigned seq) so the
      // UI never displays/prints a locally guessed document number.
      ref.serverDoc = r;
      if (r && r.seq != null) ref.seq = r.seq;
      return ref;
    });
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

  // ---- GMS domain API (atomic server-side operations) ----
  window.gmsApi = {
    // Record one or more payments on an invoice atomically (row-locked append,
    // balance-capped, cash-book rows inserted in the same DB transaction).
    pay: function (invoiceId, body) {
      return req('POST', '/invoices/' + invoiceId + '/pay', body).then(function (r) {
        refreshColl('invoices'); refreshColl('transactions');
        return r;
      });
    },
    // Atomic stock adjustment (blocks negative stock, appends movement safely).
    adjustStock: function (partId, body) {
      return req('POST', '/parts/' + partId + '/adjust', body).then(function (r) {
        refreshColl('parts'); refreshColl('stockMovements');
        return r;
      });
    },
    // Counter-sale: create invoice + cash-book entry in one server transaction.
    quickInvoice: function (body) {
      return req('POST', '/invoices/quick', body).then(function (r) {
        refreshColl('invoices'); refreshColl('transactions'); refreshColl('parts'); refreshColl('stockMovements');
        return r;
      });
    },
    // Receive a purchase order (atomic: stocks in every line, updates cost).
    // Superseded by goodsReceipt() — kept so an older cached client keeps working.
    receivePO: function (poId) {
      return req('POST', '/purchaseOrders/' + poId + '/receive', {}).then(function (r) {
        refreshColl('purchaseOrders'); refreshColl('parts');
        return r;
      });
    },
    // Post a goods receipt: partial quantities, batch/serial/expiry capture,
    // stock in at weighted-average cost and the PO's own status, all atomic.
    goodsReceipt: function (body) {
      return req('POST', '/goodsReceipts', body).then(function (r) {
        refreshColl('goodsReceipts'); refreshColl('purchaseOrders');
        refreshColl('parts'); refreshColl('stockLots'); refreshColl('stockMovements');
        return r;
      });
    },
    // Move a purchase order through its lifecycle (submit/approve/cancel/close).
    poStatus: function (poId, status, reason) {
      return req('POST', '/purchaseOrders/' + poId + '/status', { status: status, reason: reason || '' }).then(function (r) {
        refreshColl('purchaseOrders');
        return r;
      });
    },
    // Post a supplier invoice: allocates landed cost onto item cost and turns
    // the draft into a real payable.
    postPurchaseInvoice: function (piId) {
      return req('POST', '/purchaseInvoices/' + piId + '/post', {}).then(function (r) {
        refreshColl('purchaseInvoices'); refreshColl('parts');
        return r;
      });
    },
    // Pay a supplier invoice (row-locked, overpay rejected, cash-book in the
    // same transaction).
    payPurchaseInvoice: function (piId, body) {
      return req('POST', '/purchaseInvoices/' + piId + '/pay', body).then(function (r) {
        refreshColl('purchaseInvoices'); refreshColl('transactions');
        return r;
      });
    },
    // Return goods to a supplier (atomic: stock out of the specific lots).
    purchaseReturn: function (body) {
      return req('POST', '/purchaseReturns', body).then(function (r) {
        refreshColl('purchaseReturns'); refreshColl('parts'); refreshColl('stockLots'); refreshColl('stockMovements');
        return r;
      });
    },
    // Issue a part from stock to a job card (atomic: deducts stock + adds line).
    issuePart: function (jcId, partId, qty, unitPrice) {
      return req('POST', '/jobCards/' + jcId + '/parts', { partId: partId, qty: qty, unitPrice: unitPrice }).then(function (r) {
        refreshColl('jobCards'); refreshColl('parts'); refreshColl('stockMovements'); refreshColl('stockLots');
        return r;
      });
    },
    // Return an issued part (atomic: restores stock + removes line).
    returnPart: function (jcId, lineId) {
      return req('POST', '/jobCards/' + jcId + '/parts/return', { lineId: lineId }).then(function (r) {
        refreshColl('jobCards'); refreshColl('parts'); refreshColl('stockMovements'); refreshColl('stockLots');
        return r;
      });
    },
    // Atomic update of a single job-card work item (technician clock in/out).
    updateWork: function (jcId, workId, patch, recomputeStatus) {
      return req('POST', '/jobCards/' + jcId + '/work', { workId: workId, patch: patch, recomputeStatus: !!recomputeStatus }).then(function (r) {
        refreshColl('jobCards');
        return r;
      });
    },
    // ---- Inventory & warehouse (Phase 3) ----
    // Move stock between locations; both legs land in the movement ledger.
    stockTransfer: function (body) {
      return req('POST', '/stockTransfers', body).then(function (r) {
        refreshColl('stockTransfers'); refreshColl('stockMovements'); refreshColl('stockLots');
        return r;
      });
    },
    // Post (or draft) a physical count; posting corrects stock in one go.
    stockCount: function (body) {
      return req('POST', '/stockCounts', body).then(function (r) {
        refreshColl('stockCounts'); refreshColl('parts'); refreshColl('stockMovements');
        return r;
      });
    },
    // Promise stock to a job card without moving it.
    reserveStock: function (body) {
      return req('POST', '/reservations/reserve', body).then(function (r) {
        refreshColl('reservations');
        return r;
      });
    },
    releaseReservation: function (id, status) {
      return req('POST', '/reservations/' + id + '/release', { status: status || 'released' }).then(function (r) {
        refreshColl('reservations');
        return r;
      });
    },
    issueTool: function (toolId, body) {
      return req('POST', '/tools/' + toolId + '/issue', body).then(function (r) {
        refreshColl('tools'); refreshColl('toolIssues');
        return r;
      });
    },
    returnTool: function (issueId, body) {
      return req('POST', '/toolIssues/' + issueId + '/return', body).then(function (r) {
        refreshColl('tools'); refreshColl('toolIssues');
        return r;
      });
    },
    // ---- Financial statements from the ledger (Phase 7) ----
    trialBalance: function (asAt, from) {
      return req('GET', '/reports/trial-balance?asAt=' + encodeURIComponent(asAt || '') + '&from=' + encodeURIComponent(from || ''));
    },
    profitAndLoss: function (from, to) {
      return req('GET', '/reports/pl?from=' + encodeURIComponent(from || '') + '&to=' + encodeURIComponent(to || ''));
    },
    balanceSheet: function (asAt) { return req('GET', '/reports/balance-sheet?asAt=' + encodeURIComponent(asAt || '')); },
    generalLedger: function (accountId, from, to) {
      return req('GET', '/reports/ledger?accountId=' + encodeURIComponent(accountId) +
        '&from=' + encodeURIComponent(from || '') + '&to=' + encodeURIComponent(to || ''));
    },
    // ---- Operational reports, aggregated in Postgres (Phase 8) ----
    inventoryValuation: function () { return req('GET', '/reports/inventory-valuation'); },
    salesSummary: function (from, to) {
      return req('GET', '/reports/sales-summary?from=' + encodeURIComponent(from || '') + '&to=' + encodeURIComponent(to || ''));
    },
    workshopReport: function (from, to) {
      return req('GET', '/reports/workshop?from=' + encodeURIComponent(from || '') + '&to=' + encodeURIComponent(to || ''));
    },
    // ---- Sales corrections (Phase 6) ----
    // A credit note reverses value on a posted invoice, optionally restocks the
    // goods and refunds cash — all in one server transaction.
    creditNote: function (body) {
      return req('POST', '/creditNotes', body).then(function (r) {
        refreshColl('creditNotes'); refreshColl('invoices');
        refreshColl('parts'); refreshColl('stockMovements'); refreshColl('transactions');
        return r;
      });
    },
    cancelInvoice: function (invId, reason) {
      return req('POST', '/invoices/' + invId + '/cancel', { reason: reason || '' }).then(function (r) {
        refreshColl('invoices'); return r;
      });
    },
    // ---- Workshop operations (Phase 5) ----
    assignBay: function (jcId, bayId) {
      return req('POST', '/jobCards/' + jcId + '/bay', { bayId: bayId || '' }).then(function (r) {
        refreshColl('jobCards'); return r;
      });
    },
    checkInVehicle: function (jcId, body) {
      return req('POST', '/jobCards/' + jcId + '/checkin', body).then(function (r) {
        refreshColl('jobCards'); return r;
      });
    },
    qualityCheck: function (jcId, body) {
      return req('POST', '/jobCards/' + jcId + '/qc', body).then(function (r) {
        refreshColl('jobCards'); return r;
      });
    },
    deliverVehicle: function (jcId, body) {
      return req('POST', '/jobCards/' + jcId + '/deliver', body).then(function (r) {
        refreshColl('jobCards'); return r;
      });
    },
    // What a customer owes against what they are allowed to owe.
    creditStatus: function (customerId) { return req('GET', '/customers/' + customerId + '/credit'); },
    // What to buy: computed server-side so every device gets the same answer.
    reorderReport: function () { return req('GET', '/reports/reorder'); },
    availability: function (partId) { return req('GET', '/parts/' + partId + '/availability'); },
    // Revoke every outstanding token (sign out all devices).
    logoutAll: function () { return req('POST', '/logout-all', {}); },
    // Recent audit-log rows (admin only).
    auditLog: function (limit) { return req('GET', '/audit-log?limit=' + (limit || 200)); },
    // Full data backup as a downloadable JSON blob (admin only).
    exportBackup: function () {
      var tok = authToken();
      return fetch(API + '/export', { headers: tok ? { 'Authorization': 'Bearer ' + tok } : {} }).then(function (r) {
        if (!r.ok) throw new Error('Export failed (' + r.status + ')');
        return r.blob();
      });
    }
  };
})();
