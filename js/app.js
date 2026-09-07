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

let errorTimer = null;
function showError(err) {
  console.error(err);
  const banner = $("#error-banner");
  banner.textContent = err?.message || String(err);
  banner.classList.remove("hidden");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => banner.classList.add("hidden"), 8000);
}

// Each stage is a milestone: a checklist that should be complete before moving
// on, plus whatever record-keeping fields belong to that point in the job.
const STAGE_DEFS = [
  {
    key: "rfq",
    label: "RFQ",
    checklist: [
      { key: "drawing_received", label: "Drawing received" },
      { key: "model_received", label: "3D model received" },
      { key: "customer_supplied_material", label: "Customer supplying material" },
      { key: "shop_supplied_material", label: "BPE supplying material" },
    ],
    fields: [
      { key: "rfqDate", label: "RFQ date", type: "date" },
      { key: "expectedCompletionDate", label: "Expected completion date", type: "date", required: true },
    ],
  },
  {
    key: "quoted",
    label: "Quoted",
    checklist: [{ key: "quote_sent", label: "Quote sent to customer" }],
    fields: [{ key: "quotedPrice", label: "Quoted price", type: "number" }],
  },
  {
    key: "won",
    label: "Won",
    checklist: [
      { key: "customer_po_recorded", label: "Customer PO recorded" },
      { key: "terms_confirmed", label: "Price / terms confirmed" },
    ],
    fields: [
      { key: "wonDate", label: "Won date", type: "date" },
      { key: "customerPoNumber", label: "Customer PO #", type: "text" },
    ],
  },
  {
    key: "material_ordered",
    label: "Material Ordered",
    checklist: [{ key: "material_ordered_confirmed", label: "Material ordered / confirmed in stock" }],
    fields: [
      { key: "materialSpec", label: "Spec", type: "text" },
      { key: "materialSize", label: "Size / stock", type: "text" },
      { key: "materialSupplier", label: "Supplier", type: "text" },
      { key: "materialPoRef", label: "Supplier PO reference", type: "text" },
      { key: "materialOrderedDate", label: "Ordered date", type: "date" },
    ],
  },
  {
    key: "material_received",
    label: "Material Received",
    checklist: [{ key: "material_checked", label: "Material received & checked against spec" }],
    fields: [{ key: "materialReceivedDate", label: "Received date", type: "date" }],
  },
  {
    key: "queued",
    label: "Queued",
    checklist: [
      { key: "program_ready", label: "Program / tooling ready" },
      { key: "fixture_ready", label: "Fixture / workholding ready" },
    ],
    fields: [],
  },
  {
    key: "in_progress",
    label: "In Progress",
    checklist: [{ key: "first_article_approved", label: "First article inspected / approved" }],
    fields: [],
  },
  {
    key: "deburr_pack",
    label: "Deburr / Pack",
    checklist: [
      { key: "deburr_complete", label: "Deburr complete" },
      { key: "final_inspection_passed", label: "Final inspection passed" },
      { key: "packaged", label: "Packaged" },
    ],
    fields: [],
  },
  {
    key: "shipped",
    label: "Shipped",
    checklist: [{ key: "shipping_confirmed", label: "Shipping confirmation recorded" }],
    fields: [],
  },
  {
    key: "invoiced",
    label: "Invoiced",
    checklist: [{ key: "invoice_sent", label: "Invoice sent" }],
    fields: [],
  },
];
const STATUSES = [...STAGE_DEFS.map((s) => ({ key: s.key, label: s.label })), { key: "lost", label: "Lost" }];
const statusLabel = (key) => STATUSES.find((s) => s.key === key)?.label || key;

function stageIndex(key) {
  return STAGE_DEFS.findIndex((s) => s.key === key);
}

function emptyStageChecklists() {
  return Object.fromEntries(
    STAGE_DEFS.map((s) => [s.key, Object.fromEntries(s.checklist.map((c) => [c.key, false]))])
  );
}

function isStageComplete(job, stageKey) {
  const stage = STAGE_DEFS.find((s) => s.key === stageKey);
  if (!stage) return true;
  const state = job.stageChecklists?.[stageKey] || {};
  const checklistOk = stage.checklist.every((c) => state[c.key]);
  const fieldsOk = stage.fields.every((f) => !f.required || job[f.key]);
  return checklistOk && fieldsOk;
}

let customers = [];
let customersById = {};
let jobs = [];
let currentJobId = null;
let currentJobData = null; // local cache of the open job, kept in sync via onSnapshot
let expandedStages = null; // local UI state (not persisted): which accordion sections are open
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

function suggestNextCustomerNumber() {
  const maxNum = customers.reduce((max, c) => {
    const n = parseInt(c.customerNumber, 10);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  return String(maxNum + 1);
}

$('.nav-btn[data-view="customers"]').addEventListener("click", () => {
  if (!$("#cust-number").value) $("#cust-number").value = suggestNextCustomerNumber();
});

$("#btn-back-to-board").addEventListener("click", () => showView("board"));
$("#btn-print-job").addEventListener("click", () => window.print());

// ---------- Customers ----------

function startListeners() {
  unsubCustomers = onSnapshot(
    collection(db, "customers"),
    (snap) => {
      customers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      customers.sort((a, b) => a.customerNumber.localeCompare(b.customerNumber, undefined, { numeric: true }));
      customersById = Object.fromEntries(customers.map((c) => [c.id, c]));
      renderCustomers();
      populateCustomerSelect();
      renderBoard();
    },
    showError
  );

  unsubJobs = onSnapshot(
    collection(db, "jobs"),
    (snap) => {
      jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderBoard();
    },
    showError
  );
}

function renderCustomers() {
  $("#customers-tbody").innerHTML = customers
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.customerNumber)}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.phone || "")}</td><td>${escapeHtml(c.email || "")}</td></tr>`
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
  try {
    await addDoc(collection(db, "customers"), {
      customerNumber: $("#cust-number").value.trim(),
      name: $("#cust-name").value.trim(),
      phone: $("#cust-phone").value.trim(),
      email: $("#cust-email").value.trim(),
      createdAt: serverTimestamp(),
    });
    $("#customer-form").reset();
    $("#cust-number").value = suggestNextCustomerNumber();
  } catch (err) {
    showError(err);
  }
});

// ---------- Board / calendar ----------

let weekOffset = 0;

$("#cal-prev").addEventListener("click", () => { weekOffset -= 1; renderBoard(); });
$("#cal-next").addEventListener("click", () => { weekOffset += 1; renderBoard(); });
$("#cal-today").addEventListener("click", () => { weekOffset = 0; renderBoard(); });

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeek(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const mondayOffset = (date.getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  date.setDate(date.getDate() - mondayOffset);
  return date;
}

function statusGroup(status) {
  if (status === "lost") return "lost";
  if (status === "shipped" || status === "invoiced") return "done";
  if (status === "in_progress" || status === "deburr_pack") return "in-progress";
  return "not-started";
}

function jobCardHtml(j) {
  const custName = customersById[j.customerId]?.name || "?";
  return `
    <div class="job-card" data-id="${j.id}">
      <div class="jc-number">${escapeHtml(j.jobNumber)}</div>
      <div class="jc-desc">${escapeHtml(custName)} — ${escapeHtml(j.description || "")}</div>
      <div class="jc-due">${escapeHtml(statusLabel(j.status))}</div>
    </div>`;
}

function renderBoard() {
  const weekStart = startOfWeek(new Date());
  weekStart.setDate(weekStart.getDate() + weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
  const weekStartIso = toISODate(days[0]);
  const weekEndIso = toISODate(days[6]);
  const todayIso = toISODate(new Date());

  $("#cal-range").textContent = `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  $("#cal-header").innerHTML = days
    .map((d) => {
      const iso = toISODate(d);
      return `<div class="cal-day-label ${iso === todayIso ? "today" : ""}">
        ${d.toLocaleDateString(undefined, { weekday: "short" })}
        <span class="cal-date-num">${d.getDate()}</span>
      </div>`;
    })
    .join("");

  const unscheduled = jobs.filter((j) => !j.dueDate);
  $("#unscheduled-tray").innerHTML = unscheduled.length
    ? `<h4>Unscheduled (${unscheduled.length})</h4><div class="unscheduled-list">${unscheduled.map(jobCardHtml).join("")}</div>`
    : "";

  // jobs whose start-to-due span overlaps the visible week
  const overlapping = jobs
    .filter((j) => j.dueDate)
    .map((j) => ({ job: j, start: j.startDate || j.dueDate, end: j.dueDate }))
    .filter(({ start, end }) => end >= weekStartIso && start <= weekEndIso)
    .sort((a, b) => a.start.localeCompare(b.start));

  // greedy row-packing so overlapping-date jobs don't share a row
  const rowEnds = [];
  overlapping.forEach((item) => {
    let row = rowEnds.findIndex((endIso) => endIso < item.start);
    if (row === -1) {
      row = rowEnds.length;
    }
    rowEnds[row] = item.end;
    item.row = row;
  });

  const colBackgrounds = days
    .map((d, i) => {
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      return `<div class="cal-col-bg ${isWeekend ? "weekend" : ""}" style="grid-column:${i + 1};grid-row:1 / -1;"></div>`;
    })
    .join("");

  const bars = overlapping
    .map(({ job, start, end, row }) => {
      const clampedStart = start < weekStartIso ? weekStartIso : start;
      const clampedEnd = end > weekEndIso ? weekEndIso : end;
      const startCol = days.findIndex((d) => toISODate(d) === clampedStart) + 1;
      const endCol = days.findIndex((d) => toISODate(d) === clampedEnd) + 2;
      const custName = customersById[job.customerId]?.name || "?";
      const title = `${job.jobNumber} — ${custName} — ${job.description || ""} (${statusLabel(job.status)})`;
      return `<div class="cal-bar group-${statusGroup(job.status)}" data-id="${job.id}"
        style="grid-column:${startCol} / ${endCol}; grid-row:${row + 1};" title="${escapeHtml(title)}">
        <span class="cal-bar-status">${escapeHtml(statusLabel(job.status))}</span>
        <span>${escapeHtml(job.jobNumber)} — ${escapeHtml(custName)}</span>
      </div>`;
    })
    .join("");

  const grid = $("#cal-grid");
  grid.innerHTML = colBackgrounds + bars;
  grid.style.gridTemplateRows = `repeat(${Math.max(rowEnds.length, 1)}, 34px)`;

  $all(".cal-bar").forEach((bar) => bar.addEventListener("click", () => openJobDetail(bar.dataset.id)));
  $all(".unscheduled-list .job-card").forEach((card) =>
    card.addEventListener("click", () => openJobDetail(card.dataset.id))
  );
}

// ---------- New job ----------

$("#new-job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const customerId = $("#job-customer").value;
  const customer = customersById[customerId];
  if (!customer) return;

  try {
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
      startDate: $("#job-start-date").value || "",
      dueDate: $("#job-due-date").value || "",
      status: "rfq",
      stageChecklists: emptyStageChecklists(),
      rfqDate: "",
      expectedCompletionDate: "",
      quotedPrice: "",
      wonDate: "",
      customerPoNumber: "",
      materialSpec: "",
      materialSize: "",
      materialSupplier: "",
      materialPoRef: "",
      materialOrderedDate: "",
      materialReceivedDate: "",
      operations: [],
      timeLog: [],
      referenceClass: "",
      notes: "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    openJobDetail(docRef.id);
  } catch (err) {
    showError(err);
  }
});

// ---------- Job detail / traveler ----------

function openJobDetail(id) {
  currentJobId = id;
  expandedStages = null;
  showView("job-detail");
  if (unsubJobDetail) unsubJobDetail();
  unsubJobDetail = onSnapshot(
    doc(db, "jobs", id),
    (snap) => {
      if (!snap.exists()) return;
      renderJobDetail({ id: snap.id, ...snap.data() });
    },
    showError
  );
}

function renderJobDetail(job) {
  currentJobData = job;
  $("#jd-job-number").textContent = job.jobNumber;
  $("#jd-status-badge").textContent = statusLabel(job.status);
  $("#jd-customer-name").textContent = customersById[job.customerId]
    ? `${customersById[job.customerId].customerNumber} — ${customersById[job.customerId].name}`
    : "";

  $("#jd-description").value = job.description || "";
  $("#jd-part-number").value = job.partNumber || "";
  $("#jd-qty").value = job.qty || 1;
  $("#jd-start-date").value = job.startDate || "";
  $("#jd-due-date").value = job.dueDate || "";
  $("#jd-reference-class").value = job.referenceClass || "";
  $("#jd-notes").value = job.notes || "";

  renderLostControl(job);
  renderStageAccordion(job);
  renderOperations(job.operations || []);
  renderTimeLog(job.timeLog || []);
}

function jobRef() {
  return doc(db, "jobs", currentJobId);
}

function saveField(field, value) {
  updateDoc(jobRef(), { [field]: value, updatedAt: serverTimestamp() }).catch(showError);
}

$("#jd-description").addEventListener("change", (e) => saveField("description", e.target.value));
$("#jd-part-number").addEventListener("change", (e) => saveField("partNumber", e.target.value));
$("#jd-qty").addEventListener("change", (e) => saveField("qty", Number(e.target.value) || 1));
$("#jd-start-date").addEventListener("change", (e) => saveField("startDate", e.target.value));
$("#jd-due-date").addEventListener("change", (e) => saveField("dueDate", e.target.value));
$("#jd-reference-class").addEventListener("change", (e) => saveField("referenceClass", e.target.value));
$("#jd-notes").addEventListener("change", (e) => saveField("notes", e.target.value));

// ---------- Stage accordion ----------

function setStatus(newStatus, focusStage, extraFields = {}) {
  expandedStages = new Set([focusStage || newStatus]);
  updateDoc(jobRef(), { status: newStatus, ...extraFields, updatedAt: serverTimestamp() }).catch(showError);
}

function renderLostControl(job) {
  const el = $("#lost-control");
  if (job.status === "lost") {
    el.innerHTML = `<div class="lost-banner">
      <span>This quote was marked as lost.</span>
      <button type="button" id="btn-reopen-lost">Reopen (back to RFQ)</button>
    </div>`;
    $("#btn-reopen-lost").addEventListener("click", () => setStatus("rfq"));
  } else if (["rfq", "quoted", "won"].includes(job.status)) {
    el.innerHTML = `<button type="button" id="btn-mark-lost">Mark as lost</button>`;
    $("#btn-mark-lost").addEventListener("click", () => setStatus("lost"));
  } else {
    el.innerHTML = "";
  }
}

function renderStageAccordion(job) {
  const container = $("#stage-accordion");
  if (job.status === "lost") {
    container.innerHTML = "";
    return;
  }

  const currentIdx = Math.max(stageIndex(job.status), 0);
  if (expandedStages === null) expandedStages = new Set([job.status]);

  container.innerHTML = STAGE_DEFS.map((stage, idx) => {
    const state = idx < currentIdx ? "completed" : idx === currentIdx ? "current" : "upcoming";
    const complete = isStageComplete(job, stage.key);
    const doneCount = stage.checklist.filter((c) => job.stageChecklists?.[stage.key]?.[c.key]).length;
    const isOpen = expandedStages.has(stage.key);
    const mark = state === "completed" ? "✓" : idx + 1;

    const checklistHtml = stage.checklist
      .map((c) => {
        const checked = job.stageChecklists?.[stage.key]?.[c.key] ? "checked" : "";
        return `<label><input type="checkbox" data-stage="${stage.key}" data-item="${c.key}" ${checked} /> ${escapeHtml(c.label)}</label>`;
      })
      .join("");

    const fieldsHtml = stage.fields
      .map((f) => {
        const value = job[f.key] ?? "";
        const type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
        const step = f.type === "number" ? ' step="0.01"' : "";
        return `<label>${escapeHtml(f.label)}${f.required ? " *" : ""} <input type="${type}"${step} data-field="${f.key}" value="${escapeHtml(value)}" /></label>`;
      })
      .join("");

    const isLastStage = idx === STAGE_DEFS.length - 1;
    let actionsHtml = "";
    if (state === "current" && !isLastStage) {
      actionsHtml = `<div class="stage-actions">
        <button type="button" class="stage-advance" ${complete ? "" : "disabled"}>Mark complete &amp; continue &rarr;</button>
        ${!complete ? '<button type="button" class="stage-override">advance anyway</button>' : ""}
      </div>`;
    } else if (state === "completed") {
      actionsHtml = `<div class="stage-actions">
        <button type="button" class="stage-reopen">Reopen — move job back to this stage</button>
      </div>`;
    }

    return `<div class="stage-section ${state}" data-stage="${stage.key}">
      <div class="stage-header">
        <span class="stage-mark">${mark}</span>
        <span>${escapeHtml(stage.label)}</span>
        ${stage.checklist.length ? `<span class="stage-progress">${doneCount}/${stage.checklist.length}</span>` : ""}
        <span class="stage-caret">${isOpen ? "▾" : "▸"}</span>
      </div>
      <div class="stage-body ${isOpen ? "" : "collapsed"}">
        ${checklistHtml ? `<div class="stage-checklist">${checklistHtml}</div>` : ""}
        ${fieldsHtml ? `<div class="stage-fields">${fieldsHtml}</div>` : ""}
        ${actionsHtml}
      </div>
    </div>`;
  }).join("");

  $all(".stage-header").forEach((header) =>
    header.addEventListener("click", () => {
      const key = header.closest(".stage-section").dataset.stage;
      if (expandedStages.has(key)) expandedStages.delete(key);
      else expandedStages.add(key);
      renderStageAccordion(currentJobData);
    })
  );

  $all('.stage-checklist input[type="checkbox"]').forEach((cb) =>
    cb.addEventListener("change", (e) => {
      const { stage, item } = e.target.dataset;
      updateDoc(jobRef(), {
        [`stageChecklists.${stage}.${item}`]: e.target.checked,
        updatedAt: serverTimestamp(),
      }).catch(showError);
    })
  );

  $all(".stage-fields input").forEach((input) =>
    input.addEventListener("change", (e) => saveField(e.target.dataset.field, e.target.value))
  );

  function advanceFromCurrentStage() {
    const nextStage = STAGE_DEFS[currentIdx + 1];
    if (!nextStage) return;
    const currentStage = STAGE_DEFS[currentIdx];
    const extraFields = currentStage.key === "rfq" && !job.rfqDate ? { rfqDate: toISODate(new Date()) } : {};
    setStatus(nextStage.key, undefined, extraFields);
  }
  $all(".stage-advance").forEach((btn) => btn.addEventListener("click", advanceFromCurrentStage));
  $all(".stage-override").forEach((btn) => btn.addEventListener("click", advanceFromCurrentStage));
  $all(".stage-reopen").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.closest(".stage-section").dataset.stage;
      setStatus(key);
    })
  );
}

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
