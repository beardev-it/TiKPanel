// mikrotik-gate — dashboard (bozza)
// Nessuna dipendenza esterna: fetch + DOM puro.
//
// Autenticazione: login con le credenziali RouterOS dell'utente (verificate
// dal server in tempo reale contro RouterOS stesso), poi si usa un token di
// sessione (JWT) firmato dal server. Nessuna password viene mai salvata nel
// browser: solo il token, che scade da solo dopo qualche ora.

const LS_TOKEN = "mikrotik-gate.token";
const LS_USERNAME = "mikrotik-gate.username";

const state = {
  baseUrl: "", // caricato da /ui-config all'avvio, non richiesto all'utente
  token: localStorage.getItem(LS_TOKEN) || "",
  username: localStorage.getItem(LS_USERNAME) || "",
};

// ---------- utility ----------

function toast(message, kind = "") {
  const box = document.getElementById("toast");
  box.textContent = message;
  box.className = "toast" + (kind ? " toast-" + kind : "");
  box.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => box.classList.add("hidden"), 3500);
}

function setConnStatus(status, text) {
  document.getElementById("connDot").className = "dot dot-" + status;
  document.getElementById("connText").textContent = text;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) node.appendChild(c);
  return node;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------- chiamate API ----------

async function api(path, options = {}) {
  const url = (state.baseUrl || "") + path;
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    state.token ? { Authorization: "Bearer " + state.token } : {},
    options.headers || {}
  );
  let resp;
  try {
    resp = await fetch(url, { ...options, headers });
  } catch (err) {
    setConnStatus("error", "servizio non raggiungibile");
    throw new Error("Impossibile contattare il servizio: " + err.message);
  }
  if (resp.status === 401) {
    logout("sessione scaduta, effettua di nuovo il login");
    throw new Error("Sessione scaduta");
  }
  if (!resp.ok) {
    let detail = "";
    try {
      const body = await resp.json();
      detail = body.error || body.detail || JSON.stringify(body);
    } catch (_) {
      detail = resp.statusText;
    }
    throw new Error(`Errore ${resp.status}: ${detail}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

// ---------- login / logout ----------

function showLogin() {
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("userBadge").classList.add("hidden");
  document.getElementById("btnLogout").classList.add("hidden");
  setConnStatus("unknown", "non connesso");
}

function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  const badge = document.getElementById("userBadge");
  badge.textContent = state.username;
  badge.classList.remove("hidden");
  document.getElementById("btnLogout").classList.remove("hidden");
}

function logout(message) {
  state.token = "";
  state.username = "";
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USERNAME);
  showLogin();
  if (message) toast(message, "error");
}

document.getElementById("btnLogout").addEventListener("click", () => logout());

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorBox = document.getElementById("loginError");
  errorBox.classList.add("hidden");

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Accesso in corso…";

  try {
    const url = (state.baseUrl || "") + "/auth/login";
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `Errore ${resp.status}`);
    }
    const data = await resp.json();
    state.token = data.access_token;
    state.username = data.username;
    localStorage.setItem(LS_TOKEN, state.token);
    localStorage.setItem(LS_USERNAME, state.username);
    document.getElementById("loginPassword").value = "";
    setConnStatus("ok", "connesso");
    showApp();
    loadInterfaces();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Accedi";
  }
});

// ---------- tabs ----------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "interfaces") loadInterfaces();
    if (tab.dataset.tab === "vlans") loadVlans();
    if (tab.dataset.tab === "clients") loadClients();
  });
});

// ---------- interfacce ----------

async function loadInterfaces() {
  const body = document.getElementById("interfacesBody");
  body.innerHTML = `<tr><td colspan="6" class="empty">Caricamento…</td></tr>`;
  try {
    const data = await api("/interfaces");
    if (!data.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">Nessuna interfaccia trovata</td></tr>`;
      return;
    }
    body.innerHTML = "";
    for (const iface of data) {
      const statusBadge = el("span", {
        class: "badge " + (iface.disabled ? "badge-off" : "badge-ok"),
        text: iface.disabled ? "disabilitata" : "abilitata",
      });
      const runningBadge = el("span", {
        class: "badge " + (iface.running ? "badge-ok" : "badge-off"),
        text: iface.running ? "up" : "down",
      });
      const toggleBtn = el("button", {
        class: "btn btn-sm " + (iface.disabled ? "btn-primary" : "btn-warn"),
        text: iface.disabled ? "Abilita" : "Disabilita",
        onclick: () => toggleInterface(iface.name, !iface.disabled),
      });
      body.appendChild(
        el("tr", {}, [
          el("td", { text: iface.name }),
          el("td", { text: iface.type || "—" }),
          el("td", {}, [statusBadge]),
          el("td", {}, [runningBadge]),
          el("td", { text: iface.comment || "" }),
          el("td", {}, [toggleBtn]),
        ])
      );
    }
    setConnStatus("ok", "connesso");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function toggleInterface(name, disabled) {
  try {
    await api(`/interfaces/${encodeURIComponent(name)}/state`, {
      method: "PUT",
      body: JSON.stringify({ disabled }),
    });
    toast(`Interfaccia ${name} ${disabled ? "disabilitata" : "abilitata"}`, "ok");
    loadInterfaces();
  } catch (err) {
    toast(err.message, "error");
  }
}

document.getElementById("refreshInterfaces").addEventListener("click", loadInterfaces);

// ---------- VLAN ----------

async function loadVlans() {
  const body = document.getElementById("vlansBody");
  body.innerHTML = `<tr><td colspan="6" class="empty">Caricamento…</td></tr>`;
  try {
    const data = await api("/vlans");
    if (!data.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">Nessuna VLAN configurata</td></tr>`;
      return;
    }
    body.innerHTML = "";
    for (const vlan of data) {
      const statusBadge = el("span", {
        class: "badge " + (vlan.disabled ? "badge-off" : "badge-ok"),
        text: vlan.disabled ? "disabilitata" : "abilitata",
      });
      const deleteBtn = el("button", {
        class: "btn btn-sm btn-danger",
        text: "Elimina",
        onclick: () => deleteVlan(vlan.name),
      });
      body.appendChild(
        el("tr", {}, [
          el("td", { text: vlan.name }),
          el("td", { text: String(vlan.vlan_id ?? "—") }),
          el("td", { text: vlan.interface || "—" }),
          el("td", {}, [statusBadge]),
          el("td", { text: vlan.comment || "" }),
          el("td", {}, [deleteBtn]),
        ])
      );
    }
    setConnStatus("ok", "connesso");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function deleteVlan(name) {
  if (!confirm(`Eliminare la VLAN "${name}"?`)) return;
  try {
    await api(`/vlans/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast(`VLAN ${name} eliminata`, "ok");
    loadVlans();
  } catch (err) {
    toast(err.message, "error");
  }
}

document.getElementById("vlanCreateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    name: form.name.value.trim(),
    vlan_id: Number(form.vlan_id.value),
    interface: form.interface.value.trim(),
  };
  if (form.comment.value.trim()) payload.comment = form.comment.value.trim();
  try {
    await api("/vlans", { method: "POST", body: JSON.stringify(payload) });
    toast(`VLAN ${payload.name} creata`, "ok");
    form.reset();
    loadVlans();
  } catch (err) {
    toast(err.message, "error");
  }
});

document.getElementById("refreshVlans").addEventListener("click", loadVlans);

// ---------- client ----------

async function loadClients() {
  const body = document.getElementById("clientsBody");
  body.innerHTML = `<tr><td colspan="6" class="empty">Caricamento…</td></tr>`;
  try {
    const data = await api("/clients");
    if (!data.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">Nessun client rilevato</td></tr>`;
      return;
    }
    body.innerHTML = "";
    for (const client of data) {
      const blockedBadge = el("span", {
        class: "badge " + (client.blocked ? "badge-danger" : "badge-ok"),
        text: client.blocked ? "bloccato" : "libero",
      });
      const blockBtn = el("button", {
        class: "btn btn-sm " + (client.blocked ? "btn-primary" : "btn-warn"),
        text: client.blocked ? "Sblocca" : "Blocca",
        onclick: () => (client.blocked ? unblockClient(client) : blockClient(client)),
      });
      const disconnectBtn = el("button", {
        class: "btn btn-sm btn-danger",
        text: "Disconnetti",
        onclick: () => disconnectClient(client),
      });
      body.appendChild(
        el("tr", {}, [
          el("td", { text: client.mac_address }),
          el("td", { text: client.ip_address || "—" }),
          el("td", { text: client.hostname || "—" }),
          el("td", { text: client.connection || "cablato" }),
          el("td", {}, [blockedBadge]),
          el("td", {}, [blockBtn, disconnectBtn]),
        ])
      );
    }
    setConnStatus("ok", "connesso");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function blockClient(client) {
  try {
    await api("/clients/block", {
      method: "POST",
      body: JSON.stringify({ mac_address: client.mac_address, ip_address: client.ip_address }),
    });
    toast(`Client ${client.mac_address} bloccato`, "ok");
    loadClients();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function unblockClient(client) {
  try {
    await api("/clients/unblock", {
      method: "POST",
      body: JSON.stringify({ mac_address: client.mac_address, ip_address: client.ip_address }),
    });
    toast(`Client ${client.mac_address} sbloccato`, "ok");
    loadClients();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function disconnectClient(client) {
  if (!confirm(`Forzare la disconnessione di ${client.mac_address}?`)) return;
  try {
    const res = await api("/clients/disconnect", {
      method: "POST",
      body: JSON.stringify({ mac_address: client.mac_address }),
    });
    toast((res.actions || []).join("; ") || "Disconnessione richiesta", "ok");
    loadClients();
  } catch (err) {
    toast(err.message, "error");
  }
}

document.getElementById("refreshClients").addEventListener("click", loadClients);

// ---------- avvio ----------

async function loadUiConfig() {
  try {
    const resp = await fetch("/ui-config");
    if (resp.ok) {
      const data = await resp.json();
      state.baseUrl = data.apiBaseUrl || "";
    }
  } catch (_) {
    // se /ui-config non è raggiungibile si resta sulla stessa origine (default)
  }
}

async function validateExistingSession() {
  try {
    const resp = await fetch((state.baseUrl || "") + "/auth/me", {
      headers: { Authorization: "Bearer " + state.token },
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.auth === "session" && data.username === state.username;
  } catch (_) {
    return false;
  }
}

(async function init() {
  await loadUiConfig();

  if (state.token && state.username) {
    const valid = await validateExistingSession();
    if (valid) {
      setConnStatus("ok", "connesso");
      showApp();
      loadInterfaces();
      return;
    }
    // sessione scaduta o non valida: torna al login senza allarmare l'utente
    state.token = "";
    state.username = "";
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USERNAME);
  }
  showLogin();
})();
