// mikrotik-gate — dashboard (bozza)
// Nessuna dipendenza esterna: fetch + DOM puro.

const LS_BASE_URL = "mikrotik-gate.baseUrl";
const LS_API_KEY = "mikrotik-gate.apiKey";

const state = {
  baseUrl: localStorage.getItem(LS_BASE_URL) || "",
  apiKey: localStorage.getItem(LS_API_KEY) || "",
};

// ---------- utility ----------

function toast(message, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast" + (kind ? " toast-" + kind : "");
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

function setConnStatus(status, text) {
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connText");
  dot.className = "dot dot-" + status;
  label.textContent = text;
}

async function api(path, options = {}) {
  const url = (state.baseUrl || "") + path;
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    state.apiKey ? { "X-API-Key": state.apiKey } : {},
    options.headers || {}
  );
  let resp;
  try {
    resp = await fetch(url, { ...options, headers });
  } catch (err) {
    setConnStatus("error", "non raggiungibile");
    throw new Error("Impossibile contattare il servizio: " + err.message);
  }
  if (resp.status === 401) {
    setConnStatus("error", "API key non valida");
    throw new Error("API key non valida (401)");
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

// ---------- settings modal ----------

const modal = document.getElementById("settingsModal");
document.getElementById("btnSettings").addEventListener("click", () => {
  document.getElementById("cfgBaseUrl").value = state.baseUrl;
  document.getElementById("cfgApiKey").value = state.apiKey;
  modal.classList.remove("hidden");
});
document.getElementById("cfgCancel").addEventListener("click", () => modal.classList.add("hidden"));
document.getElementById("cfgSave").addEventListener("click", async () => {
  state.baseUrl = document.getElementById("cfgBaseUrl").value.trim().replace(/\/$/, "");
  state.apiKey = document.getElementById("cfgApiKey").value.trim();
  localStorage.setItem(LS_BASE_URL, state.baseUrl);
  localStorage.setItem(LS_API_KEY, state.apiKey);
  modal.classList.add("hidden");
  await checkHealth();
  loadInterfaces();
});

async function checkHealth() {
  try {
    const url = (state.baseUrl || "") + "/health";
    const resp = await fetch(url);
    if (resp.ok) {
      setConnStatus("ok", "connesso");
    } else {
      setConnStatus("error", "servizio non raggiungibile");
    }
  } catch (err) {
    setConnStatus("error", "servizio non raggiungibile");
  }
}

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

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

(async function init() {
  if (!state.apiKey) {
    setConnStatus("unknown", "configura la connessione");
    modal.classList.remove("hidden");
    document.getElementById("cfgBaseUrl").value = state.baseUrl;
    return;
  }
  await checkHealth();
  loadInterfaces();
})();
