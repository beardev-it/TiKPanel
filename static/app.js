// TiKPanel — dashboard (bozza)
// Nessuna dipendenza esterna: fetch + DOM puro.
//
// Autenticazione: login con un utente proprio di TikPanel (non un utente RouterOS),
// con ruolo utente/operatore/amministratore. Il server verifica le credenziali contro
// il proprio elenco utenti e rilascia un token di sessione (JWT) firmato, che include
// anche il ruolo. Nessuna password viene mai salvata nel browser: solo il token, che
// scade da solo dopo qualche ora.

const LS_TOKEN = "tikpanel.token";
const LS_USERNAME = "tikpanel.username";
const LS_ROLE = "tikpanel.role";
const LS_THEME = "tikpanel.theme";

const state = {
  baseUrl: "", // caricato da /ui-config all'avvio, non richiesto all'utente
  token: localStorage.getItem(LS_TOKEN) || "",
  username: localStorage.getItem(LS_USERNAME) || "",
  role: localStorage.getItem(LS_ROLE) || "",
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

// ---------- overlay a pagina intera ----------
// Mostrato per tutta la durata di un'azione che parla con RouterOS (blocca/sblocca,
// abilita/disabilita, crea/elimina...) e tenuto visibile finché anche il ricaricamento
// dei dati non è terminato, per evitare doppi click o di vedere dati non aggiornati.

let _pageOverlayDepth = 0;

function showPageOverlay() {
  _pageOverlayDepth += 1;
  document.getElementById("pageOverlay").classList.remove("hidden");
}

function hidePageOverlay() {
  _pageOverlayDepth = Math.max(0, _pageOverlayDepth - 1);
  if (_pageOverlayDepth === 0) {
    document.getElementById("pageOverlay").classList.add("hidden");
  }
}

// Esegue `fn` (una funzione async) tenendo l'overlay visibile per tutta la sua durata,
// inclusi eventuali ricaricamenti fatti al suo interno (basta che siano `await`ati).
async function withOverlay(fn) {
  showPageOverlay();
  try {
    return await fn();
  } finally {
    hidePageOverlay();
  }
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

function hostnameCell(client) {
  // hostname_source: 'dhcp' = comunicato dal client, 'comment' = etichetta manuale sul lease
  // (riserva quando il client non manda nulla via DHCP), assente/null = nessuna delle due.
  if (!client.hostname) return el("span", { text: "—" });
  const isManual = client.hostname_source === "comment";
  return el(
    "span",
    isManual ? { title: "Etichetta manuale (dal commento del lease DHCP), non inviata dal client" } : {},
    [
      el("span", { text: client.hostname }),
      isManual ? el("span", { class: "hostname-manual-tag", text: " (manuale)" }) : null,
    ].filter(Boolean)
  );
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
  document.getElementById("setupAdminScreen").classList.add("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("userBadge").classList.add("hidden");
  document.getElementById("btnLogout").classList.add("hidden");
  document.getElementById("moduleBadges").classList.add("hidden");
  setConnStatus("unknown", "non connesso");
}

function showSetupAdmin() {
  // Schermata obbligatoria: niente app, niente logout, niente via di fuga finché non si crea
  // il vero amministratore. Il token di bootstrap in state.token non autorizza nient'altro.
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("userBadge").classList.add("hidden");
  document.getElementById("btnLogout").classList.add("hidden");
  document.getElementById("moduleBadges").classList.add("hidden");
  document.getElementById("setupAdminScreen").classList.remove("hidden");
  setConnStatus("unknown", "setup amministratore richiesto");
}

function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  const badge = document.getElementById("userBadge");
  badge.textContent = state.username;
  badge.classList.remove("hidden");
  document.getElementById("btnLogout").classList.remove("hidden");

  const usersTabBtn = document.getElementById("usersTabBtn");
  const isAdmin = state.role === "amministratore";
  usersTabBtn.classList.toggle("hidden", !isAdmin);
  if (!isAdmin && usersTabBtn.classList.contains("active")) {
    // se per qualche motivo la tab utenti era attiva e il ruolo non lo consente più
    // (es. sessione ripristinata con un ruolo cambiato nel frattempo), torna a Interfacce
    usersTabBtn.classList.remove("active");
    document.querySelector('.tab[data-tab="interfaces"]').classList.add("active");
    document.getElementById("tab-users").classList.remove("active");
    document.getElementById("tab-interfaces").classList.add("active");
  }
}

async function loadWifiModuleStatus() {
  const badges = document.getElementById("moduleBadges");
  const wirelessDot = document.getElementById("wirelessModuleDot");
  const wifiDot = document.getElementById("wifiModuleDot");
  try {
    const status = await api("/wifi-modules");
    wirelessDot.className = "dot " + (status.wireless ? "dot-ok" : "dot-error");
    wirelessDot.title = status.wireless ? "Modulo wireless installato" : "Modulo wireless non installato su questo router";
    wifiDot.className = "dot " + (status.wifi ? "dot-ok" : "dot-error");
    wifiDot.title = status.wifi ? "Modulo wifi installato" : "Modulo wifi non installato su questo router";
    badges.classList.remove("hidden");
  } catch (_) {
    // non blocchiamo l'avvio della dashboard per questo: i badge restano semplicemente nascosti
    badges.classList.add("hidden");
  }
}

function logout(message) {
  stopAllPolling(); // altrimenti i poller di traffico (interfacce/VLAN/client) restano
  // attivi in background anche da sloggato, finché non si ricarica la pagina
  state.token = "";
  state.username = "";
  state.role = "";
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USERNAME);
  localStorage.removeItem(LS_ROLE);
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
    document.getElementById("loginPassword").value = "";

    if (data.must_setup_admin) {
      // Credenziali provvisorie da env var: questo token non è una sessione vera, autorizza
      // solo la creazione dell'amministratore. Non lo salviamo in localStorage.
      state.token = data.access_token;
      state.username = "";
      state.role = "";
      document.getElementById("setupAdminUsername").value = "";
      document.getElementById("setupAdminPassword").value = "";
      document.getElementById("setupAdminPasswordConfirm").value = "";
      document.getElementById("setupAdminError").classList.add("hidden");
      showSetupAdmin();
      return;
    }

    state.token = data.access_token;
    state.username = data.username;
    state.role = data.role;
    localStorage.setItem(LS_TOKEN, state.token);
    localStorage.setItem(LS_USERNAME, state.username);
    localStorage.setItem(LS_ROLE, state.role);
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

document.getElementById("setupAdminForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("setupAdminUsername").value.trim();
  const password = document.getElementById("setupAdminPassword").value;
  const passwordConfirm = document.getElementById("setupAdminPasswordConfirm").value;
  const errorBox = document.getElementById("setupAdminError");
  errorBox.classList.add("hidden");

  if (password !== passwordConfirm) {
    errorBox.textContent = "Le due password non coincidono";
    errorBox.classList.remove("hidden");
    return;
  }

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Creazione in corso…";

  try {
    const url = (state.baseUrl || "") + "/auth/setup-admin";
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({ username, password }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `Errore ${resp.status}`);
    }
    const data = await resp.json();
    state.token = data.access_token;
    state.username = data.username;
    state.role = data.role;
    localStorage.setItem(LS_TOKEN, state.token);
    localStorage.setItem(LS_USERNAME, state.username);
    localStorage.setItem(LS_ROLE, state.role);
    document.getElementById("setupAdminPassword").value = "";
    document.getElementById("setupAdminPasswordConfirm").value = "";
    toast(`Amministratore '${data.username}' creato`, "ok");
    setConnStatus("ok", "connesso");
    showApp();
    loadInterfaces();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Crea amministratore";
  }
});

// ---------- tabs ----------

function loadTab(tabName) {
  if (tabName === "interfaces") loadInterfaces();
  if (tabName === "vlans") loadVlans();
  if (tabName === "wifi") loadClientsAndNetworks();
  if (tabName === "users") loadUsers();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    stopAllPolling();
    loadTab(tab.dataset.tab);
  });
});

// Mentre la scheda del browser è in background non ha senso continuare a interrogare il
// router ogni pochi secondi per il traffico: mettiamo in pausa i poller, e li riprendiamo
// ricaricando la tab corrente quando la scheda torna in primo piano.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAllPolling();
    return;
  }
  if (document.getElementById("app").classList.contains("hidden")) return; // non ancora loggati
  const activeTab = document.querySelector(".tab.active");
  if (activeTab) loadTab(activeTab.dataset.tab);
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
  await withOverlay(async () => {
    try {
      await setInterfaceDisabled(name, disabled);
      toast(`Interfaccia ${name} ${disabled ? "disabilitata" : "abilitata"}`, "ok");
      await loadInterfaces();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function setInterfaceDisabled(name, disabled) {
  return api(`/interfaces/${encodeURIComponent(name)}/state`, {
    method: "PUT",
    body: JSON.stringify({ disabled }),
  });
}

document.getElementById("refreshInterfaces").addEventListener("click", loadInterfaces);

// ---------- VLAN ----------

async function loadVlanInterfaceOptions() {
  const select = document.getElementById("vlanInterfaceSelect");
  const previousValue = select.value;
  try {
    const interfaces = await api("/interfaces");
    // Una VLAN si aggancia a un'interfaccia "fisica" (ethernet, bridge, bonding, wireless...):
    // escludiamo le VLAN stesse dall'elenco, altrimenti si potrebbero impilare all'infinito
    // creando confusione (RouterOS lo permetterebbe tecnicamente, ma non è un caso d'uso comune).
    const options = interfaces
      .filter((iface) => iface.type !== "vlan")
      .sort((a, b) => a.name.localeCompare(b.name));

    select.innerHTML = "";
    if (!options.length) {
      select.appendChild(el("option", { value: "", disabled: "", selected: "", text: "nessuna interfaccia disponibile" }));
      return;
    }
    select.appendChild(el("option", { value: "", disabled: "", text: "interfaccia…" }));
    for (const iface of options) {
      const label = iface.type ? `${iface.name} (${iface.type})` : iface.name;
      select.appendChild(el("option", { value: iface.name, text: label }));
    }
    // ripristina la selezione precedente se ancora presente (es. dopo un refresh manuale)
    if (previousValue && options.some((i) => i.name === previousValue)) {
      select.value = previousValue;
    } else {
      select.value = "";
    }
  } catch (err) {
    select.innerHTML = "";
    select.appendChild(el("option", { value: "", disabled: "", selected: "", text: "errore nel caricamento interfacce" }));
  }
}

async function loadVlans() {
  stopAllPolling();
  loadVlanInterfaceOptions();
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
  await withOverlay(async () => {
    try {
      await api(`/vlans/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(`VLAN ${name} eliminata`, "ok");
      await loadVlans();
    } catch (err) {
      toast(err.message, "error");
    }
  });
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
  await withOverlay(async () => {
    try {
      await api("/vlans", { method: "POST", body: JSON.stringify(payload) });
      toast(`VLAN ${payload.name} creata`, "ok");
      form.reset();
      await loadVlans();
    } catch (err) {
      toast(err.message, "error");
    }
  });
});

document.getElementById("refreshVlans").addEventListener("click", loadVlans);

// ---------- utenti (solo amministratore) ----------

function formatRole(role) {
  return { utente: "Utente", operatore: "Operatore", amministratore: "Amministratore" }[role] || role;
}

async function loadUsers() {
  const body = document.getElementById("usersBody");
  body.innerHTML = `<tr><td colspan="5" class="empty">Caricamento…</td></tr>`;
  try {
    const data = await api("/users");
    if (!data.length) {
      body.innerHTML = `<tr><td colspan="5" class="empty">Nessun utente</td></tr>`;
      return;
    }
    body.innerHTML = "";
    for (const user of data) {
      const roleSelect = el(
        "select",
        { class: "role-select" },
        ["utente", "operatore", "amministratore"].map((r) => el("option", { value: r, text: formatRole(r) }))
      );
      roleSelect.value = user.role;
      roleSelect.addEventListener("change", () => updateUserRole(user.username, roleSelect.value, roleSelect));

      const statusBadge = el("span", {
        class: "badge " + (user.disabled ? "badge-down" : "badge-up"),
        text: user.disabled ? "disabilitato" : "attivo",
      });
      const toggleBtn = el("button", {
        class: "btn btn-sm " + (user.disabled ? "btn-up" : "btn-down"),
        text: user.disabled ? "Riabilita" : "Disabilita",
        onclick: () => toggleUserDisabled(user.username, !user.disabled),
      });
      const resetPwBtn = el("button", {
        class: "btn btn-sm",
        text: "Reimposta password",
        onclick: () => resetUserPassword(user.username),
      });
      const deleteBtn = el("button", {
        class: "btn btn-sm btn-danger",
        text: "Elimina",
        onclick: () => deleteUser(user.username),
      });
      const isSelf = user.username === state.username;

      body.appendChild(
        el("tr", {}, [
          el("td", { text: user.username + (isSelf ? " (tu)" : "") }),
          el("td", {}, [roleSelect]),
          el("td", {}, [statusBadge]),
          el("td", { text: new Date(user.created_at * 1000).toLocaleString("it-IT") }),
          el("td", {}, [toggleBtn, resetPwBtn, deleteBtn]),
        ])
      );
    }
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function updateUserRole(username, role, selectEl) {
  await withOverlay(async () => {
    try {
      await api(`/users/${encodeURIComponent(username)}`, { method: "PATCH", body: JSON.stringify({ role }) });
      toast(`Ruolo di ${username} aggiornato a ${formatRole(role)}`, "ok");
      if (username === state.username) {
        // ho appena cambiato il mio stesso ruolo: la sessione corrente ha ancora il vecchio
        // ruolo nel token finché non rifaccio login, quindi lo segnalo esplicitamente
        toast("Il nuovo ruolo si applica dal prossimo login", "ok");
      }
    } catch (err) {
      toast(err.message, "error");
      await loadUsers(); // ripristina la select al valore reale
    }
  });
}

async function toggleUserDisabled(username, disabled) {
  await withOverlay(async () => {
    try {
      await api(`/users/${encodeURIComponent(username)}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      toast(`Utente ${username} ${disabled ? "disabilitato" : "riabilitato"}`, "ok");
      await loadUsers();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function resetUserPassword(username) {
  const password = prompt(`Nuova password per ${username} (minimo 8 caratteri):`);
  if (!password) return;
  if (password.length < 8) {
    toast("La password deve avere almeno 8 caratteri", "error");
    return;
  }
  await withOverlay(async () => {
    try {
      await api(`/users/${encodeURIComponent(username)}`, { method: "PATCH", body: JSON.stringify({ password }) });
      toast(`Password di ${username} aggiornata`, "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function deleteUser(username) {
  if (!confirm(`Eliminare l'utente ${username}? L'azione non è reversibile.`)) return;
  await withOverlay(async () => {
    try {
      await api(`/users/${encodeURIComponent(username)}`, { method: "DELETE" });
      toast(`Utente ${username} eliminato`, "ok");
      await loadUsers();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

document.getElementById("userCreateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    username: form.username.value.trim(),
    password: form.password.value,
    role: form.role.value,
  };
  await withOverlay(async () => {
    try {
      await api("/users", { method: "POST", body: JSON.stringify(payload) });
      toast(`Utente ${payload.username} creato`, "ok");
      form.reset();
      await loadUsers();
    } catch (err) {
      toast(err.message, "error");
    }
  });
});

document.getElementById("refreshUsers").addEventListener("click", loadUsers);

// ---------- client & reti WiFi (vista unificata) ----------

// Due stack WiFi possibili su RouterOS, incompatibili tra loro e da non confondere:
// - "wireless"/"capsman" = driver legacy (/interface/wireless), opzionalmente gestito
//   centralmente dal vecchio CAPsMAN (/caps-man) — quello che il router chiama solo "CAPsMAN"
// - "wifi" = nuovo driver (/interface/wifi, RouterOS >= 7.13, supporta WiFi 6/6E),
//   opzionalmente gestito dal CAPsMAN integrato nel pacchetto stesso (spesso chiamato in modo
//   informale "CAPsMAN v2" per distinguerlo dal precedente, anche se MikroTik lo chiama solo
//   "CAPsMAN" pure lui)
function formatSourceLabel(net) {
  switch (net.source) {
    case "wireless":
      return "Wireless (legacy, locale)";
    case "capsman":
      return "Wireless (legacy) — CAPsMAN";
    case "wifi":
      return net.managed_by_capsman ? "WiFi (nuovo driver) — CAPsMAN v2" : "WiFi (nuovo driver, locale)";
    default:
      return "";
  }
}

function stackGeneration(source) {
  // per una classe CSS che raggruppi visivamente i due stack (badge di colore diverso)
  return source === "wifi" ? "stack-new" : source === "capsman" || source === "wireless" ? "stack-legacy" : "";
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
  await withOverlay(async () => {
    try {
      await api("/clients/block", {
        method: "POST",
        body: JSON.stringify({ mac_address: client.mac_address, ip_address: client.ip_address }),
      });
      toast(`Client ${client.mac_address} bloccato`, "ok");
      await loadClientsAndNetworks();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function unblockClient(client) {
  await withOverlay(async () => {
    try {
      await api("/clients/unblock", {
        method: "POST",
        body: JSON.stringify({ mac_address: client.mac_address, ip_address: client.ip_address }),
      });
      toast(`Client ${client.mac_address} sbloccato`, "ok");
      await loadClientsAndNetworks();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

async function disconnectClient(client) {
  if (!confirm(`Forzare la disconnessione di ${client.mac_address}?`)) return;
  await withOverlay(async () => {
    try {
      const res = await api("/clients/disconnect", {
        method: "POST",
        body: JSON.stringify({ mac_address: client.mac_address }),
      });
      toast((res.actions || []).join("; ") || "Disconnessione richiesta", "ok");
      await loadClientsAndNetworks();
    } catch (err) {
      toast(err.message, "error");
    }
  });
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
  const hostnameLabel = client.hostname
    ? client.hostname + (client.hostname_source === "comment" ? " (manuale)" : "")
    : "";
  const sub = [hostnameLabel, client.ip_address].filter(Boolean).join(" · ");
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
  loadWifiModuleStatus();

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

    const sourceLabel = formatSourceLabel(net);
    const stackTag = sourceLabel
      ? el("span", { class: "tag " + stackGeneration(net.source), text: sourceLabel })
      : null;

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

    const metaLine = net.ssid ? `SSID: ${net.ssid}` : null;

    container.appendChild(
      el("div", { class: "wifi-card" }, [
        el("div", { class: "wifi-card-head" }, [
          el(
            "div",
            { class: "wifi-card-title" },
            [el("div", { class: "wifi-card-check" }, [netCheckbox, el("h3", { text: net.name })]), statusBadge, stackTag].filter(
              Boolean
            )
          ),
          el("div", { class: "wifi-client-actions" }, [trafficCell, toggleBtn]),
        ]),
        metaLine ? el("p", { class: "wifi-card-meta", text: metaLine }) : el("span"),
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
        el("td", {}, [hostnameCell(client)]),
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
  await withOverlay(async () => {
    try {
      await setInterfaceDisabled(name, disabled);
      toast(`Rete ${name} ${disabled ? "disattivata" : "attivata"}`, "ok");
      await loadClientsAndNetworks();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

document.getElementById("bulkEnableNetworks").addEventListener("click", () => bulkSetNetworks(false));
document.getElementById("bulkDisableNetworks").addEventListener("click", () => bulkSetNetworks(true));

async function bulkSetNetworks(disabled) {
  const names = [...selection.networks];
  if (!names.length) return;
  await withOverlay(async () => {
    const results = await Promise.allSettled(names.map((name) => setInterfaceDisabled(name, disabled)));
    const failed = results.filter((r) => r.status === "rejected").length;
    toast(
      failed
        ? `${names.length - failed}/${names.length} reti aggiornate, ${failed} fallite`
        : `${names.length} rete/i ${disabled ? "disattivate" : "attivate"}`,
      failed ? "error" : "ok"
    );
    await loadClientsAndNetworks();
  });
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

  await withOverlay(async () => {
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
    await loadClientsAndNetworks();
  });
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
    if (data.auth !== "session" || data.username !== state.username) return false;
    // il ruolo potrebbe essere cambiato da quando è stato rilasciato il token: riallinea
    state.role = data.role || state.role;
    localStorage.setItem(LS_ROLE, state.role);
    return true;
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
