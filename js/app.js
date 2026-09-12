import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, getDocs, query, where,
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
      {
        key: "reference",
        label: "Reference provided",
        type: "group",
        options: [
          { key: "drawing", label: "Drawing" },
          { key: "model_3d", label: "3D model" },
          { key: "sample_part", label: "Sample part" },
          { key: "none", label: "None" },
        ],
      },
      {
        key: "material_source",
        label: "Material",
        type: "group",
        options: [
          { key: "customer_supplied", label: "Customer supplying material" },
          { key: "shop_supplied", label: "BPE supplying material" },
          { key: "repair_existing", label: "Repair existing part" },
        ],
      },
      {
        key: "tooling",
        label: "Tooling",
        type: "subsection",
        items: [
          { key: "special_tooling_required", label: "Special tooling required", optional: true },
          { key: "checked_existing_tooling", label: "Checked existing tooling" },
        ],
        textField: {
          key: "specialToolingDescription",
          label: "Special tooling needed",
          showIf: (job) => !!job.stageChecklists?.rfq?.tooling?.special_tooling_required,
        },
      },
    ],
    fields: [
      { key: "rfqDate", label: "RFQ date", type: "date" },
      { key: "expectedCompletionDate", label: "Expected completion date", type: "date", required: true },
      { key: "expectedHours", label: "Expected hours", type: "number" },
    ],
  },
  {
    key: "quoted",
    label: "Quoted",
    checklist: [{ key: "quote_sent", label: "Quote sent to customer" }],
    fields: [
      { key: "quotedDate", label: "Quoted date", type: "date" },
      { key: "quotedPrice", label: "Quoted price", type: "number" },
      { key: "quickbooksQuoteNumber", label: "QuickBooks quote #", type: "text" },
    ],
  },
  {
    key: "won",
    label: "Won",
    checklist: [
      { key: "customer_po_recorded", label: "Customer PO recorded", optional: true },
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
    // Not needed when the customer is supplying material or it's a repair job.
    skipIf: (job) => {
      const src = job.stageChecklists?.rfq?.material_source || {};
      return !!(src.customer_supplied || src.repair_existing);
    },
    skipMessage: "Not needed — customer supplying material or repairing an existing part.",
    checklist: [{ key: "material_ordered_confirmed", label: "Material ordered / confirmed in stock" }],
    // Material items (qty/spec/size) are a repeatable list, rendered specially
    // for this stage rather than as simple fields -- see renderStageAccordion.
    fields: [
      { key: "materialSupplier", label: "Supplier", type: "text" },
      { key: "materialPoRef", label: "Supplier PO reference", type: "text" },
      { key: "materialOrderedDate", label: "Ordered date", type: "date" },
    ],
  },
  {
    key: "tooling_ordered",
    label: "Tooling Ordered",
    // Not needed unless the RFQ flagged special tooling as required.
    skipIf: (job) => !job.stageChecklists?.rfq?.tooling?.special_tooling_required,
    skipMessage: "Not needed — no special tooling was flagged as required in the RFQ.",
    checklist: [{ key: "tooling_ordered_confirmed", label: "Special tooling ordered / confirmed" }],
    fields: [{ key: "specialToolingDescription", label: "Special tooling needed", type: "text", readonly: true }],
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
      { key: "programmed", label: "Programmed" },
      { key: "special_tooling_ready", label: "Special tooling ready", optional: true },
      { key: "fixture_ready", label: "Fixture / workholding ready" },
      { key: "traveler_printed", label: "Traveler printed" },
      {
        key: "drawings_printed",
        label: "Drawings printed",
        skipIf: (job) => !job.stageChecklists?.rfq?.reference?.drawing,
      },
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
    key: "actual_hours",
    label: "Actual Hours",
    // No manual checklist -- complete once every operation has an actual
    // hours value recorded. This is the real data future RCF quoting draws
    // on, so it's a genuine gate before a job can be invoiced.
    checklist: [],
    fields: [],
    isComplete: (job) => (job.operations || []).every((op) => op.actualHours !== "" && op.actualHours != null),
    progressText: (job) => {
      const ops = job.operations || [];
      if (!ops.length) return null;
      const done = ops.filter((op) => op.actualHours !== "" && op.actualHours != null).length;
      return `${done}/${ops.length}`;
    },
  },
  {
    key: "invoiced",
    label: "Invoiced",
    checklist: [{ key: "invoice_sent", label: "Invoice sent" }],
    fields: [
      { key: "invoicedDate", label: "Invoiced date", type: "date" },
      { key: "quickbooksInvoiceNumber", label: "QuickBooks invoice #", type: "text" },
    ],
  },
  {
    key: "paid",
    label: "Paid",
    checklist: [{ key: "invoice_paid", label: "Invoice paid" }],
    fields: [],
  },
];

// A job is fully settled once it's reached the (last) Paid stage and that
// stage's own checklist is complete -- used to grey it out on the board.
function isJobPaid(job) {
  return job.status === "paid" && isStageComplete(job, "paid");
}

// Stage key -> job fields to auto-stamp with today's date when advancing out
// of that stage (only filled if not already set).
const AUTOFILL_ON_ADVANCE = {
  rfq: ["rfqDate", "quotedDate"],
  won: ["wonDate"],
  material_ordered: ["materialOrderedDate"],
  material_received: ["materialReceivedDate"],
  actual_hours: ["invoicedDate"],
};
const STATUSES = [...STAGE_DEFS.map((s) => ({ key: s.key, label: s.label })), { key: "lost", label: "Lost" }];
const statusLabel = (key) => STATUSES.find((s) => s.key === key)?.label || key;

function stageIndex(key) {
  return STAGE_DEFS.findIndex((s) => s.key === key);
}

function emptyStageChecklists() {
  return Object.fromEntries(
    STAGE_DEFS.map((s) => [
      s.key,
      Object.fromEntries(
        s.checklist.map((c) =>
          c.type === "group"
            ? [c.key, Object.fromEntries(c.options.map((o) => [o.key, false]))]
            : c.type === "subsection"
            ? [c.key, Object.fromEntries(c.items.map((i) => [i.key, false]))]
            : [c.key, false]
        )
      ),
    ])
  );
}

// A group entry (e.g. "Reference provided": Drawing / 3D model / Sample / None)
// is satisfied once at least one of its options is checked. An "optional"
// entry, or one whose skipIf(job) says it doesn't apply to this job, never
// blocks stage completion regardless of whether it's checked.
function isChecklistEntrySatisfied(job, stageKey, entry) {
  if (entry.optional) return true;
  if (entry.skipIf && entry.skipIf(job)) return true;
  if (entry.type === "group") {
    const groupState = job.stageChecklists?.[stageKey]?.[entry.key] || {};
    return entry.options.some((o) => groupState[o.key]);
  }
  if (entry.type === "subsection") {
    const subState = job.stageChecklists?.[stageKey]?.[entry.key] || {};
    return entry.items.every((i) => i.optional || !!subState[i.key]);
  }
  return !!job.stageChecklists?.[stageKey]?.[entry.key];
}

function isStageComplete(job, stageKey) {
  const stage = STAGE_DEFS.find((s) => s.key === stageKey);
  if (!stage) return true;
  if (stage.skipIf && stage.skipIf(job)) return true;
  if (stage.isComplete) return stage.isComplete(job);
  const checklistOk = stage.checklist.every((c) => isChecklistEntrySatisfied(job, stageKey, c));
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

function syncNewCustomerFieldsVisibility() {
  const isNew = $("#job-customer").value === "__new__";
  $("#new-customer-fields").classList.toggle("hidden", !isNew);
  if (isNew && !$("#job-new-cust-number").value) {
    $("#job-new-cust-number").value = suggestNextCustomerNumber();
  }
}

$("#btn-new-job").addEventListener("click", () => {
  populateCustomerSelect();
  $("#new-job-form").reset();
  if (customers.length) $("#job-customer").value = customers[0].id;
  syncNewCustomerFieldsVisibility();
  showView("new-job");
});

$("#job-customer").addEventListener("change", syncNewCustomerFieldsVisibility);

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

$("#btn-delete-job").addEventListener("click", async () => {
  if (!currentJobData) return;
  const ok = window.confirm(`Delete job ${currentJobData.jobNumber}? This cannot be undone.`);
  if (!ok) return;
  try {
    await deleteDoc(jobRef());
    showView("board");
  } catch (err) {
    showError(err);
  }
});

// Copies a job as a starting template for a similar one (e.g. same part
// with a different size/qty) -- same customer, materials, operations and
// reference info carry over; anything tied to a specific run through the
// pipeline (status, dates, checklists, quote/PO/invoice numbers, time
// logged) resets so the new job starts clean at RFQ.
$("#btn-duplicate-job").addEventListener("click", async () => {
  const src = currentJobData;
  if (!src) return;
  try {
    const { sequenceForCustomer, jobNumber } = await nextJobNumberFields(src.customerId, src.customerNumber);
    const docRef = await addDoc(collection(db, "jobs"), {
      jobNumber,
      customerId: src.customerId,
      customerNumber: src.customerNumber,
      sequenceForCustomer,
      description: src.description || "",
      partNumber: src.partNumber || "",
      qty: src.qty || 1,
      startDate: "",
      dueDate: "",
      workshopStartDate: "",
      workshopHours: src.workshopHours || "",
      status: "rfq",
      stageChecklists: emptyStageChecklists(),
      rfqDate: "",
      expectedCompletionDate: "",
      expectedHours: src.expectedHours || "",
      specialToolingDescription: src.specialToolingDescription || "",
      quotedDate: "",
      quotedPrice: "",
      quickbooksQuoteNumber: "",
      wonDate: "",
      customerPoNumber: "",
      materialItems: (src.materialItems || []).map((m) => ({ ...m })),
      materialSupplier: src.materialSupplier || "",
      materialPoRef: "",
      materialOrderedDate: "",
      materialReceivedDate: "",
      invoicedDate: "",
      quickbooksInvoiceNumber: "",
      operations: (src.operations || []).map((op) => ({
        name: op.name,
        notes: op.notes || "",
        done: false,
        expectedHours: op.expectedHours || "",
        actualHours: "",
      })),
      timeLog: [],
      referenceClass: src.referenceClass || "",
      notes: src.notes || "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    openJobDetail(docRef.id);
  } catch (err) {
    showError(err);
  }
});

// ---------- Customers ----------

function startListeners() {
  renderStatusLegend();

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

function customerOptionsHtml() {
  return customers
    .map((c) => `<option value="${c.id}">${escapeHtml(c.customerNumber)} — ${escapeHtml(c.name)}</option>`)
    .join("");
}

function populateCustomerSelect() {
  $("#job-customer").innerHTML = `<option value="__new__">+ New customer…</option>` + customerOptionsHtml();
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

function parseISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const WORKSHOP_DAY_HOURS = 8;

// Each job's own day-by-day hour breakdown is anchored strictly to its own
// workshopStartDate -- a job only spills into a second/third day because
// its own hours exceed one day's capacity, never because another job got
// there first. Same-day segments are then packed side by side purely for
// display (ties broken by job number, since there's no priority field);
// if that pushes a day's total past WORKSHOP_DAY_HOURS, the segment is
// flagged as a conflict rather than being moved -- the user decides
// whether that's really two jobs running at once or needs rescheduling.
function computeWorkshopSegments(jobList) {
  const scheduled = jobList
    .filter((j) => j.workshopStartDate && Number(j.workshopHours) > 0)
    .sort((a, b) => a.workshopStartDate.localeCompare(b.workshopStartDate) || a.jobNumber.localeCompare(b.jobNumber));

  const perJobDaySegments = []; // { job, dateIso, hours }
  scheduled.forEach((job) => {
    let remaining = Number(job.workshopHours);
    const cursor = parseISODate(job.workshopStartDate);
    let guard = 0;
    while (remaining > 0 && guard < 400) {
      guard += 1;
      const hours = Math.min(remaining, WORKSHOP_DAY_HOURS);
      perJobDaySegments.push({ job, dateIso: toISODate(cursor), hours });
      remaining -= hours;
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  const dayOffset = {}; // dateIso -> cumulative hours placed so far that day
  return perJobDaySegments.map((seg) => {
    const offsetHours = dayOffset[seg.dateIso] || 0;
    dayOffset[seg.dateIso] = offsetHours + seg.hours;
    const conflict = offsetHours + seg.hours > WORKSHOP_DAY_HOURS;
    return { job: seg.job, dateIso: seg.dateIso, offsetHours, hours: seg.hours, conflict };
  });
}

const STATUS_COLORS = {
  rfq: "#64748b",
  quoted: "#7c6ff0",
  won: "#2f6fed",
  material_ordered: "#f5a524",
  material_received: "#e08b2f",
  queued: "#06b6d4",
  in_progress: "#f0592b",
  deburr_pack: "#ec4899",
  shipped: "#22c55e",
  actual_hours: "#0d9488",
  invoiced: "#15803d",
  paid: "#a16207",
  lost: "#9aa2ab",
};
const statusColor = (key) => STATUS_COLORS[key] || "#5b8def";

// The board shows how far a job has actually gotten, not what it's working
// toward next — so it displays the last fully-completed stage, not job.status
// itself (which is the stage currently in progress).
function lastCompletedStageKey(status) {
  if (status === "lost") return "lost";
  const idx = stageIndex(status);
  return idx > 0 ? STAGE_DEFS[idx - 1].key : null;
}
function lastCompletedLabel(status) {
  const key = lastCompletedStageKey(status);
  return key ? statusLabel(key) : "New";
}
function lastCompletedColor(status) {
  const key = lastCompletedStageKey(status);
  return key ? statusColor(key) : "#94a3b8";
}

function renderStatusLegend() {
  const statusItems = STATUSES.map(
    (s) => `<span class="legend-item"><span class="legend-swatch" style="background:${statusColor(s.key)}"></span>${escapeHtml(s.label)}</span>`
  ).join("");
  const workshopItem = `<span class="legend-item"><span class="legend-swatch legend-swatch-workshop"></span>Scheduled workshop time</span>`;
  const conflictItem = `<span class="legend-item"><span class="legend-swatch legend-swatch-workshop legend-swatch-conflict"></span>Over capacity that day</span>`;
  $("#status-legend").innerHTML = statusItems + workshopItem + conflictItem;
}

function jobCardHtml(j) {
  const custName = customersById[j.customerId]?.name || "?";
  const paid = isJobPaid(j);
  return `
    <div class="job-card ${paid ? "paid" : ""}" data-id="${j.id}">
      <div class="jc-number">${escapeHtml(j.jobNumber)}</div>
      <div class="jc-desc">${escapeHtml(custName)} — ${escapeHtml(j.description || "")}</div>
      <div class="jc-due">${paid ? "Paid" : escapeHtml(lastCompletedLabel(j.status))}</div>
    </div>`;
}

function formatCurrency(n) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderCashflowSummary(weekStartIso, weekEndIso) {
  const inWeek = (dateStr) => dateStr && dateStr >= weekStartIso && dateStr <= weekEndIso;
  const sumByDate = (dateField, valueField) =>
    jobs.filter((j) => inWeek(j[dateField])).reduce((total, j) => total + (Number(j[valueField]) || 0), 0);

  const moneyStats = [
    ["Quoted this week", sumByDate("quotedDate", "quotedPrice")],
    ["Won this week", sumByDate("wonDate", "quotedPrice")],
    ["Invoiced this week", sumByDate("invoicedDate", "quotedPrice")],
    ["Scheduled this week", sumByDate("dueDate", "quotedPrice")],
  ];
  const scheduledHours = sumByDate("dueDate", "expectedHours");

  $("#cashflow-summary").innerHTML =
    moneyStats
      .map(([label, total]) => `<span class="cashflow-stat"><span class="cashflow-label">${label}</span>${formatCurrency(total)}</span>`)
      .join("") +
    `<span class="cashflow-stat"><span class="cashflow-label">Scheduled hours</span>${scheduledHours.toLocaleString(undefined, { maximumFractionDigits: 1 })} hrs</span>`;
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

  renderCashflowSummary(weekStartIso, weekEndIso);

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

  // A job's row needs to account for whichever of its lifecycle span (due
  // date) or workshop schedule is present -- a job can have workshop hours
  // booked before a due date is even set, and still needs a row so its
  // workshop stripe has somewhere to render.
  const workshopSegmentsAll = computeWorkshopSegments(jobs);
  const workshopRangeByJobId = {};
  workshopSegmentsAll.forEach((seg) => {
    const r = workshopRangeByJobId[seg.job.id];
    if (!r) workshopRangeByJobId[seg.job.id] = { start: seg.dateIso, end: seg.dateIso };
    else {
      if (seg.dateIso < r.start) r.start = seg.dateIso;
      if (seg.dateIso > r.end) r.end = seg.dateIso;
    }
  });

  const overlapping = [];
  jobs.forEach((job) => {
    const lifecycle = job.dueDate ? { start: job.startDate || job.dueDate, end: job.dueDate } : null;
    const workshop = workshopRangeByJobId[job.id] || null;
    if (!lifecycle && !workshop) return;
    let start = lifecycle ? lifecycle.start : workshop.start;
    let end = lifecycle ? lifecycle.end : workshop.end;
    if (workshop) {
      if (workshop.start < start) start = workshop.start;
      if (workshop.end > end) end = workshop.end;
    }
    if (end < weekStartIso || start > weekEndIso) return;
    overlapping.push({ job, start, end, hasLifecycle: !!lifecycle });
  });
  overlapping.sort((a, b) => a.start.localeCompare(b.start));

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
    .filter((item) => item.hasLifecycle)
    .map(({ job, start, end, row }) => {
      const clampedStart = start < weekStartIso ? weekStartIso : start;
      const clampedEnd = end > weekEndIso ? weekEndIso : end;
      const startCol = days.findIndex((d) => toISODate(d) === clampedStart) + 1;
      const endCol = days.findIndex((d) => toISODate(d) === clampedEnd) + 2;
      const custName = customersById[job.customerId]?.name || "?";
      const paid = isJobPaid(job);
      const barLabel = paid ? "Paid" : lastCompletedLabel(job.status);
      const barColor = paid ? "#9aa2ab" : lastCompletedColor(job.status);
      const title = `${job.jobNumber} — ${custName} — ${job.description || ""} — last completed: ${lastCompletedLabel(job.status)}, currently: ${statusLabel(job.status)}`;
      return `<div class="cal-bar ${paid ? "paid" : ""}" data-id="${job.id}"
        style="grid-column:${startCol} / ${endCol}; grid-row:${row + 1}; background:${barColor};" title="${escapeHtml(title)}">
        <span class="cal-bar-status">${escapeHtml(barLabel)}</span>
        <span>${escapeHtml(job.jobNumber)} — ${escapeHtml(custName)} — ${escapeHtml(job.description || "")}</span>
      </div>`;
    })
    .join("");

  // Jobs with workshop hours booked but no due date yet still need a
  // labeled placeholder in their row, since they have no lifecycle bar.
  const ghostBars = overlapping
    .filter((item) => !item.hasLifecycle)
    .map(({ job, start, end, row }) => {
      const clampedStart = start < weekStartIso ? weekStartIso : start;
      const clampedEnd = end > weekEndIso ? weekEndIso : end;
      const startCol = days.findIndex((d) => toISODate(d) === clampedStart) + 1;
      const endCol = days.findIndex((d) => toISODate(d) === clampedEnd) + 2;
      const custName = customersById[job.customerId]?.name || "?";
      const title = `${job.jobNumber} — ${custName} — ${job.description || ""} — workshop time scheduled, no due date set yet`;
      return `<div class="cal-bar cal-bar-ghost" data-id="${job.id}"
        style="grid-column:${startCol} / ${endCol}; grid-row:${row + 1};" title="${escapeHtml(title)}">
        <span class="cal-bar-status">No due date</span>
        <span>${escapeHtml(job.jobNumber)} — ${escapeHtml(custName)}</span>
      </div>`;
    })
    .join("");

  // Workshop (actual machine time) overlay: a fractional-width block along
  // the bottom of a job's bar, sized by hours against an assumed 8hr day.
  // Multiple jobs starting the same day are packed side by side within it.
  const rowByJobId = {};
  overlapping.forEach(({ job, row }) => {
    rowByJobId[job.id] = row;
  });

  const workshopOverlays = workshopSegmentsAll
    .filter((seg) => seg.dateIso >= weekStartIso && seg.dateIso <= weekEndIso && rowByJobId[seg.job.id] !== undefined)
    .map((seg) => {
      const dayIdx = days.findIndex((d) => toISODate(d) === seg.dateIso);
      if (dayIdx === -1) return "";
      const row = rowByJobId[seg.job.id];
      // Clipped to stay within the day column visually even when a
      // conflict pushes the true total past 8hrs -- the red color carries
      // the "overbooked" signal, not the exact overflowing width.
      const leftPct = Math.min((seg.offsetHours / WORKSHOP_DAY_HOURS) * 100, 100);
      const rawWidthPct = (seg.hours / WORKSHOP_DAY_HOURS) * 100;
      const widthPct = Math.max(0, Math.min(rawWidthPct, 100 - leftPct));
      const title = `${seg.job.jobNumber} — ${seg.hours}h workshop time on ${seg.dateIso}${seg.conflict ? " — CONFLICT: exceeds available machine hours that day" : ""}`;
      return `<div class="cal-bar-workshop ${seg.conflict ? "conflict" : ""}" style="grid-column:${dayIdx + 1}; grid-row:${row + 1}; margin-left:calc(${leftPct}% + 4px); width:calc(${widthPct}% - 8px);" title="${escapeHtml(title)}"></div>`;
    })
    .join("");

  const grid = $("#cal-grid");
  grid.innerHTML = colBackgrounds + bars + ghostBars + workshopOverlays;
  grid.style.gridTemplateRows = `repeat(${Math.max(rowEnds.length, 1)}, 34px)`;

  $all(".cal-bar").forEach((bar) => bar.addEventListener("click", () => openJobDetail(bar.dataset.id)));
  $all(".unscheduled-list .job-card").forEach((card) =>
    card.addEventListener("click", () => openJobDetail(card.dataset.id))
  );
}

// ---------- New job ----------

// Computes the next job-number sequence for a customer by checking existing
// jobs; shared between creating a new job and reassigning an existing one.
// Takes customerNumber directly (rather than looking it up) so it also works
// for a customer just created this instant, before the customers listener
// has caught up.
async function nextJobNumberFields(customerId, customerNumber) {
  const existing = await getDocs(query(collection(db, "jobs"), where("customerId", "==", customerId)));
  const maxSeq = existing.docs.reduce((max, d) => Math.max(max, d.data().sequenceForCustomer || 0), 0);
  const sequenceForCustomer = maxSeq + 1;
  const jobNumber = `${customerNumber}-${String(sequenceForCustomer).padStart(3, "0")}`;
  return { customerNumber, sequenceForCustomer, jobNumber };
}

$("#new-job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let customerId = $("#job-customer").value;
  let customerNumber;

  try {
    if (customerId === "__new__") {
      customerNumber = $("#job-new-cust-number").value.trim();
      const newCustomerRef = await addDoc(collection(db, "customers"), {
        customerNumber,
        name: $("#job-new-cust-name").value.trim(),
        phone: $("#job-new-cust-phone").value.trim(),
        email: $("#job-new-cust-email").value.trim(),
        createdAt: serverTimestamp(),
      });
      customerId = newCustomerRef.id;
    } else {
      const customer = customersById[customerId];
      if (!customer) return;
      customerNumber = customer.customerNumber;
    }

    const { sequenceForCustomer, jobNumber } = await nextJobNumberFields(customerId, customerNumber);

    const docRef = await addDoc(collection(db, "jobs"), {
      jobNumber,
      customerId,
      customerNumber,
      sequenceForCustomer,
      description: $("#job-description").value.trim(),
      partNumber: $("#job-part-number").value.trim(),
      qty: Number($("#job-qty").value) || 1,
      startDate: $("#job-start-date").value || "",
      dueDate: $("#job-due-date").value || "",
      workshopStartDate: "",
      workshopHours: "",
      status: "rfq",
      stageChecklists: emptyStageChecklists(),
      rfqDate: "",
      expectedCompletionDate: "",
      expectedHours: "",
      specialToolingDescription: "",
      quotedDate: "",
      quotedPrice: "",
      quickbooksQuoteNumber: "",
      wonDate: "",
      customerPoNumber: "",
      materialItems: [],
      materialSupplier: "",
      materialPoRef: "",
      materialOrderedDate: "",
      materialReceivedDate: "",
      invoicedDate: "",
      quickbooksInvoiceNumber: "",
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
  $("#jd-customer-select").innerHTML = customerOptionsHtml();
  $("#jd-customer-select").value = job.customerId;

  $("#jd-description").value = job.description || "";
  $("#jd-part-number").value = job.partNumber || "";
  $("#jd-qty").value = job.qty || 1;
  $("#jd-start-date").value = job.startDate || "";
  $("#jd-due-date").value = job.dueDate || "";
  $("#jd-workshop-start").value = job.workshopStartDate || "";
  $("#jd-workshop-hours").value = job.workshopHours || "";
  $("#jd-reference-class").value = job.referenceClass || "";
  $("#jd-notes").value = job.notes || "";

  renderLostControl(job);
  renderStageAccordion(job);
  renderOperations(job.operations || []);
  renderTimeLog(job.timeLog || []);
  renderPrintTraveler(job);
}

// ---------- Printed traveler ----------
// A purpose-built shop-floor sheet: job identification, what reference/
// material/tooling exists, and the work sequence -- no pricing, dates, or
// process checklists. Kept separate from the on-screen editor so print
// output doesn't depend on what's expanded/collapsed there.

function referenceSummary(job) {
  const ref = job.stageChecklists?.rfq?.reference || {};
  const labels = { drawing: "Drawing", model_3d: "3D model", sample_part: "Sample part", none: "None" };
  const provided = Object.keys(labels).filter((k) => k !== "none" && ref[k]);
  if (ref.none) return "No reference provided";
  return provided.length ? `${provided.map((k) => labels[k]).join(", ")} provided` : "Not recorded";
}

function materialFactsHtml(job) {
  const src = job.stageChecklists?.rfq?.material_source || {};
  if (src.customer_supplied) return `<div><strong>Material:</strong> Customer supplied</div>`;
  if (src.repair_existing) return `<div><strong>Material:</strong> Repair existing part — no new material</div>`;

  const items = job.materialItems || [];
  if (!items.length) return `<div><strong>Material:</strong> Not recorded</div>`;

  const itemLines = items
    .map((m) => `<li>${escapeHtml([m.qty ? `${m.qty} x` : "", m.spec, m.size].filter(Boolean).join(" "))}</li>`)
    .join("");
  const supplier = job.materialSupplier ? ` (Supplier: ${escapeHtml(job.materialSupplier)})` : "";
  return `<div><strong>Material:</strong>${supplier}<ul class="pt-material-list">${itemLines}</ul></div>`;
}

function renderPrintTraveler(job) {
  const custName = customersById[job.customerId]?.name || "";
  const toolingRequired = !!job.stageChecklists?.rfq?.tooling?.special_tooling_required;

  const opsRows = (job.operations || [])
    .map(
      (op, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(op.name)}</td>
        <td>${escapeHtml(op.notes || "")}</td>
        <td class="pt-col-sign">${escapeHtml(op.expectedHours || "")}</td>
        <td class="pt-col-sign"></td>
      </tr>`
    )
    .join("");

  $("#print-traveler").innerHTML = `
    <div class="pt-header">
      <h1>${escapeHtml(job.jobNumber)}</h1>
      <span class="pt-customer">${escapeHtml(custName)}</span>
    </div>
    <table class="pt-info-table">
      <tr><td class="pt-label">Description</td><td>${escapeHtml(job.description || "")}</td><td class="pt-label">Qty</td><td>${escapeHtml(job.qty || "")}</td></tr>
      <tr><td class="pt-label">Part #</td><td>${escapeHtml(job.partNumber || "")}</td><td class="pt-label">Due date</td><td>${escapeHtml(job.dueDate || "")}</td></tr>
    </table>
    <div class="pt-facts">
      <div><strong>Reference:</strong> ${escapeHtml(referenceSummary(job))}</div>
      ${materialFactsHtml(job)}
      ${toolingRequired ? `<div><strong>Special tooling:</strong> ${escapeHtml(job.specialToolingDescription || "Not yet described")}</div>` : ""}
    </div>
    <table class="pt-ops-table">
      <thead><tr><th>#</th><th>Operation</th><th>Notes</th><th class="pt-col-sign">Expected hrs</th><th class="pt-col-sign">Actual hrs</th></tr></thead>
      <tbody>${opsRows || `<tr><td colspan="5">No operations listed</td></tr>`}</tbody>
    </table>
    <span class="pt-notes-label">Notes</span>
    <div class="pt-notes-box">${escapeHtml(job.notes || "")}</div>
  `;
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
$("#jd-workshop-start").addEventListener("change", (e) => saveField("workshopStartDate", e.target.value));
$("#jd-workshop-hours").addEventListener("change", (e) => saveField("workshopHours", e.target.value ? Number(e.target.value) : ""));
$("#jd-reference-class").addEventListener("change", (e) => saveField("referenceClass", e.target.value));
$("#jd-notes").addEventListener("change", (e) => saveField("notes", e.target.value));

$("#jd-customer-select").addEventListener("change", async (e) => {
  const newCustomerId = e.target.value;
  if (!newCustomerId || newCustomerId === currentJobData?.customerId) return;
  const newCustomer = customersById[newCustomerId];
  if (!newCustomer) return;
  try {
    const { customerNumber, sequenceForCustomer, jobNumber } = await nextJobNumberFields(newCustomerId, newCustomer.customerNumber);
    await updateDoc(jobRef(), {
      customerId: newCustomerId,
      customerNumber,
      sequenceForCustomer,
      jobNumber,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    showError(err);
  }
});

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
    const stageSkipped = !!(stage.skipIf && stage.skipIf(job));
    const requiredChecklist = stage.checklist.filter((c) => !c.optional);
    const doneCount = requiredChecklist.filter((c) => isChecklistEntrySatisfied(job, stage.key, c)).length;
    const isOpen = expandedStages.has(stage.key);
    const mark = state === "completed" ? "✓" : idx + 1;

    const checklistHtml = stage.checklist
      .map((c) => {
        if (c.type === "group") {
          const groupState = job.stageChecklists?.[stage.key]?.[c.key] || {};
          const optionsHtml = c.options
            .map((o) => {
              const checked = groupState[o.key] ? "checked" : "";
              return `<label><input type="checkbox" data-stage="${stage.key}" data-group="${c.key}" data-option="${o.key}" ${checked} /> ${escapeHtml(o.label)}</label>`;
            })
            .join("");
          return `<div class="stage-checklist-group">
            <div class="stage-checklist-group-label">${escapeHtml(c.label)} <span class="stage-hint">(at least one)</span></div>
            <div class="stage-checklist-group-options">${optionsHtml}</div>
          </div>`;
        }
        if (c.type === "subsection") {
          const subState = job.stageChecklists?.[stage.key]?.[c.key] || {};
          const itemsHtml = c.items
            .map((i) => {
              const checked = subState[i.key] ? "checked" : "";
              const hint = i.optional ? '<span class="stage-hint">(optional)</span>' : "";
              return `<label><input type="checkbox" data-stage="${stage.key}" data-group="${c.key}" data-option="${i.key}" ${checked} /> ${escapeHtml(i.label)} ${hint}</label>`;
            })
            .join("");
          const tf = c.textField;
          const showText = tf && (!tf.showIf || tf.showIf(job));
          const textHtml = showText
            ? `<label>${escapeHtml(tf.label)} <input type="text" data-field="${tf.key}" value="${escapeHtml(job[tf.key] || "")}" /></label>`
            : "";
          return `<div class="stage-checklist-group">
            <div class="stage-checklist-group-label">${escapeHtml(c.label)}</div>
            <div class="stage-checklist-group-options">${itemsHtml}</div>
            ${textHtml}
          </div>`;
        }
        const itemSkipped = !!(c.skipIf && c.skipIf(job));
        const checked = job.stageChecklists?.[stage.key]?.[c.key] ? "checked" : "";
        const hint = c.optional
          ? '<span class="stage-hint">(optional)</span>'
          : itemSkipped
          ? '<span class="stage-hint">(not applicable)</span>'
          : "";
        return `<label class="${itemSkipped ? "stage-item-skipped" : ""}"><input type="checkbox" data-stage="${stage.key}" data-item="${c.key}" ${checked} /> ${escapeHtml(c.label)} ${hint}</label>`;
      })
      .join("");

    const materialItemsHtml = stage.key === "material_ordered" ? renderMaterialItemsHtml(job) : "";
    const actualHoursHtml = stage.key === "actual_hours" ? renderActualHoursStageHtml(job) : "";

    const fieldsHtml = stage.fields
      .map((f) => {
        const value = job[f.key] ?? "";
        if (f.readonly) {
          return `<label>${escapeHtml(f.label)}<span class="readonly-field">${escapeHtml(value) || "—"}</span></label>`;
        }
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
        ${
          stageSkipped
            ? '<span class="stage-progress">not needed</span>'
            : stage.progressText
            ? stage.progressText(job)
              ? `<span class="stage-progress">${stage.progressText(job)}</span>`
              : ""
            : requiredChecklist.length
            ? `<span class="stage-progress">${doneCount}/${requiredChecklist.length}</span>`
            : ""
        }
        <span class="stage-caret">${isOpen ? "▾" : "▸"}</span>
      </div>
      <div class="stage-body ${isOpen ? "" : "collapsed"} ${stageSkipped ? "stage-body-skipped" : ""}">
        ${stageSkipped ? `<p class="stage-hint">${escapeHtml(stage.skipMessage || "Not needed for this job.")}</p>` : ""}
        ${checklistHtml ? `<div class="stage-checklist">${checklistHtml}</div>` : ""}
        ${materialItemsHtml}
        ${actualHoursHtml}
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
      const { stage, item, group, option } = e.target.dataset;
      const path = group ? `stageChecklists.${stage}.${group}.${option}` : `stageChecklists.${stage}.${item}`;
      updateDoc(jobRef(), { [path]: e.target.checked, updatedAt: serverTimestamp() }).catch(showError);
    })
  );

  $all(".stage-body input[data-field]").forEach((input) =>
    input.addEventListener("change", (e) => saveField(e.target.dataset.field, e.target.value))
  );

  function advanceFromCurrentStage() {
    const nextStage = STAGE_DEFS[currentIdx + 1];
    if (!nextStage) return;
    const currentStage = STAGE_DEFS[currentIdx];
    const extraFields = {};
    (AUTOFILL_ON_ADVANCE[currentStage.key] || []).forEach((fieldKey) => {
      if (!job[fieldKey]) extraFields[fieldKey] = toISODate(new Date());
    });
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

  $all(".material-item-form").forEach((form) =>
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const qty = form.querySelector(".mi-input-qty").value;
      const spec = form.querySelector(".mi-input-spec").value.trim();
      const size = form.querySelector(".mi-input-size").value.trim();
      if (!spec && !size) return;
      const items = [...(currentJobData?.materialItems || []), { qty: qty ? Number(qty) : "", spec, size }];
      saveField("materialItems", items);
    })
  );
  $all(".material-item-delete").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const i = Number(e.target.closest(".material-item-row").dataset.index);
      const items = [...(currentJobData?.materialItems || [])];
      items.splice(i, 1);
      saveField("materialItems", items);
    })
  );

  $all(".actual-hours-input").forEach((input) =>
    input.addEventListener("change", (e) => {
      const i = Number(e.target.closest("tr").dataset.index);
      const ops = [...(currentJobData?.operations || [])];
      ops[i] = { ...ops[i], actualHours: e.target.value ? Number(e.target.value) : "" };
      saveField("operations", ops);
    })
  );
}

// Material Ordered's repeatable list of {qty, spec, size} line items -- e.g.
// "2 x 4140, 35mm dia x 150mm long round bar" -- rendered inline in that
// stage rather than as simple single-value fields.
function renderMaterialItemsHtml(job) {
  const items = job.materialItems || [];
  const rows = items
    .map(
      (m, i) => `
      <div class="material-item-row" data-index="${i}">
        <span class="mi-qty">${escapeHtml(m.qty ? `${m.qty} x` : "")}</span>
        <span class="mi-spec">${escapeHtml(m.spec || "")}</span>
        <span class="mi-size">${escapeHtml(m.size || "")}</span>
        <button type="button" class="material-item-delete no-print">Remove</button>
      </div>`
    )
    .join("");

  return `<div class="material-items">
    <div class="stage-checklist-group-label">Material needed</div>
    <div class="material-items-list">${rows || '<p class="stage-hint">No material items added yet.</p>'}</div>
    <form class="inline-form material-item-form no-print">
      <input type="number" min="1" step="1" class="mi-input-qty" placeholder="Qty" style="width:5em" />
      <input type="text" class="mi-input-spec" placeholder="Material (e.g. 4140)" />
      <input type="text" class="mi-input-size" placeholder="Size / description (e.g. 35mm dia x 150mm long round bar)" />
      <button type="submit">Add material</button>
    </form>
  </div>`;
}

// Actual Hours stage: one row per operation, entered once work is done --
// this is what feeds future Reference Class Forecasting quoting.
function renderActualHoursStageHtml(job) {
  const ops = job.operations || [];
  if (!ops.length) {
    return `<p class="stage-hint">No operations on this job yet — add them in the Operations section below.</p>`;
  }
  const rows = ops
    .map(
      (op, i) => `
      <tr data-index="${i}">
        <td>${escapeHtml(op.name)}</td>
        <td>${escapeHtml(op.expectedHours || "")}</td>
        <td><input type="number" step="0.1" min="0" class="actual-hours-input" value="${escapeHtml(op.actualHours ?? "")}" /></td>
      </tr>`
    )
    .join("");
  const total = ops.reduce((sum, op) => sum + (Number(op.actualHours) || 0), 0);
  return `
    <table class="data-table">
      <thead><tr><th>Operation</th><th>Expected hrs</th><th>Actual hrs</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${total ? `<p class="stage-hint">${total.toFixed(1)} hrs total</p>` : ""}
  `;
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
        <span class="op-expected-hours">${op.expectedHours ? `${op.expectedHours} hrs (est.)` : ""}</span>
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
  const expectedHours = $("#op-expected-hours").value ? Number($("#op-expected-hours").value) : "";
  if (!name) return;
  const ops = [...(currentJobData?.operations || []), { name, notes, done: false, expectedHours, actualHours: "" }];
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
