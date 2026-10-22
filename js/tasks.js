import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---------- Due-status logic (same model as js/equipment.js) ----------

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addInterval(isoDate, value, unit) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const n = Number(value) || 0;
  if (unit === "days") date.setDate(date.getDate() + n);
  else if (unit === "weeks") date.setDate(date.getDate() + n * 7);
  else date.setMonth(date.getMonth() + n); // months (default)
  return date;
}

// Returns { status: "overdue" | "due-soon" | "ok", nextDueIso }
function dueStatus(task) {
  const nextDueIso = task.nextDue;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = nextDueIso.split("-").map(Number);
  const daysUntil = Math.round((new Date(y, m - 1, d) - today) / (24 * 60 * 60 * 1000));
  if (daysUntil < 0) return { status: "overdue", nextDueIso };
  if (daysUntil <= 7) return { status: "due-soon", nextDueIso };
  return { status: "ok", nextDueIso };
}

const STATUS_LABELS = { overdue: "Overdue", "due-soon": "Due soon", ok: "OK" };

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

let unsubTasks = null;
let tasks = [];

onAuthStateChanged(auth, (user) => {
  if (user) {
    $("#view-login").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");
    unsubTasks = onSnapshot(
      collection(db, "tasks"),
      (snap) => {
        tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderTaskList();
      },
      showError
    );
  } else {
    $("#app-shell").classList.add("hidden");
    $("#view-login").classList.remove("hidden");
    if (unsubTasks) unsubTasks();
  }
});

// ---------- Add task ----------

$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "tasks"), {
      name: $("#task-name").value.trim(),
      notes: $("#task-notes").value.trim(),
      nextDue: $("#task-next-due").value,
      recurring: $("#task-recurring").checked,
      intervalValue: Number($("#task-interval-value").value) || 1,
      intervalUnit: $("#task-interval-unit").value,
      lastDone: "",
      active: true,
      createdAt: serverTimestamp(),
    });
    $("#task-form").reset();
    $("#task-interval-value").value = 3;
  } catch (err) {
    showError(err);
  }
});

// ---------- Actions ----------

async function markDone(task) {
  try {
    if (task.recurring) {
      const nextDue = toISODate(addInterval(task.nextDue, task.intervalValue, task.intervalUnit));
      await updateDoc(doc(db, "tasks", task.id), { lastDone: toISODate(new Date()), nextDue });
    } else {
      await updateDoc(doc(db, "tasks", task.id), { lastDone: toISODate(new Date()), active: false });
    }
  } catch (err) {
    showError(err);
  }
}

async function reactivate(task) {
  try {
    await updateDoc(doc(db, "tasks", task.id), { active: true });
  } catch (err) {
    showError(err);
  }
}

async function removeTask(task) {
  if (!window.confirm(`Delete "${task.name}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "tasks", task.id));
  } catch (err) {
    showError(err);
  }
}

// ---------- Render ----------

function taskRowHtml(task, { completed }) {
  const { status } = completed ? { status: null } : dueStatus(task);
  const badge = completed
    ? `<span class="due-badge">Done ${escapeHtml(task.lastDone || "")}</span>`
    : `<span class="due-badge due-${status}">${STATUS_LABELS[status]} (${escapeHtml(task.nextDue)})</span>`;
  const recurText = task.recurring ? `Every ${escapeHtml(task.intervalValue)} ${escapeHtml(task.intervalUnit)}` : "One-off";

  return `<div class="task-row" data-id="${task.id}">
    <div class="task-row-main">
      <div class="task-row-name">${escapeHtml(task.name)}</div>
      ${task.notes ? `<div class="task-row-notes">${escapeHtml(task.notes)}</div>` : ""}
      <div class="field-hint">${recurText}</div>
    </div>
    ${badge}
    <div class="task-row-actions no-print">
      ${completed ? `<button type="button" class="task-reactivate">Reactivate</button>` : `<button type="button" class="task-done">Mark done</button>`}
      <button type="button" class="task-remove">Delete</button>
    </div>
  </div>`;
}

function renderTaskList() {
  const active = tasks.filter((t) => t.active !== false).sort((a, b) => (a.nextDue || "").localeCompare(b.nextDue || ""));
  const completed = tasks.filter((t) => t.active === false).sort((a, b) => (b.lastDone || "").localeCompare(a.lastDone || ""));

  $("#task-list").innerHTML = active.length
    ? active.map((t) => taskRowHtml(t, { completed: false })).join("")
    : `<p class="stage-hint">No tasks added yet.</p>`;

  $("#task-completed-heading").classList.toggle("hidden", !completed.length);
  $("#task-completed-list").innerHTML = completed.map((t) => taskRowHtml(t, { completed: true })).join("");

  $all(".task-done").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const task = tasks.find((t) => t.id === e.target.closest(".task-row").dataset.id);
      if (task) markDone(task);
    })
  );
  $all(".task-reactivate").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const task = tasks.find((t) => t.id === e.target.closest(".task-row").dataset.id);
      if (task) reactivate(task);
    })
  );
  $all(".task-remove").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const task = tasks.find((t) => t.id === e.target.closest(".task-row").dataset.id);
      if (task) removeTask(task);
    })
  );
}
