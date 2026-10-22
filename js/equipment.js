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

// ---------- Due-status logic ----------

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

// The due date is a plain stored field (set directly when the task is
// created, advanced when marked done) rather than always recomputed from
// lastDone -- so every task has a date to show, including ones that have
// never been done yet. lastDone is kept only as a record of when it was
// last actually done, not used to derive the due date.
// Falls back to the old lastDone+interval computation for any task saved
// before this field existed.
function effectiveNextDue(task) {
  if (task.nextDue) return task.nextDue;
  if (task.lastDone) return toISODate(addInterval(task.lastDone, task.intervalValue, task.intervalUnit));
  return "";
}

// Returns { status: "never" | "overdue" | "due-soon" | "ok", nextDueIso }
function dueStatus(task) {
  const nextDueIso = effectiveNextDue(task);
  if (!nextDueIso) return { status: "never", nextDueIso: "" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = nextDueIso.split("-").map(Number);
  const daysUntil = Math.round((new Date(y, m - 1, d) - today) / (24 * 60 * 60 * 1000));
  if (daysUntil < 0) return { status: "overdue", nextDueIso };
  if (daysUntil <= 7) return { status: "due-soon", nextDueIso };
  return { status: "ok", nextDueIso };
}

const STATUS_LABELS = { never: "No due date set", overdue: "Overdue", "due-soon": "Due soon", ok: "OK" };

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

let unsubEquipment = null;
let equipment = [];

onAuthStateChanged(auth, (user) => {
  if (user) {
    $("#view-login").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");
    unsubEquipment = onSnapshot(collection(db, "equipment"), (snap) => {
      equipment = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      equipment.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      renderEquipmentList();
    }, showError);
  } else {
    $("#app-shell").classList.add("hidden");
    $("#view-login").classList.remove("hidden");
    if (unsubEquipment) unsubEquipment();
  }
});

// ---------- Add equipment ----------

$("#equipment-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "equipment"), {
      name: $("#eq-name").value.trim(),
      type: $("#eq-type").value.trim(),
      notes: "",
      active: true,
      tasks: [],
      createdAt: serverTimestamp(),
    });
    $("#equipment-form").reset();
  } catch (err) {
    showError(err);
  }
});

// ---------- Render ----------

function renderEquipmentList() {
  $("#equipment-list").innerHTML = equipment.length
    ? equipment.map(equipmentCardHtml).join("")
    : `<p class="stage-hint">No equipment added yet.</p>`;

  $all(".equipment-delete").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest(".equipment-card").dataset.id;
      const eq = equipment.find((x) => x.id === id);
      if (!eq) return;
      if (!window.confirm(`Delete "${eq.name}" and all its maintenance tasks? This cannot be undone.`)) return;
      try {
        await deleteDoc(doc(db, "equipment", id));
      } catch (err) {
        showError(err);
      }
    })
  );

  $all(".task-form").forEach((form) =>
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const eqId = form.dataset.eqId;
      const eq = equipment.find((x) => x.id === eqId);
      if (!eq) return;
      const name = form.querySelector(".task-name").value.trim();
      const intervalValue = Number(form.querySelector(".task-interval-value").value) || 1;
      const intervalUnit = form.querySelector(".task-interval-unit").value;
      const nextDue = form.querySelector(".task-next-due").value;
      if (!name || !nextDue) return;
      const tasks = [...(eq.tasks || []), { name, intervalValue, intervalUnit, nextDue, lastDone: "", notes: "" }];
      try {
        await updateDoc(doc(db, "equipment", eqId), { tasks });
        form.reset();
      } catch (err) {
        showError(err);
      }
    })
  );

  $all(".task-done").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const eqId = e.target.closest(".equipment-card").dataset.id;
      const i = Number(e.target.closest("tr").dataset.index);
      const eq = equipment.find((x) => x.id === eqId);
      if (!eq) return;
      const tasks = [...(eq.tasks || [])];
      const task = tasks[i];
      // Advance from the previous due date (not from today) so the
      // schedule stays on a consistent cadence rather than drifting
      // earlier/later depending on exactly when it got marked done.
      const base = effectiveNextDue(task) || toISODate(new Date());
      tasks[i] = { ...task, lastDone: toISODate(new Date()), nextDue: toISODate(addInterval(base, task.intervalValue, task.intervalUnit)) };
      try {
        await updateDoc(doc(db, "equipment", eqId), { tasks });
      } catch (err) {
        showError(err);
      }
    })
  );

  $all(".task-delete").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const eqId = e.target.closest(".equipment-card").dataset.id;
      const i = Number(e.target.closest("tr").dataset.index);
      const eq = equipment.find((x) => x.id === eqId);
      if (!eq) return;
      const tasks = [...(eq.tasks || [])];
      tasks.splice(i, 1);
      try {
        await updateDoc(doc(db, "equipment", eqId), { tasks });
      } catch (err) {
        showError(err);
      }
    })
  );
}

function equipmentCardHtml(eq) {
  const tasks = eq.tasks || [];
  const rows = tasks.length
    ? tasks
        .map((t, i) => {
          const { status, nextDueIso } = dueStatus(t);
          return `<tr data-index="${i}">
            <td>${escapeHtml(t.name)}</td>
            <td>Every ${escapeHtml(t.intervalValue)} ${escapeHtml(t.intervalUnit)}</td>
            <td>${escapeHtml(t.lastDone || "Never")}</td>
            <td><span class="due-badge due-${status}">${STATUS_LABELS[status]}${nextDueIso ? ` (${nextDueIso})` : ""}</span></td>
            <td class="no-print">
              <button type="button" class="task-done">Mark done</button>
              <button type="button" class="task-delete">Remove</button>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5">No maintenance tasks yet.</td></tr>`;

  return `<div class="equipment-card" data-id="${eq.id}">
    <div class="equipment-card-header">
      <h3>${escapeHtml(eq.name)}</h3>
      <span class="field-hint">${escapeHtml(eq.type || "")}</span>
      <button type="button" class="equipment-delete btn-danger no-print">Delete equipment</button>
    </div>
    <table class="data-table">
      <thead><tr><th>Task</th><th>Interval</th><th>Last done</th><th>Status</th><th class="no-print"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <form class="inline-form task-form no-print" data-eq-id="${eq.id}">
      <input type="text" class="task-name" placeholder="Task (e.g. Change way oil)" required />
      <input type="number" min="1" class="task-interval-value" placeholder="Every" style="width:5em" required value="3" />
      <select class="task-interval-unit">
        <option value="days">days</option>
        <option value="weeks">weeks</option>
        <option value="months" selected>months</option>
      </select>
      <label class="task-next-due-label">First due <input type="date" class="task-next-due" required /></label>
      <button type="submit">Add task</button>
    </form>
  </div>`;
}
