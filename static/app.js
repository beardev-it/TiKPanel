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
  clientTrafficTargets.length = 0;
  interfaceTrafficTargets.length = 0;
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
      if (!iface.disabled) registerInterfaceTraffic(iface.name, trafficCell);
    }
    startInterfaceTrafficPolling();
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
      if (isUp) registerInterfaceTraffic(vlan.name, trafficCell);
    }
    startInterfaceTrafficPolling();
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
};
let lastClientsByMac = new Map();
let lastNetworksByName = new Map();
// stato access-list/gruppi letto da GET /access-control (+ filtro per gruppo e scadenza locale)
const accessState = { data: null, filter: "", deadline: null };

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

// Traffico delle interfacce (fisiche, VLAN, radio): una sola richiesta per tutte quelle
// visibili nella tab, invece di una per riga. Le celle si registrano al render.
const interfaceTrafficTargets = []; // { name, cell }

function registerInterfaceTraffic(name, cell) {
  interfaceTrafficTargets.push({ name, cell });
}

function startInterfaceTrafficPolling() {
  if (!interfaceTrafficTargets.length || pollers.has("interfaces-batch")) return;
  const tick = async () => {
    const live = interfaceTrafficTargets.filter((t) => t.cell.isConnected);
    if (!live.length) {
      clearInterval(pollers.get("interfaces-batch"));
      pollers.delete("interfaces-batch");
      return;
    }
    try {
      const res = await api("/interfaces/traffic/batch", {
        method: "POST",
        body: JSON.stringify({ names: [...new Set(live.map((t) => t.name))] }),
      });
      for (const t of live) {
        const fresh = trafficNode((res.samples || {})[t.name]);
        t.cell.className = fresh.className;
        t.cell.replaceChildren(...fresh.childNodes);
      }
    } catch (_) {
      // silenzioso: un singolo poll fallito non deve riempire di toast la UI
    }
  };
  setTimeout(tick, 0); // primo campione subito dopo il render, poi ogni TRAFFIC_POLL_MS
  pollers.set("interfaces-batch", setInterval(tick, TRAFFIC_POLL_MS));
}

// Traffico dei client: torch è pesante (ogni chiamata dura ~1s sul router), quindi invece di
// una chiamata per client ne facciamo UNA per interfaccia, con tutti gli IP visibili, e
// distribuiamo i risultati alle rispettive celle. Le celle si registrano al render.
const clientTrafficTargets = []; // { ip, iface, cell }

function registerClientTraffic(client, cell) {
  const iface = client.interface || client.wifi_interface || client.capsman_interface || client.wireless_interface || client.arp_interface;
  if (!client.ip_address || !iface) {
    cell.replaceChildren(...trafficNode(null).childNodes);
    cell.className = "traffic unavailable";
    return;
  }
  clientTrafficTargets.push({ ip: client.ip_address, iface, cell });
}

function startClientTrafficPolling() {
  if (!clientTrafficTargets.length || pollers.has("clients-batch")) return;
  const tick = async () => {
    const live = clientTrafficTargets.filter((t) => t.cell.isConnected);
    if (!live.length) {
      clearInterval(pollers.get("clients-batch"));
      pollers.delete("clients-batch");
      return;
    }
    try {
      const res = await api("/clients/traffic/batch", {
        method: "POST",
        body: JSON.stringify({ targets: live.map((t) => ({ ip_address: t.ip, interface: t.iface })) }),
      });
      for (const t of live) {
        const fresh = trafficNode((res.samples || {})[t.ip]);
        t.cell.className = fresh.className;
        t.cell.replaceChildren(...fresh.childNodes);
      }
    } catch (_) {
      // silenzioso: un singolo poll fallito non deve riempire di toast la UI
    }
  };
  // primo campione subito dopo che le righe sono nel DOM, poi ogni TRAFFIC_POLL_MS
  setTimeout(tick, 0);
  pollers.set("clients-batch", setInterval(tick, TRAFFIC_POLL_MS));
}

function buildClientCheckbox(mac) {
  const checkbox = el("input", { type: "checkbox" });
  checkbox.checked = selection.clients.has(mac);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selection.clients.add(mac);
    else selection.clients.delete(mac);
    updateClientBulkBar();
  });
  return checkbox;
}

// ---------- access-list e gruppi ----------

function allowedSet() {
  return new Set(((accessState.data && accessState.data.allowed) || []).map((a) => a.mac_address));
}

function groupOf(mac) {
  return (accessState.data && accessState.data.assignments && accessState.data.assignments[mac.toUpperCase()]) || "";
}

function clientMatchesFilter(client) {
  const f = accessState.filter;
  if (!f) return true;
  const g = groupOf(client.mac_address);
  return f === "__none__" ? !g : g === f;
}

function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function loadAccessControl() {
  try {
    accessState.data = await api("/access-control");
  } catch (err) {
    accessState.data = null;
    toast(err.message, "error");
  }
  accessState.deadline =
    accessState.data && accessState.data.learning ? Date.now() + accessState.data.learning_seconds_left * 1000 : null;
  renderAccessPanel();
  renderGroupsPanel();
}

function startAccessTimers() {
  if (pollers.has("access-countdown")) return;
  // il conto alla rovescia è locale (ogni secondo); lo stato vero lo rilegge dal server
  // ogni 15s, e subito alla scadenza, perché è il watchdog del server a riattivare la regola
  pollers.set(
    "access-countdown",
    setInterval(async () => {
      if (!accessState.deadline) return;
      const left = (accessState.deadline - Date.now()) / 1000;
      const label = document.getElementById("accessHint");
      if (left > 0) {
        label.dataset.countdown = formatCountdown(left);
        renderAccessHint();
      } else {
        accessState.deadline = null;
        await loadAccessControl();
        await refreshClientsView();
      }
    }, 1000)
  );
  pollers.set(
    "access-sync",
    setInterval(() => {
      if (accessState.deadline) loadAccessControl();
    }, 15000)
  );
}

function renderAccessHint() {
  const d = accessState.data;
  const hint = document.getElementById("accessHint");
  if (!d) return;
  if (!d.configured) {
    hint.textContent = "L'access-list non è ancora attiva: chi si collega non viene filtrato. Attivala per far collegare solo i client autorizzati.";
  } else if (d.learning && accessState.deadline) {
    hint.textContent = `Modalità aggiunta client: l'access-list è sospesa, chiunque può collegarsi. Si riattiva da sola tra ${formatCountdown(
      (accessState.deadline - Date.now()) / 1000
    )}. Autorizza i client collegati, poi premi "Termina e riattiva".`;
  } else if (d.enforced) {
    hint.textContent = "Possono collegarsi solo i client in elenco. I client già collegati restano collegati finché non si riconnettono.";
  } else {
    hint.textContent = "L'access-list è disattivata: chiunque può collegarsi.";
  }
}

function renderAccessPanel() {
  const panel = document.getElementById("accessPanel");
  const d = accessState.data;
  if (!d || !d.available) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const badge = document.getElementById("accessBadge");
  const enforced = d.enforced && !d.learning;
  badge.className = "badge " + (enforced ? "badge-up" : "badge-down");
  badge.textContent = d.learning ? "aggiunta client" : enforced ? "attiva" : "disattivata";

  const learning = !!d.learning;
  function confirmKickUnauthorized() {
  return confirm(
    "Vuoi disconnettere subito i client collegati che non sono nell'access-list?\n\nOK = disconnettili ora (dovranno riautenticarsi e verranno rifiutati), Annulla = restano collegati finché non si riconnettono."
  );
}

document.getElementById("accessEnableBtn").addEventListener("click", () => {
  const d = accessState.data;
  const first = d && !d.configured;
  const authorizeConnected =
    first && confirm("Attivando l'access-list per la prima volta, vuoi autorizzare anche i client CAPsMAN collegati adesso?\n\nOK = autorizzali, Annulla = autorizza solo quelli già in elenco.");
  const kick = !authorizeConnected && confirmKickUnauthorized();
  accessAction(
    "/access-control/enable",
    { authorize_connected: !!authorizeConnected, disconnect_unauthorized: !!kick },
    "Access-list attivata"
  );
});

document.getElementById("accessLearnBtn").classList.toggle("hidden", learning || !d.configured);
  document.getElementById("accessStopBtn").classList.toggle("hidden", !learning);
  renderAccessHint();

  const body = document.getElementById("accessAllowedBody");
  body.innerHTML = "";
  if (!d.allowed.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">Nessun client autorizzato</td></tr>`;
    return;
  }
  for (const a of d.allowed) {
    const mac = a.mac_address;
    const connected = lastClientsByMac.has(mac);
    body.appendChild(
      el("tr", {}, [
        el("td", { text: a.label || "—" }),
        el("td", { text: mac }),
        el("td", { text: a.group || "—" }),
        el("td", {}, [el("span", { class: "badge " + (connected ? "badge-up" : ""), text: connected ? "collegato" : "offline" })]),
        el("td", {}, [
          el("button", { class: "btn btn-sm btn-danger", text: "Rimuovi", onclick: () => revokeClient(mac, connected) }),
        ]),
      ])
    );
  }
}

function renderGroupsPanel() {
  const d = accessState.data;
  const list = document.getElementById("groupsList");
  const groups = (d && d.groups) || [];
  list.innerHTML = "";
  if (!groups.length) list.appendChild(el("span", { class: "muted", text: "Nessun gruppo creato" }));
  for (const g of groups) {
    list.appendChild(
      el("span", { class: "group-chip" }, [
        el("span", { class: "group-chip-name", text: `${g.name} (${g.members})` }),
        el("button", { class: "chip-btn", type: "button", title: "Rinomina", text: "✎", onclick: () => renameGroup(g.name) }),
        el("button", { class: "chip-btn", type: "button", title: "Elimina", text: "✕", onclick: () => deleteGroup(g.name, g.members) }),
      ])
    );
  }
  const filter = document.getElementById("groupFilter");
  const bulk = document.getElementById("bulkGroupSelect");
  const current = accessState.filter;
  filter.innerHTML = "";
  filter.appendChild(el("option", { value: "", text: "di tutti i gruppi" }));
  filter.appendChild(el("option", { value: "__none__", text: "senza gruppo" }));
  bulk.innerHTML = "";
  bulk.appendChild(el("option", { value: "", text: "— nessun gruppo —" }));
  for (const g of groups) {
    filter.appendChild(el("option", { value: g.name, text: g.name }));
    bulk.appendChild(el("option", { value: g.name, text: g.name }));
  }
  if (current && ![...filter.options].some((o) => o.value === current)) accessState.filter = "";
  filter.value = accessState.filter;
}

async function accessAction(path, body, okMessage) {
  await withOverlay(async () => {
    try {
      await api(path, { method: "POST", body: JSON.stringify(body || {}) });
      if (okMessage) toast(okMessage, "ok");
      await loadClientsAndNetworks();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

document.getElementById("accessEnableBtn").addEventListener("click", () => {
  const d = accessState.data;
  const first = d && !d.configured;
  const authorizeConnected =
    first && confirm("Attivando l'access-list per la prima volta, vuoi autorizzare anche i client CAPsMAN collegati adesso?\n\nOK = autorizzali, Annulla = autorizza solo quelli già in elenco.");
  accessAction("/access-control/enable", { authorize_connected: !!authorizeConnected }, "Access-list attivata");
});

document.getElementById("accessLearnBtn").addEventListener("click", () => {
  const minutes = prompt(
    `Per quanti minuti sospendere l'access-list? Durante questo tempo chiunque può collegarsi; poi si riattiva da sola.`,
    String((accessState.data && accessState.data.default_learning_minutes) || 10)
  );
  if (minutes === null) return;
  const n = parseInt(minutes, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    toast("Inserisci un numero di minuti tra 1 e 120", "error");
    return;
  }
  accessAction("/access-control/learning/start", { minutes: n }, "Modalità aggiunta client attiva");
});

document.getElementById("accessStopBtn").addEventListener("click", () =>
  accessAction("/access-control/learning/stop", { disconnect_unauthorized: confirmKickUnauthorized() }, "Access-list riattivata")
);

async function allowClient(client) {
  const label = client.hostname || "";
  await accessAction("/access-control/allow", { mac_address: client.mac_address, label }, `Client ${client.mac_address} autorizzato`);
}

async function revokeClient(mac, connected) {
  const disconnect = connected && confirm(`Rimuovere ${mac} dall'access-list e disconnetterlo subito?\n\nOK = disconnetti ora, Annulla = lascia collegato fino alla prossima riconnessione.`);
  if (!confirm(`Confermi di togliere ${mac} dall'access-list?`)) return;
  await accessAction("/access-control/revoke", { mac_address: mac, disconnect: !!disconnect }, `Client ${mac} rimosso`);
}

async function groupRequest(method, path, body, okMessage) {
  await withOverlay(async () => {
    try {
      await api(path, { method, body: body ? JSON.stringify(body) : undefined });
      if (okMessage) toast(okMessage, "ok");
      await loadClientsAndNetworks();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

document.getElementById("groupCreateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = e.target.elements.name;
  const name = input.value.trim();
  if (!name) return;
  await groupRequest("POST", "/groups", { name }, `Gruppo '${name}' creato`);
  input.value = "";
});

function renameGroup(name) {
  const next = prompt(`Nuovo nome per il gruppo '${name}':`, name);
  if (next === null || !next.trim() || next.trim() === name) return;
  groupRequest("PATCH", `/groups/${encodeURIComponent(name)}`, { name: next.trim() }, "Gruppo rinominato");
}

function deleteGroup(name, members) {
  if (!confirm(`Eliminare il gruppo '${name}'? I suoi ${members} client resteranno senza gruppo.`)) return;
  groupRequest("DELETE", `/groups/${encodeURIComponent(name)}`, null, "Gruppo eliminato");
}

document.getElementById("groupFilter").addEventListener("change", (e) => {
  accessState.filter = e.target.value;
  selection.clients.clear();
  updateClientBulkBar();
  refreshClientsView();
});

document.getElementById("bulkAssignGroup").addEventListener("click", async () => {
  const macs = [...selection.clients];
  if (!macs.length) return;
  const group = document.getElementById("bulkGroupSelect").value;
  await withOverlay(async () => {
    try {
      await api("/clients/group", { method: "PUT", body: JSON.stringify({ mac_addresses: macs, group: group || null }) });
      toast(group ? `${macs.length} client assegnati a '${group}'` : `${macs.length} client tolti dal gruppo`, "ok");
      await loadClientsAndNetworks();
    } catch (err) {
      toast(err.message, "error");
    }
  });
});

document.getElementById("bulkAllowClients").addEventListener("click", async () => {
  const macs = [...selection.clients];
  if (!macs.length) return;
  await withOverlay(async () => {
    const results = await Promise.allSettled(
      macs.map((mac) => {
        const c = lastClientsByMac.get(mac) || {};
        return api("/access-control/allow", {
          method: "POST",
          body: JSON.stringify({ mac_address: mac, label: c.hostname || "" }),
        });
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    toast(
      failed ? `${macs.length - failed}/${macs.length} client autorizzati, ${failed} falliti` : `${macs.length} client autorizzati`,
      failed ? "error" : "ok"
    );
    await loadClientsAndNetworks();
  });
});

function buildWifiClientRow(client) {
  lastClientsByMac.set(client.mac_address, client);
  const label = (accessState.data && accessState.data.labels[client.mac_address.toUpperCase()]) || "";
  const name = label || client.hostname || "";
  const nameSuffix = !label && client.hostname && client.hostname_source === "comment" ? " (manuale)" : "";
  const sub = [client.ip_address, client.mac_address && name ? client.mac_address : ""].filter(Boolean).join(" · ");
  const trafficCell = trafficPlaceholder();
  registerClientTraffic(client, trafficCell);

  const access = accessState.data && accessState.data.available ? accessState.data : null;
  const isAllowed = allowedSet().has(client.mac_address.toUpperCase());
  const group = groupOf(client.mac_address);

  const badges = [];
  if (access) {
    badges.push(el("span", { class: "badge " + (isAllowed ? "badge-up" : "badge-down"), text: isAllowed ? "autorizzato" : "non autorizzato" }));
  }
  if (group) badges.push(el("span", { class: "tag group-tag", text: group }));

  const actions = [trafficCell];
  if (access && !isAllowed) {
    actions.push(el("button", { class: "btn btn-sm btn-primary", text: "Autorizza", onclick: () => allowClient(client) }));
  }
  actions.push(
    el("button", {
      class: "btn btn-sm " + (client.blocked ? "btn-down" : "btn-up"),
      text: client.blocked ? "Sblocca" : "Blocca",
      onclick: () => (client.blocked ? unblockClient(client) : blockClient(client)),
    }),
    el("button", { class: "btn btn-sm btn-danger", text: "Disconnetti", onclick: () => disconnectClient(client) })
  );

  return el("div", { class: "wifi-client-row" }, [
    el("div", { class: "wifi-client-select" }, [
      buildClientCheckbox(client.mac_address),
      el("div", { class: "wifi-client-main" }, [
        el("span", { class: "wifi-client-mac", text: (name ? name + nameSuffix : client.mac_address) }),
        el("span", { class: "wifi-client-sub", text: name ? sub : client.ip_address || "" }),
      ]),
      ...badges,
    ]),
    el("div", { class: "wifi-client-actions" }, actions),
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

async function loadClientsAndNetworks() {
  selection.networks.clear();
  selection.clients.clear();
  updateNetworkBulkBar();
  updateClientBulkBar();
  loadWifiModuleStatus();
  await refreshClientsView(true);
}

// Ricarica reti, client e stato access-list e ridisegna. Con `initial` mostra "Caricamento…".
async function refreshClientsView(initial = false) {
  stopAllPolling();
  const networksContainer = document.getElementById("wifiNetworks");
  if (initial) networksContainer.innerHTML = `<p class="empty">Caricamento…</p>`;
  try {
    const [networks] = await Promise.all([api("/wifi-networks"), loadAccessControl()]);
    lastNetworksByName = new Map(networks.map((n) => [n.name, n]));
    lastClientsByMac = new Map();
    renderWifiNetworks(networks);
    renderAccessPanel(); // ora che sappiamo chi è collegato, aggiorna anche lo stato "collegato/offline"
    startInterfaceTrafficPolling();
    startClientTrafficPolling();
    startAccessTimers();
    setConnStatus("ok", "connesso");
  } catch (err) {
    networksContainer.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderWifiNetworks(networks) {
  const container = document.getElementById("wifiNetworks");
  if (!networks.length) {
    container.innerHTML = `<p class="empty">Nessuna rete WiFi gestita da CAPsMAN su questo router</p>`;
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
      registerInterfaceTraffic(net.name, trafficCell);
    }

    const allClients = net.clients || [];
    const shown = allClients.filter(clientMatchesFilter);
    const clientList = el("div", { class: "wifi-client-list" });
    if (!allClients.length) {
      clientList.appendChild(el("p", { class: "wifi-empty", text: "Nessun client collegato su questa radio" }));
    } else if (!shown.length) {
      clientList.appendChild(el("p", { class: "wifi-empty", text: "Nessun client collegato corrisponde al filtro per gruppo" }));
    } else {
      for (const c of shown) {
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
