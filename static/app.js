// TiKPanel — dashboard (bozza)
// Nessuna dipendenza esterna: fetch + DOM puro.
//
// Autenticazione: login con le credenziali RouterOS dell'utente (verificate
// dal server in tempo reale contro RouterOS stesso), poi si usa un token di
// sessione (JWT) firmato dal server. Nessuna password viene mai salvata nel
// browser: solo il token, che scade da solo dopo qualche ora.

const LS_TOKEN = "tikpanel.token";
const LS_USERNAME = "tikpanel.username";
const LS_THEME = "tikpanel.theme";

const state = {
  baseUrl: "", // caricato da /ui-config all'avvio, non richiesto all'utente
  token: localStorage.getItem(LS_TOKEN) || "",
  username: localStorage.getItem(LS_USERNAME) || "",
};

// ---------- tema chiaro/scuro ----------

function applyTheme(theme) {
  // theme: "light" | "dark". Nessun valore salvato = segue le preferenze di sistema
  // (gestito via prefers-color-scheme in CSS), qui invece è una scelta esplicita.
  document.documentElement.setAttribute("data-theme", theme);
}

function initTheme() {
  const saved = localStorage.getItem(LS_THEME);
  if (saved === "light" || saved === "dark") {
    applyTheme(saved);
  }
  // se non c'è nulla di salvato, lascia decidere il CSS (prefers-color-scheme)
}

function currentTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

document.getElementById("btnTheme").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(LS_THEME, next);
});

initTheme();

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

function formatBps(bps) {
  if (!bps || bps <= 0) return "0 bps";
  const units = ["bps", "kbps", "Mbps", "Gbps"];
  let value = bps;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function trafficNode(sample) {
  if (!sample || sample.available === false) {
    return el("span", { class: "traffic unavailable", text: "n/d" });
  }
  return el("span", { class: "traffic" }, [
    el("span", { class: "tr-down", text: "↓ " + formatBps(sample.rx_bps) }),
    el("span", { class: "tr-up", text: "↑ " + formatBps(sample.tx_bps) }),
  ]);
}

// ---------- polling traffico in tempo reale ----------
// Ogni "poller" aggiorna periodicamente un placeholder DOM con il traffico corrente. Sono
// tutti fermati ad ogni cambio tab/refresh per non lasciare richieste periodiche verso
// interfacce o client che non sono più in vista.

const pollers = new Map();
const TRAFFIC_POLL_MS = 3000;

function stopAllPolling() {
  for (const id of pollers.values()) clearInterval(id);
  pollers.clear();
}

/** Crea un placeholder che un poller aggiorna sul posto (sempre lo stesso nodo, contenuto
 * sostituito ad ogni tick) invece di essere rimosso e ricreato dal DOM. */
function trafficPlaceholder() {
  return el("span", { class: "traffic unavailable", text: "…" });
}

function pollTraffic(key, fetchFn, placeholder) {
  if (pollers.has(key)) return;
  const tick = async () => {
    if (!placeholder.isConnected) {
      // il nodo non è più nel DOM (cambiata tab / ricaricata la lista): ferma il poller
      clearInterval(pollers.get(key));
      pollers.delete(key);
      return;
    }
    try {
      const sample = await fetchFn();
      const fresh = trafficNode(sample);
      placeholder.className = fresh.className;
      placeholder.replaceChildren(...fresh.childNodes);
    } catch (_) {
      // silenzioso: un singolo poll fallito non deve riempire di toast la UI
    }
  };
  tick();
  pollers.set(key, setInterval(tick, TRAFFIC_POLL_MS));
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
    stopAllPolling();
    if (tab.dataset.tab === "interfaces") loadInterfaces();
    if (tab.dataset.tab === "vlans") loadVlans();
    if (tab.dataset.tab === "wifi") loadClientsAndNetworks();
  });
});

// ---------- interfacce ----------

async function loadInterfaces() {
  stopAllPolling();
  const body = document.getElementById("interfacesBody");
  body.innerHTML = `<tr><td colspan="7" class="empty">Caricamento…</td></tr>`;
  try {
    const data = await api("/interfaces");
    if (!data.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty">Nessuna interfaccia trovata</td></tr>`;
      return;
    }
    body.innerHTML = "";
    for (const iface of data) {
      const statusBadge = el("span", {
        class: "badge " + (iface.disabled ? "badge-down" : "badge-up"),
        text: iface.disabled ? "disabilitata" : "abilitata",
      });
      const runningBadge = el("span", {
        class: "badge " + (iface.running ? "badge-up" : "badge-down"),
        text: iface.running ? "up" : "down",
      });
      const toggleBtn = el("button", {
        // verde/rosso riflette lo stato attuale della rete (up/down), non l'azione del pulsante
        class: "btn btn-sm " + (iface.running ? "btn-up" : "btn-down"),
        text: iface.disabled ? "Abilita" : "Disabilita",
        onclick: () => toggleInterface(iface.name, !iface.disabled),
      });
      const trafficCell = trafficPlaceholder();
      body.appendChild(
        el("tr", {}, [
          el("td", { text: iface.name }),
          el("td", { text: iface.type || "—" }),
          el("td", {}, [statusBadge]),
          el("td", {}, [runningBadge]),
          el("td", {}, [trafficCell]),
          el("td", { text: iface.comment || "" }),
          el("td", {}, [toggleBtn]),
        ])
      );
      if (!iface.disabled) {
        pollTraffic(`iface:${iface.name}`, () => api(`/interfaces/${encodeURIComponent(iface.name)}/traffic`), trafficCell);
      }
    }
    setConnStatus("ok", "connesso");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function toggleInterface(name, disabled) {
  try {
    await setInterfaceDisabled(name, disabled);
    toast(`Interfaccia ${name} ${disabled ? "disabilitata" : "abilitata"}`, "ok");
    loadInterfaces();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function setInterfaceDisabled(name, disabled) {
  return api(`/interfaces/${encodeURIComponent(name)}/state`, {
    method: "PUT",
    body: JSON.stringify({ disabled }),
  });
}

document.getElementById("refreshInterfaces").addEventListener("click", loadInterfaces);

// ---------- VLAN ----------

async function loadVlans() {
  stopAllPolling();
  const body = document.getElementById("vlansBody");
  body.innerHTML = `<tr><td colspan="7" class="empty">Caricamento…</td></tr>`;
  try {
    const data = await api("/vlans");
    if (!data.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty">Nessuna VLAN configurata</td></tr>`;
      return;
    }
    body.innerHTML = "";
    for (const vlan of data) {
      const isUp = !vlan.disabled && vlan.running !== false;
      const statusBadge = el("span", {
        class: "badge " + (isUp ? "badge-up" : "badge-down"),
        text: vlan.disabled ? "disabilitata" : vlan.running === false ? "down" : "attiva",
      });
      const deleteBtn = el("button", {
        class: "btn btn-sm btn-danger",
        text: "Elimina",
        onclick: () => deleteVlan(vlan.name),
      });
      const trafficCell = trafficPlaceholder();
      body.appendChild(
        el("tr", {}, [
          el("td", { text: vlan.name }),
          el("td", { text: String(vlan.vlan_id ?? "—") }),
          el("td", { text: vlan.interface || "—" }),
          el("td", {}, [statusBadge]),
          el("td", {}, [trafficCell]),
          el("td", { text: vlan.comment || "" }),
          el("td", {}, [deleteBtn]),
        ])
      );
      if (isUp) {
        pollTraffic(`vlan:${vlan.name}`, () => api(`/interfaces/${encodeURIComponent(vlan.name)}/traffic`), trafficCell);
      }
    }
    setConnStatus("ok", "connesso");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(err.message)}</td></tr>`;
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

// ---------- client & reti WiFi (vista unificata) ----------

function formatSourceLabel(source) {
  return { wifi: "WiFi", capsman: "CAPsMAN", wireless: "Wireless", sconosciuta: "" }[source] || "";
}

// Selezioni correnti (checkbox) per le azioni di gruppo, e cache dell'ultimo caricamento
// per poter risalire da un MAC/nome rete ai dati completi quando si esegue un'azione.
const selection = {
  networks: new Set(), // nomi interfaccia radio selezionati
  clients: new Set(), // MAC selezionati, client WiFi (block/unblock/disconnetti)
  wiredClients: new Set(), // MAC selezionati, client cablati (solo block/unblock: non ha senso "disconnetterli")
};
let lastClientsByMac = new Map();
let lastNetworksByName = new Map();
let lastWiredMacs = new Set();

async function blockClient(client) {
  try {
    await api("/clients/block", {
      method: "POST",
      body: JSON.stringify({ mac_address: client.mac_address, ip_address: client.ip_address }),
    });
    toast(`Client ${client.mac_address} bloccato`, "ok");
    loadClientsAndNetworks();
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
    loadClientsAndNetworks();
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
    loadClientsAndNetworks();
  } catch (err) {
    toast(err.message, "error");
  }
}

function clientTrafficKey(client) {
  return `client:${client.mac_address}`;
}

function clientTrafficFetcher(client) {
  const iface = client.wifi_interface || client.capsman_interface || client.wireless_interface || client.arp_interface;
  return () =>
    api("/clients/traffic", {
      method: "POST",
      body: JSON.stringify({ ip_address: client.ip_address, interface: iface }),
    });
}

function buildClientCheckbox(mac, set = selection.clients, onChange = updateClientBulkBar) {
  const checkbox = el("input", { type: "checkbox" });
  checkbox.checked = set.has(mac);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) set.add(mac);
    else set.delete(mac);
    onChange();
  });
  return checkbox;
}

function buildWifiClientRow(client) {
  lastClientsByMac.set(client.mac_address, client);
  const sub = [client.hostname, client.ip_address].filter(Boolean).join(" · ");
  const trafficCell = trafficPlaceholder();
  pollTraffic(clientTrafficKey(client), clientTrafficFetcher(client), trafficCell);

  const blockBtn = el("button", {
    class: "btn btn-sm " + (client.blocked ? "btn-down" : "btn-up"),
    text: client.blocked ? "Sblocca" : "Blocca",
    onclick: () => (client.blocked ? unblockClient(client) : blockClient(client)),
  });
  const disconnectBtn = el("button", {
    class: "btn btn-sm btn-danger",
    text: "Disconnetti",
    onclick: () => disconnectClient(client),
  });

  return el("div", { class: "wifi-client-row" }, [
    el("div", { class: "wifi-client-select" }, [
      buildClientCheckbox(client.mac_address),
      el("div", { class: "wifi-client-main" }, [
        el("span", { class: "wifi-client-mac", text: client.mac_address }),
        sub ? el("span", { class: "wifi-client-sub", text: sub }) : el("span"),
      ]),
    ]),
    el("div", { class: "wifi-client-actions" }, [trafficCell, blockBtn, disconnectBtn]),
  ]);
}

function updateNetworkBulkBar() {
  const bar = document.getElementById("networkBulkBar");
  const count = selection.networks.size;
  document.getElementById("networkBulkCount").textContent =
    count === 1 ? "1 rete selezionata" : `${count} reti selezionate`;
  bar.classList.toggle("hidden", count === 0);
}

function updateClientBulkBar() {
  const bar = document.getElementById("clientBulkBar");
  const count = selection.clients.size;
  document.getElementById("clientBulkCount").textContent =
    count === 1 ? "1 client selezionato" : `${count} client selezionati`;
  bar.classList.toggle("hidden", count === 0);
}

function updateWiredBulkBar() {
  const bar = document.getElementById("wiredBulkBar");
  const count = selection.wiredClients.size;
  document.getElementById("wiredBulkCount").textContent =
    count === 1 ? "1 client selezionato" : `${count} client selezionati`;
  bar.classList.toggle("hidden", count === 0);
}

async function loadClientsAndNetworks() {
  stopAllPolling();
  selection.networks.clear();
  selection.clients.clear();
  selection.wiredClients.clear();
  updateNetworkBulkBar();
  updateClientBulkBar();
  updateWiredBulkBar();

  const networksContainer = document.getElementById("wifiNetworks");
  const wiredBody = document.getElementById("wiredClientsBody");
  networksContainer.innerHTML = `<p class="empty">Caricamento…</p>`;
  wiredBody.innerHTML = `<tr><td colspan="7" class="empty">Caricamento…</td></tr>`;

  try {
    const [networks, clients] = await Promise.all([api("/wifi-networks"), api("/clients")]);
    lastNetworksByName = new Map(networks.map((n) => [n.name, n]));
    lastClientsByMac = new Map();

    const wifiMacs = new Set();
    for (const net of networks) for (const c of net.clients || []) wifiMacs.add(c.mac_address);

    renderWifiNetworks(networks);
    renderWiredClients(clients.filter((c) => !wifiMacs.has(c.mac_address)));
    setConnStatus("ok", "connesso");
  } catch (err) {
    networksContainer.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    wiredBody.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderWifiNetworks(networks) {
  const container = document.getElementById("wifiNetworks");
  if (!networks.length) {
    container.innerHTML = `<p class="empty">Nessuna rete WiFi configurata su questo router</p>`;
    return;
  }
  container.innerHTML = "";
  for (const net of networks) {
    const isUp = !net.disabled && net.running !== false;
    const statusBadge = el("span", {
      class: "badge " + (isUp ? "badge-up" : "badge-down"),
      text: net.disabled ? "disabilitata" : net.running === false ? "down" : "up",
    });

    const sourceLabel = formatSourceLabel(net.source);
    const metaParts = [net.ssid ? `SSID: ${net.ssid}` : null, sourceLabel].filter(Boolean);

    const netCheckbox = el("input", { type: "checkbox" });
    netCheckbox.checked = selection.networks.has(net.name);
    netCheckbox.addEventListener("change", () => {
      if (netCheckbox.checked) selection.networks.add(net.name);
      else selection.networks.delete(net.name);
      updateNetworkBulkBar();
    });

    const toggleBtn = el("button", {
      class: "btn btn-sm " + (isUp ? "btn-up" : "btn-down"),
      text: net.disabled ? "Attiva" : "Disattiva",
      onclick: () => toggleNetwork(net.name, !net.disabled),
    });

    const trafficCell = trafficPlaceholder();
    if (net.source !== "sconosciuta") {
      pollTraffic(`net:${net.name}`, () => api(`/interfaces/${encodeURIComponent(net.name)}/traffic`), trafficCell);
    }

    const clientList = el("div", { class: "wifi-client-list" });
    if (!net.clients || !net.clients.length) {
      clientList.appendChild(el("p", { class: "wifi-empty", text: "Nessun client collegato su questa radio" }));
    } else {
      for (const c of net.clients) {
        clientList.appendChild(buildWifiClientRow(c));
      }
    }

    container.appendChild(
      el("div", { class: "wifi-card" }, [
        el("div", { class: "wifi-card-head" }, [
          el("div", { class: "wifi-card-title" }, [
            el("div", { class: "wifi-card-check" }, [netCheckbox, el("h3", { text: net.name })]),
            statusBadge,
          ]),
          el("div", { class: "wifi-client-actions" }, [trafficCell, toggleBtn]),
        ]),
        metaParts.length ? el("p", { class: "wifi-card-meta", text: metaParts.join(" · ") }) : el("span"),
        clientList,
      ])
    );
  }
}

function renderWiredClients(clients) {
  const body = document.getElementById("wiredClientsBody");
  const selectAll = document.getElementById("wiredSelectAll");
  lastWiredMacs = new Set(clients.map((c) => c.mac_address));
  selectAll.checked = lastWiredMacs.size > 0 && [...lastWiredMacs].every((mac) => selection.wiredClients.has(mac));
  if (!clients.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">Nessun client cablato rilevato</td></tr>`;
    return;
  }
  body.innerHTML = "";
  for (const client of clients) {
    lastClientsByMac.set(client.mac_address, client);
    const blockedBadge = el("span", {
      class: "badge " + (client.blocked ? "badge-down" : "badge-up"),
      text: client.blocked ? "bloccato" : "libero",
    });
    // Un client cablato non ha una "sessione" da chiudere lato RouterOS (non è collegato
    // a una radio o a un hotspot): l'unica azione sensata è bloccarlo/sbloccarlo via MAC.
    const blockBtn = el("button", {
      class: "btn btn-sm " + (client.blocked ? "btn-down" : "btn-up"),
      text: client.blocked ? "Sblocca" : "Blocca",
      onclick: () => (client.blocked ? unblockClient(client) : blockClient(client)),
    });
    const trafficCell = trafficPlaceholder();
    pollTraffic(clientTrafficKey(client), clientTrafficFetcher(client), trafficCell);

    body.appendChild(
      el("tr", {}, [
        el("td", {}, [buildClientCheckbox(client.mac_address, selection.wiredClients, updateWiredBulkBar)]),
        el("td", { text: client.mac_address }),
        el("td", { text: client.ip_address || "—" }),
        el("td", { text: client.hostname || "—" }),
        el("td", {}, [blockedBadge]),
        el("td", {}, [trafficCell]),
        el("td", {}, [blockBtn]),
      ])
    );
  }
}

document.getElementById("wiredSelectAll").addEventListener("change", (e) => {
  for (const mac of lastWiredMacs) {
    if (e.target.checked) selection.wiredClients.add(mac);
    else selection.wiredClients.delete(mac);
  }
  updateWiredBulkBar();
  // ri-renderizzare tutta la vista è più semplice che sincronizzare ogni checkbox a mano
  loadClientsAndNetworksKeepingSelection();
});

async function loadClientsAndNetworksKeepingSelection() {
  // variante "leggera": ridisegna senza azzerare le selezioni correnti (usata dopo select-all)
  stopAllPolling();
  const networksContainer = document.getElementById("wifiNetworks");
  const wiredBody = document.getElementById("wiredClientsBody");
  try {
    const [networks, clients] = await Promise.all([api("/wifi-networks"), api("/clients")]);
    const wifiMacs = new Set();
    for (const net of networks) for (const c of net.clients || []) wifiMacs.add(c.mac_address);
    renderWifiNetworks(networks);
    renderWiredClients(clients.filter((c) => !wifiMacs.has(c.mac_address)));
  } catch (err) {
    networksContainer.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    wiredBody.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function toggleNetwork(name, disabled) {
  try {
    await setInterfaceDisabled(name, disabled);
    toast(`Rete ${name} ${disabled ? "disattivata" : "attivata"}`, "ok");
    loadClientsAndNetworks();
  } catch (err) {
    toast(err.message, "error");
  }
}

document.getElementById("bulkEnableNetworks").addEventListener("click", () => bulkSetNetworks(false));
document.getElementById("bulkDisableNetworks").addEventListener("click", () => bulkSetNetworks(true));

async function bulkSetNetworks(disabled) {
  const names = [...selection.networks];
  if (!names.length) return;
  const results = await Promise.allSettled(names.map((name) => setInterfaceDisabled(name, disabled)));
  const failed = results.filter((r) => r.status === "rejected").length;
  toast(
    failed
      ? `${names.length - failed}/${names.length} reti aggiornate, ${failed} fallite`
      : `${names.length} rete/i ${disabled ? "disattivate" : "attivate"}`,
    failed ? "error" : "ok"
  );
  loadClientsAndNetworks();
}

document.getElementById("bulkBlockClients").addEventListener("click", () => bulkClientAction("block", selection.clients));
document.getElementById("bulkUnblockClients").addEventListener("click", () => bulkClientAction("unblock", selection.clients));
document.getElementById("bulkDisconnectClients").addEventListener("click", () => bulkClientAction("disconnect", selection.clients));

document.getElementById("bulkBlockWired").addEventListener("click", () => bulkClientAction("block", selection.wiredClients));
document.getElementById("bulkUnblockWired").addEventListener("click", () => bulkClientAction("unblock", selection.wiredClients));

async function bulkClientAction(action, macSet) {
  const macs = [...macSet];
  if (!macs.length) return;
  if (action === "disconnect" && !confirm(`Forzare la disconnessione di ${macs.length} client?`)) return;

  const results = await Promise.allSettled(
    macs.map((mac) => {
      const client = lastClientsByMac.get(mac) || { mac_address: mac };
      if (action === "block") return blockClientRaw(client);
      if (action === "unblock") return unblockClientRaw(client);
      return disconnectClientRaw(client);
    })
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  const label = { block: "bloccati", unblock: "sbloccati", disconnect: "disconnessi" }[action];
  toast(
    failed ? `${macs.length - failed}/${macs.length} client ${label}, ${failed} falliti` : `${macs.length} client ${label}`,
    failed ? "error" : "ok"
  );
  loadClientsAndNetworks();
}

function blockClientRaw(client) {
  return api("/clients/block", {
    method: "POST",
    body: JSON.stringify({ mac_address: client.mac_address, ip_address: client.ip_address }),
  });
}
function unblockClientRaw(client) {
  return api("/clients/unblock", {
    method: "POST",
    body: JSON.stringify({ mac_address: client.mac_address, ip_address: client.ip_address }),
  });
}
function disconnectClientRaw(client) {
  return api("/clients/disconnect", { method: "POST", body: JSON.stringify({ mac_address: client.mac_address }) });
}

document.getElementById("refreshWifi").addEventListener("click", loadClientsAndNetworks);

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
