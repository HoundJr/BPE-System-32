import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, deleteDoc,
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

let unsubSops = null;
let sops = [];

onAuthStateChanged(auth, (user) => {
  if (user) {
    $("#view-login").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");
    unsubSops = onSnapshot(
      collection(db, "sops"),
      (snap) => {
        sops = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderSopList();
      },
      showError
    );
  } else {
    $("#app-shell").classList.add("hidden");
    $("#view-login").classList.remove("hidden");
    if (unsubSops) unsubSops();
  }
});

// ---------- Add entry ----------

$("#sop-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "sops"), {
      title: $("#sop-title").value.trim(),
      category: $("#sop-category").value.trim(),
      description: $("#sop-description").value.trim(),
      url: $("#sop-url").value.trim(),
      createdAt: serverTimestamp(),
    });
    $("#sop-form").reset();
  } catch (err) {
    showError(err);
  }
});

// ---------- Render ----------

function renderSopList() {
  if (!sops.length) {
    $("#sop-list").innerHTML = `<p class="stage-hint">No procedures added yet.</p>`;
    return;
  }

  const groups = {};
  sops.forEach((s) => {
    const key = s.category || "Uncategorized";
    (groups[key] = groups[key] || []).push(s);
  });

  const categoryNames = Object.keys(groups).sort((a, b) => {
    if (a === "Uncategorized") return 1;
    if (b === "Uncategorized") return -1;
    return a.localeCompare(b);
  });

  $("#sop-list").innerHTML = categoryNames
    .map((cat) => {
      const entries = groups[cat]
        .slice()
        .sort((a, b) => (a.title || "").localeCompare(b.title || ""))
        .map(
          (s) => `<div class="sop-entry" data-id="${s.id}">
            <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" class="sop-title">${escapeHtml(s.title)}</a>
            ${s.description ? `<div class="sop-description">${escapeHtml(s.description)}</div>` : ""}
            <button type="button" class="sop-delete no-print">Remove</button>
          </div>`
        )
        .join("");
      return `<div class="sop-category">
        <h3>${escapeHtml(cat)}</h3>
        ${entries}
      </div>`;
    })
    .join("");

  $all(".sop-delete").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest(".sop-entry").dataset.id;
      const sop = sops.find((s) => s.id === id);
      if (!sop) return;
      if (!window.confirm(`Remove "${sop.title}" from the Recipe Book? (The Google Doc itself is not affected.)`)) return;
      try {
        await deleteDoc(doc(db, "sops", id));
      } catch (err) {
        showError(err);
      }
    })
  );
}
