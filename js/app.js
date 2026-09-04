import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, getDocs, query, where,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

const STATUSES = [
  { key: "rfq", label: "RFQ" },
  { key: "quoted", label: "Quoted" },
  { key: "won", label: "Won" },
  { key: "material_ordered", label: "Material Ordered" },
  { key: "po_received", label: "PO Received" },
  { key: "queued", label: "Queued" },
  { key: "in_progress", label: "In Progress" },
  { key: "deburr_pack", label: "Deburr / Pack" },
  { key: "shipped", label: "Shipped" },
  { key: "invoiced", label: "Invoiced" },
  { key: "lost", label: "Lost" },
];
const statusLabel = (key) => STATUSES.find((s) => s.key === key)?.label || key;

let customers = [];
let customersById = {};
let jobs = [];
let currentJobId = null;
let currentJobData = null; // local cache of the open job, kept in sync via onSnapshot
let unsubJobs = null;
let unsubCustomers = null;
let unsubJobDetail = null;

// ---------- Auth ----------

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  $("#login-error").classList.add("hidden");
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    $("#login-error").textContent = err.message;
    $("#login-error").classList.remove("hidden");
  }
});

$("#btn-logout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    $("#view-login").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");
    startListeners();
    showView("board");
  } else {
    $("#app-shell").classList.add("hidden");
    $("#view-login").classList.remove("hidden");
    if (unsubJobs) unsubJobs();
    if (unsubCustomers) unsubCustomers();
    if (unsubJobDetail) unsubJobDetail();
  }
});

// ---------- Nav / view switching ----------

function showView(name) {
  $all("#app-main > .view").forEach((v) => v.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $all(".nav-btn[data-view]").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name)
  );
  if (name !== "job-detail" && unsubJobDetail) {
    unsubJobDetail();
    unsubJobDetail = null;
  }
}

$all(".nav-btn[data-view]").forEach((btn) =>
  btn.addEventListener("click", () => showView(btn.dataset.view))
);

$("#btn-new-job").addEventListener("click", () => {
  populateCustomerSelect();
  $("#new-job-form").reset();
  showView("new-job");
});

$("#btn-back-to-board").addEventListener("click", () => showView("board"));
$("#btn-print-job").addEventListener("click", () => window.print());

// ---------- Customers ----------

function startListeners() {
  unsubCustomers = onSnapshot(collection(db, "customers"), (snap) => {
    customers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    customers.sort((a, b) => a.customerNumber.localeCompare(b.customerNumber, undefined, { numeric: true }));
    customersById = Object.fromEntries(customers.map((c) => [c.id, c]));
    renderCustomers();
    populateCustomerSelect();
    renderBoard();
  });

  unsubJobs = onSnapshot(collection(db, "jobs"), (snap) => {
    jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderBoard();
  });
}

function renderCustomers() {
  $("#customers-tbody").innerHTML = customers
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.customerNumber)}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.contact || "")}</td></tr>`
    )
    .join("");
}

function populateCustomerSelect() {
  $("#job-customer").innerHTML = customers
    .map((c) => `<option value="${c.id}">${escapeHtml(c.customerNumber)} — ${escapeHtml(c.name)}</option>`)
    .join("");
}

$("#customer-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addDoc(collection(db, "customers"), {
    customerNumber: $("#cust-number").value.trim(),
    name: $("#cust-name").value.trim(),
    contact: $("#cust-contact").value.trim(),
    createdAt: serverTimestamp(),
  });
  $("#customer-form").reset();
});

// ---------- Board ----------

$("#toggle-lost").addEventListener("change", renderBoard);

function renderBoard() {
  const showLost = $("#toggle-lost").checked;
  const visibleStatuses = STATUSES.filter((s) => s.key !== "lost" || showLost);

  $("#board-columns").innerHTML = visibleStatuses
    .map((s) => {
      const colJobs = jobs
        .filter((j) => j.status === s.key)
        .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
      const cards = colJobs
        .map((j) => {
          const custName = customersById[j.customerId]?.name || "?";
          return `
            <div class="job-card" data-id="${j.id}">
              <div class="jc-number">${escapeHtml(j.jobNumber)}</div>
              <div class="jc-desc">${escapeHtml(custName)} — ${escapeHtml(j.description || "")}</div>
              ${j.dueDate ? `<div class="jc-due">Due ${escapeHtml(j.dueDate)}</div>` : ""}
            </div>`;
        })
        .join("");
      return `<div class="board-column"><h3>${s.label} (${colJobs.length})</h3>${cards}</div>`;
    })
    .join("");

  $all(".job-card").forEach((card) =>
    card.addEventListener("click", () => openJobDetail(card.dataset.id))
  );
}

// ---------- New job ----------

$("#new-job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const customerId = $("#job-customer").value;
  const customer = customersById[customerId];
  if (!customer) return;

  const existing = await getDocs(query(collection(db, "jobs"), where("customerId", "==", customerId)));
  const maxSeq = existing.docs.reduce((max, d) => Math.max(max, d.data().sequenceForCustomer || 0), 0);
  const sequenceForCustomer = maxSeq + 1;
  const jobNumber = `${customer.customerNumber}-${String(sequenceForCustomer).padStart(3, "0")}`;

  const docRef = await addDoc(collection(db, "jobs"), {
    jobNumber,
    customerId,
    customerNumber: customer.customerNumber,
    sequenceForCustomer,
    description: $("#job-description").value.trim(),
    partNumber: $("#job-part-number").value.trim(),
    qty: Number($("#job-qty").value) || 1,
    dueDate: $("#job-due-date").value || "",
    status: "rfq",
    quote: { rfqDate: "", quotedPrice: "", wonDate: "" },
    material: { spec: "", size: "", supplier: "", poRef: "", orderedDate: "", receivedDate: "" },
    operations: [],
    timeLog: [],
    referenceClass: "",
    notes: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  openJobDetail(docRef.id);
});

// ---------- Job detail / traveler ----------

function openJobDetail(id) {
  currentJobId = id;
  showView("job-detail");
  if (unsubJobDetail) unsubJobDetail();
  unsubJobDetail = onSnapshot(doc(db, "jobs", id), (snap) => {
    if (!snap.exists()) return;
    renderJobDetail({ id: snap.id, ...snap.data() });
  });
}

function renderJobDetail(job) {
  currentJobData = job;
  $("#jd-job-number").textContent = job.jobNumber;
  $("#jd-status-badge").textContent = statusLabel(job.status);
  $("#jd-customer-name").textContent = customersById[job.customerId]
    ? `${customersById[job.customerId].customerNumber} — ${customersById[job.customerId].name}`
    : "";

  if (!$("#jd-status").dataset.filled) {
    $("#jd-status").innerHTML = STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join("");
    $("#jd-status").dataset.filled = "1";
  }
  $("#jd-status").value = job.status;
  $("#jd-description").value = job.description || "";
  $("#jd-part-number").value = job.partNumber || "";
  $("#jd-qty").value = job.qty || 1;
  $("#jd-due-date").value = job.dueDate || "";
  $("#jd-reference-class").value = job.referenceClass || "";

  const q = job.quote || {};
  $("#jd-rfq-date").value = q.rfqDate || "";
  $("#jd-quoted-price").value = q.quotedPrice || "";
  $("#jd-won-date").value = q.wonDate || "";

  const m = job.material || {};
  $("#jd-mat-spec").value = m.spec || "";
  $("#jd-mat-size").value = m.size || "";
  $("#jd-mat-supplier").value = m.supplier || "";
  $("#jd-mat-po").value = m.poRef || "";
  $("#jd-mat-ordered").value = m.orderedDate || "";
  $("#jd-mat-received").value = m.receivedDate || "";

  $("#jd-notes").value = job.notes || "";

  renderOperations(job.operations || []);
  renderTimeLog(job.timeLog || []);
}

function jobRef() {
  return doc(db, "jobs", currentJobId);
}

function saveField(field, value) {
  updateDoc(jobRef(), { [field]: value, updatedAt: serverTimestamp() });
}

$("#jd-status").addEventListener("change", (e) => saveField("status", e.target.value));
$("#jd-description").addEventListener("change", (e) => saveField("description", e.target.value));
$("#jd-part-number").addEventListener("change", (e) => saveField("partNumber", e.target.value));
$("#jd-qty").addEventListener("change", (e) => saveField("qty", Number(e.target.value) || 1));
$("#jd-due-date").addEventListener("change", (e) => saveField("dueDate", e.target.value));
$("#jd-reference-class").addEventListener("change", (e) => saveField("referenceClass", e.target.value));
$("#jd-notes").addEventListener("change", (e) => saveField("notes", e.target.value));

function saveQuoteField(key, value) {
  const current = { ...(currentJobData?.quote || {}) };
  current[key] = value;
  saveField("quote", current);
}
["jd-rfq-date", "jd-quoted-price", "jd-won-date"].forEach((id) => {
  const key = { "jd-rfq-date": "rfqDate", "jd-quoted-price": "quotedPrice", "jd-won-date": "wonDate" }[id];
  $(`#${id}`).addEventListener("change", (e) => saveQuoteField(key, e.target.value));
});

function saveMaterialField(key, value) {
  const current = { ...(currentJobData?.material || {}) };
  current[key] = value;
  saveField("material", current);
}
const matFieldMap = {
  "jd-mat-spec": "spec", "jd-mat-size": "size", "jd-mat-supplier": "supplier",
  "jd-mat-po": "poRef", "jd-mat-ordered": "orderedDate", "jd-mat-received": "receivedDate",
};
Object.keys(matFieldMap).forEach((id) => {
  $(`#${id}`).addEventListener("change", (e) => saveMaterialField(matFieldMap[id], e.target.value));
});

// ---------- Operations ----------

function renderOperations(operations) {
  $("#operations-list").innerHTML = operations
    .map(
      (op, i) => `
      <div class="operation-row ${op.done ? "done" : ""}" data-index="${i}">
        <input type="checkbox" class="op-done" ${op.done ? "checked" : ""} />
        <span class="op-name">${escapeHtml(op.name)}</span>
        <span class="op-notes">${escapeHtml(op.notes || "")}</span>
        <button type="button" class="op-delete no-print">Remove</button>
      </div>`
    )
    .join("");

  $all(".op-done").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      const i = Number(e.target.closest(".operation-row").dataset.index);
      const ops = [...(currentJobData?.operations || [])];
      ops[i] = { ...ops[i], done: e.target.checked };
      saveField("operations", ops);
    })
  );
  $all(".op-delete").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const i = Number(e.target.closest(".operation-row").dataset.index);
      const ops = [...(currentJobData?.operations || [])];
      ops.splice(i, 1);
      saveField("operations", ops);
    })
  );
}

$("#operation-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#op-name").value.trim();
  const notes = $("#op-notes").value.trim();
  if (!name) return;
  const ops = [...(currentJobData?.operations || []), { name, notes, done: false }];
  saveField("operations", ops);
  $("#operation-form").reset();
});

// ---------- Time log ----------

function renderTimeLog(timeLog) {
  $("#time-log-tbody").innerHTML = timeLog
    .map(
      (t, i) => `
      <tr data-index="${i}">
        <td>${t.date || ""}</td>
        <td>${escapeHtml(t.operation || "")}</td>
        <td>${t.hours}</td>
        <td>${escapeHtml(t.note || "")}</td>
        <td class="no-print"><button type="button" class="tl-delete">Remove</button></td>
      </tr>`
    )
    .join("");

  const total = timeLog.reduce((sum, t) => sum + (Number(t.hours) || 0), 0);
  $("#time-log-total").textContent = total ? `— ${total.toFixed(1)} hrs total` : "";

  $all(".tl-delete").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const i = Number(e.target.closest("tr").dataset.index);
      const log = [...(currentJobData?.timeLog || [])];
      log.splice(i, 1);
      saveField("timeLog", log);
    })
  );
}

$("#time-log-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const date = $("#tl-date").value;
  const operation = $("#tl-operation").value.trim();
  const hours = Number($("#tl-hours").value);
  const note = $("#tl-note").value.trim();
  if (!date || !hours) return;
  const log = [...(currentJobData?.timeLog || []), { date, operation, hours, note }];
  saveField("timeLog", log);
  $("#time-log-form").reset();
  $("#tl-date").value = new Date().toISOString().slice(0, 10);
});

// default today's date in the time log form when the view opens
document.addEventListener("DOMContentLoaded", () => {
  $("#tl-date").value = new Date().toISOString().slice(0, 10);
});

// ---------- utils ----------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
