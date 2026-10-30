/* firebase-sync.js — بيربط صفحات الحضانة بـ Firebase Firestore
   الفكرة: localStorage يفضل شغال زي ما هو (كاش)، وكل تغيير بيتبعت لـ Firestore،
   وأول ما الصفحة تفتح بتسحب آخر نسخة من Firestore قبل ما كود الصفحة يشتغل. */
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyATq7BXTJEcq4HXdHsEGAYrES-O5AHRiuc",
    authDomain: "mero-67ecf.firebaseapp.com",
    databaseURL: "https://mero-67ecf-default-rtdb.firebaseio.com",
    projectId: "mero-67ecf",
    storageBucket: "mero-67ecf.firebasestorage.app",
    messagingSenderId: "741938477701",
    appId: "1:741938477701:web:48625e0aa6af9fdf0dc7ec"
  };
  // ===== إعدادات Cloudinary (غيّر القيمتين دول) =====
  const CLOUD_NAME = "deefnnqdm";
  const UPLOAD_PRESET = "hdanaa";
  const V = "10.12.2";
  // مفاتيح البيانات المتزامنة (جلسة ولي الأمر nursery_parent_session_v1 بتفضل على الجهاز بس)
  const KEYS = ["nursery_data_v1", "nursery_students_v1", "nursery_attendance_v1", "nursery_notes_v1"];
  const CHUNK = 400000;           // حجم الجزء الواحد (حد المستند في Firestore 1MB)
  const FCHUNK = 600000;          // حجم جزء الملفات (base64)
  const COL = "nursery_kv", FCOL = "nursery_files";

  let db, fs, ready, status = "loading", initErr = "";
  const rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
  const timers = {}, lastPushed = {};

  function banner(msg, action) {
    let b = document.getElementById("fb-banner");
    if (!b) {
      b = document.createElement("div"); b.id = "fb-banner";
      b.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:99999;background:#1e1b4b;color:#fff;padding:10px 16px;border-radius:12px;font:600 14px Cairo,Tahoma,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center;direction:rtl";
      document.body.appendChild(b);
    }
    b.textContent = msg + " ";
    if (action) { const a = document.createElement("button"); a.textContent = action.t; a.onclick = action.f;
      a.style.cssText = "background:#a855f7;color:#fff;border:0;border-radius:8px;padding:4px 12px;font:inherit;cursor:pointer"; b.appendChild(a); }
  }

  async function init() {
    const app = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
    fs = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
    const a = app.initializeApp(firebaseConfig);
    db = fs.getFirestore(a);
    // سحب آخر نسخة لكل مفتاح قبل تشغيل الصفحة
    await Promise.all(KEYS.map(async k => {
      const val = await pull(k);
      if (val === null) {
        // مفيش حاجة على السحابة: لو عندنا داتا محلية نرفعها (ترحيل أول مرة)
        const local = localStorage.getItem(k);
        if (local) await push(k, local);
      } else if (val !== localStorage.getItem(k)) rawSet.call(localStorage, k, val);
      lastPushed[k] = localStorage.getItem(k);
    }));
    status = "online";
    // تحديثات لحظية من الأجهزة التانية
    KEYS.forEach(k => fs.onSnapshot(fs.doc(db, COL, k), async snap => {
      if (snap.metadata.hasPendingWrites || !snap.exists()) return;
      const val = await pull(k);
      if (val !== null && val !== localStorage.getItem(k)) {
        rawSet.call(localStorage, k, val); lastPushed[k] = val;
        banner("في بيانات اتحدّثت من جهاز تاني", { t: "تحديث", f: () => location.reload() });
      }
    }));
  }

  async function pull(k) {
    const m = await fs.getDoc(fs.doc(db, COL, k));
    if (!m.exists()) return null;
    const n = m.data().n || 0; let s = "";
    const parts = await Promise.all(Array.from({ length: n }, (_, i) => fs.getDoc(fs.doc(db, COL, k + "__" + i))));
    parts.forEach(p => { s += p.exists() ? p.data().s : ""; });
    return s;
  }
  async function push(k, str) {
    const n = Math.max(1, Math.ceil(str.length / CHUNK));
    const old = await fs.getDoc(fs.doc(db, COL, k));
    const oldN = old.exists() ? old.data().n || 0 : 0;
    const b = fs.writeBatch(db);
    for (let i = 0; i < n; i++) b.set(fs.doc(db, COL, k + "__" + i), { s: str.slice(i * CHUNK, (i + 1) * CHUNK) });
    for (let i = n; i < oldN; i++) b.delete(fs.doc(db, COL, k + "__" + i));
    b.set(fs.doc(db, COL, k), { n, ts: Date.now() });
    await b.commit();
    lastPushed[k] = str;
  }
  function schedule(k) {
    clearTimeout(timers[k]);
    timers[k] = setTimeout(async () => {
      const cur = localStorage.getItem(k);
      if (cur === null || cur === lastPushed[k]) return;
      try { await ready; await push(k, cur); }
      catch (e) { console.error("sync fail", e); banner("مقدرتش أحفظ على السحابة — اتأكد من النت"); }
    }, 700);
  }
  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (this === localStorage && KEYS.includes(k)) schedule(k);
  };
  Storage.prototype.removeItem = function (k) {
    rawRemove.call(this, k);
    if (this === localStorage && KEYS.includes(k)) schedule(k);
  };

  // ===== الملفات (صور / PDF): IndexedDB كاش + Firestore =====
  const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  const fromB64 = (b64, type) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };
  function idb() { return new Promise((res, rej) => { const r = indexedDB.open("nursery_files", 1); r.onupgradeneeded = () => r.result.createObjectStore("f"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function idbGet(id) { try { const d = await idb(); return await new Promise(res => { const g = d.transaction("f").objectStore("f").get(id); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); }); } catch (e) { return null; } }
  async function idbPut(id, blob) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction("f", "readwrite"); t.objectStore("f").put(blob, id); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  async function idbDel(id) { try { const d = await idb(); return await new Promise(res => { const t = d.transaction("f", "readwrite"); t.objectStore("f").delete(id); t.oncomplete = res; t.onerror = res; }); } catch (e) {} }

  async function cloudUpload(blob, name) {
    if (CLOUD_NAME.startsWith("PUT_")) throw new Error("Cloudinary مش متظبط");
    const fd = new FormData();
    fd.append("file", blob, name || "file");
    fd.append("upload_preset", UPLOAD_PRESET);
    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`, { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok || !j.secure_url) throw new Error((j.error && j.error.message) || "فشل الرفع");
    return j.secure_url;
  }

  window.fbFiles = {
    async put(id, blob) {
      const url = await cloudUpload(blob, id);          // الملف نفسه على Cloudinary
      await idbPut(id, blob);                            // كاش على الجهاز
      await ready;                                       // الرابط بس في Firestore
      await fs.setDoc(fs.doc(db, FCOL, id), { url, type: blob.type || "application/octet-stream", ts: Date.now() });
    },
    async get(id) {
      const local = await idbGet(id); if (local) return local;
      try {
        await ready;
        const m = await fs.getDoc(fs.doc(db, FCOL, id)); if (!m.exists()) return null;
        const d = m.data();
        let blob;
        if (d.url) {                                     // ملفات Cloudinary
          const r = await fetch(d.url); if (!r.ok) return null;
          blob = await r.blob();
          if (d.type && !blob.type) blob = new Blob([blob], { type: d.type });
        } else {                                         // ملفات قديمة متخزنة chunks في Firestore
          const parts = await Promise.all(Array.from({ length: d.n }, (_, i) => fs.getDoc(fs.doc(db, FCOL, id + "__" + i))));
          blob = fromB64(parts.map(p => p.data().s).join(""), d.type);
        }
        idbPut(id, blob).catch(() => {});
        return blob;
      } catch (e) { return null; }
    },
    async del(id) {
      await idbDel(id);
      try {
        await ready;
        const m = await fs.getDoc(fs.doc(db, FCOL, id)); if (!m.exists()) return;
        const n = m.data().n || 0, bt = fs.writeBatch(db);   // الملف على Cloudinary بيتمسح من لوحتهم (الرفع بدون توقيع مبيسمحش بالمسح)
        for (let i = 0; i < n; i++) bt.delete(fs.doc(db, FCOL, id + "__" + i));
        bt.delete(fs.doc(db, FCOL, id)); await bt.commit();
      } catch (e) {}
    }
  };

  // ===== تشغيل كود الصفحة بعد ما الداتا تتسحب =====
  ready = init().catch(e => { console.error("Firebase init failed", e); status = "offline"; initErr = (e && (e.code || e.message)) || String(e); });
  window.fbReady = ready;
  function run() {
    const el = document.querySelector('script[type="text/fb-app"]'); if (!el) return;
    ready.then(() => {
      if (status === "offline") banner("مفيش اتصال بالسحابة (" + initErr + ") — شغال بالداتا المحفوظة على الجهاز");
      const s = document.createElement("script"); s.text = el.text; el.replaceWith(s);
    });
  }
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", run) : run();
})();
