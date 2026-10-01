"""TikPanel: interfaccia web (dashboard) per gestire interfacce, VLAN e client di un router
MikroTik, con sotto anche una API REST usata dalla dashboard stessa (e utilizzabile
direttamente per script e integrazioni).

Il servizio è pensato per girare come container:
- direttamente sul router MikroTik (RouterOS 7.4+, feature "container"), oppure
- su un PC/server esterno con accesso di rete al router (che deve avere la REST API attiva).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .clientstore import ClientDataError, ClientStore, normalize_mac
from .auth import create_bootstrap_token, create_session_token, decode_session_token
from .config import Settings, get_settings
from .routeros import RouterOSClient, RouterOSError
from .schemas import (
    AdminSetupIn,
    ClientBlockIn,
    ClientDisconnectIn,
    ClientOut,
    AccessAllowIn,
    AccessControlOut,
    AccessEnableIn,
    AccessLearningStartIn,
    AccessRevokeIn,
    ClientTrafficBatchIn,
    ClientTrafficBatchOut,
    ClientTrafficIn,
    GroupAssignIn,
    GroupIn,
    InterfaceTrafficBatchIn,
    InterfaceOut,
    InterfaceStateIn,
    LoginIn,
    LoginOut,
    TrafficOut,
    UserCreateIn,
    UserOut,
    UserUpdateIn,
    VlanCreateIn,
    VlanOut,
    VlanUpdateIn,
    WifiModuleStatusOut,
    WifiNetworkOut,
)
from .security import require_admin, require_api_key, require_bootstrap
from .users import UserError, UserStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tikpanel")


class _TrafficPollingLogFilter(logging.Filter):
    """La dashboard interroga /interfaces/*/traffic e /clients/traffic ogni pochi secondi
    per il traffico in tempo reale: senza questo filtro, il log di accesso (e quindi anche
    il log del container su RouterOS) viene sommerso da quelle richieste, rendendo
    praticamente introvabile un errore reale in mezzo. Silenzia solo le voci di access-log
    relative a questi due endpoint, lasciando intatto tutto il resto (inclusi gli warning
    che questo servizio emette quando RouterOS rifiuta una richiesta)."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        # silenzia anche il polling dello stato access-list (aggiornato ogni pochi secondi
        # mentre la modalità aggiunta client è aperta)
        return "/traffic" not in message and "GET /access-control HTTP" not in message


logging.getLogger("uvicorn.access").addFilter(_TrafficPollingLogFilter())


async def _access_watchdog() -> None:
    """Riattiva l'access-list quando scade la modalità aggiunta client.

    Vive lato server (non nel browser) e legge la scadenza dal file dati, quindi la rete non
    resta aperta per dimenticanza neanche se si chiude la pagina o si riavvia il container.
    Se RouterOS non risponde, ritenta al giro successivo.
    """
    while True:
        try:
            until = (await get_clients_store().snapshot())["learning_until"]
            if until is not None and time.time() >= until:
                await get_client().set_access_enforcement(True)
                await get_clients_store().set_learning_until(None)
                logger.info("Modalità aggiunta client scaduta: access-list riattivata")
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - il watchdog non deve mai morire
            logger.warning("Controllo scadenza access-list non riuscito, riprovo: %s", exc)
            await asyncio.sleep(10)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.getLogger().setLevel(settings.log_level.upper())
    app.state.routeros = RouterOSClient(settings)
    app.state.users = UserStore(settings.users_file)
    app.state.clients = ClientStore(settings.clients_file)
    await app.state.users.ensure_bootstrap_admin(settings.initial_admin_username, settings.initial_admin_password)
    logger.info("TiKPanel avviato, target RouterOS: %s:%s", settings.mikrotik_host, settings.mikrotik_port)
    watchdog = asyncio.create_task(_access_watchdog())
    try:
        yield
    finally:
        watchdog.cancel()
        try:
            await watchdog
        except asyncio.CancelledError:
            pass
        await app.state.routeros.aclose()


app = FastAPI(
    title="TikPanel",
    description=(
        "Interfaccia web e API per gestire interfacce fisiche/VLAN di un router MikroTik e per "
        "gestire (bloccare/disconnettere) i client collegati."
    ),
    version="0.9beta",
    lifespan=lifespan,
)


def get_client() -> RouterOSClient:
    return app.state.routeros


def get_users() -> UserStore:
    return app.state.users


def get_clients_store() -> ClientStore:
    return app.state.clients


@app.exception_handler(ClientDataError)
async def client_data_error_handler(_request, exc: ClientDataError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc), "detail": str(exc)})


@app.exception_handler(RouterOSError)
async def routeros_error_handler(_request, exc: RouterOSError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc), "detail": exc.detail})


@app.get("/health", tags=["meta"])
async def health() -> dict:
    return {"status": "ok", "build_sha": os.environ.get("BUILD_SHA", "unknown")}


@app.get("/", tags=["meta"])
async def root() -> dict:
    return {
        "service": "TikPanel",
        "version": "0.9beta",
        "build_sha": os.environ.get("BUILD_SHA", "unknown"),
        "docs": "/docs",
        "ui": "/ui",
    }


@app.get("/ui-config", tags=["meta"])
async def ui_config(settings: Settings = Depends(get_settings)) -> dict:
    """Configurazione di connessione per il frontend: nessun dato da inserire a mano.

    Impostata una volta a livello di container (variabile d'ambiente PUBLIC_BASE_URL),
    non richiesta all'utente della dashboard.
    """
    return {"apiBaseUrl": settings.public_base_url}


# ---------------------------------------------------------------------------
# Login (dashboard web)
# ---------------------------------------------------------------------------


@app.post("/auth/login", response_model=LoginOut, tags=["auth"])
async def login(body: LoginIn, settings: Settings = Depends(get_settings)) -> LoginOut:
    user = await get_users().verify_credentials(body.username, body.password)
    if user:
        token, expires_in = create_session_token(settings, user.username, user.role)
        return LoginOut(access_token=token, expires_in=expires_in, username=user.username, role=user.role)

    # Nessun utente reale corrisponde: proviamo le credenziali provvisorie da env var (valide
    # solo finché non esiste ancora nessun utente). Il token che ne esce non è una sessione
    # normale: autorizza solo POST /auth/setup-admin, mai il resto dell'API.
    if await get_users().verify_bootstrap(body.username, body.password):
        token, expires_in = create_bootstrap_token(settings, body.username)
        return LoginOut(
            access_token=token,
            expires_in=expires_in,
            username=body.username,
            role=None,
            must_setup_admin=True,
        )

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenziali non valide")


@app.post("/auth/setup-admin", response_model=LoginOut, tags=["auth"])
async def setup_admin(
    body: AdminSetupIn,
    settings: Settings = Depends(get_settings),
    _bootstrap_username: str = Depends(require_bootstrap),
) -> LoginOut:
    """Completa il login di bootstrap (credenziali da env var) creando il vero amministratore,
    con nome utente e password scelti qui e salvati con hash in users_file. Può esistere un solo
    amministratore: questa rotta funziona solo finché non esiste ancora nessun utente."""
    try:
        user = await get_users().setup_initial_admin(body.username, body.password)
    except UserError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    token, expires_in = create_session_token(settings, user.username, user.role)
    return LoginOut(access_token=token, expires_in=expires_in, username=user.username, role=user.role)


@app.get("/auth/me", tags=["auth"], dependencies=[Depends(require_api_key)])
async def me(authorization: str | None = Header(default=None)) -> dict:
    settings = get_settings()
    if not authorization or not authorization.lower().startswith("bearer "):
        # Autenticato con X-API-Key (uso programmatico), non c'è un utente associato
        return {"username": None, "role": None, "auth": "api-key"}
    try:
        payload = decode_session_token(settings, authorization[7:].strip())
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sessione non valida o scaduta")
    return {"username": payload.get("sub"), "role": payload.get("role"), "auth": "session"}


# ---------------------------------------------------------------------------
# Gestione utenti della dashboard (solo amministratore)
# ---------------------------------------------------------------------------


@app.get("/users", response_model=list[UserOut], tags=["users"], dependencies=[Depends(require_admin)])
async def list_users() -> list[UserOut]:
    return [UserOut(**u.model_dump()) for u in await get_users().list_users()]


@app.post("/users", response_model=UserOut, tags=["users"], dependencies=[Depends(require_admin)])
async def create_user(body: UserCreateIn) -> UserOut:
    try:
        user = await get_users().create_user(body.username, body.password, body.role)
    except UserError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return UserOut(**user.model_dump())


@app.patch("/users/{username}", response_model=UserOut, tags=["users"], dependencies=[Depends(require_admin)])
async def update_user(username: str, body: UserUpdateIn) -> UserOut:
    try:
        user = await get_users().update_user(
            username, password=body.password, role=body.role, disabled=body.disabled
        )
    except UserError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return UserOut(**user.model_dump())


@app.delete("/users/{username}", tags=["users"], dependencies=[Depends(require_admin)])
async def delete_user(username: str) -> dict:
    try:
        await get_users().delete_user(username)
    except UserError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"deleted": username}


# Dashboard web statica (bozza): serve i file in static/ su /ui.
_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if _STATIC_DIR.is_dir():
    app.mount("/ui", StaticFiles(directory=_STATIC_DIR, html=True), name="ui")


# ---------------------------------------------------------------------------
# Interfacce (fisiche e virtuali)
# ---------------------------------------------------------------------------


@app.get("/interfaces", response_model=list[InterfaceOut], tags=["interfacce"], dependencies=[Depends(require_api_key)])
async def list_interfaces() -> list[InterfaceOut]:
    raw = await get_client().list_interfaces()
    return [InterfaceOut.from_raw(item) for item in raw]


@app.get(
    "/interfaces/{name}", response_model=InterfaceOut, tags=["interfacce"], dependencies=[Depends(require_api_key)]
)
async def get_interface(name: str) -> InterfaceOut:
    raw = await get_client().get_interface(name)
    return InterfaceOut.from_raw(raw)


@app.put(
    "/interfaces/{name}/state",
    response_model=InterfaceOut,
    tags=["interfacce"],
    dependencies=[Depends(require_api_key)],
    summary="Abilita o disabilita un'interfaccia fisica o virtuale",
)
async def set_interface_state(name: str, body: InterfaceStateIn) -> InterfaceOut:
    raw = await get_client().set_interface_disabled(name, body.disabled)
    if raw is None:
        raw = await get_client().get_interface(name)
    return InterfaceOut.from_raw(raw)


@app.post(
    "/interfaces/traffic/batch",
    response_model=ClientTrafficBatchOut,
    tags=["interfacce"],
    dependencies=[Depends(require_api_key)],
    summary="Traffico istantaneo (bit/s) di più interfacce con una sola chiamata; chiave = nome",
)
async def get_interfaces_traffic_batch(body: InterfaceTrafficBatchIn) -> ClientTrafficBatchOut:
    raw = await get_client().monitor_interfaces_traffic(body.names)
    return ClientTrafficBatchOut(
        samples={
            name: (
                TrafficOut(rx_bps=s["rx_bps"], tx_bps=s["tx_bps"], available=True)
                if s is not None
                else TrafficOut(rx_bps=0, tx_bps=0, available=False)
            )
            for name, s in raw.items()
        }
    )


@app.get(
    "/interfaces/{name}/traffic",
    response_model=TrafficOut,
    tags=["interfacce"],
    dependencies=[Depends(require_api_key)],
    summary="Traffico istantaneo (bit/s) di un'interfaccia: fisica, VLAN o radio WiFi",
)
async def get_interface_traffic(name: str) -> TrafficOut:
    sample = await get_client().monitor_interface_traffic(name)
    if sample is None:
        return TrafficOut(rx_bps=0, tx_bps=0, available=False)
    return TrafficOut(rx_bps=sample["rx_bps"], tx_bps=sample["tx_bps"], available=True)


# ---------------------------------------------------------------------------
# VLAN
# ---------------------------------------------------------------------------


@app.get("/vlans", response_model=list[VlanOut], tags=["vlan"], dependencies=[Depends(require_api_key)])
async def list_vlans() -> list[VlanOut]:
    raw = await get_client().list_vlans()
    return [VlanOut.from_raw(item) for item in raw]


@app.get("/vlans/{name}", response_model=VlanOut, tags=["vlan"], dependencies=[Depends(require_api_key)])
async def get_vlan(name: str) -> VlanOut:
    raw = await get_client().get_vlan(name)
    return VlanOut.from_raw(raw)


@app.post("/vlans", response_model=VlanOut, status_code=201, tags=["vlan"], dependencies=[Depends(require_api_key)])
async def create_vlan(body: VlanCreateIn) -> VlanOut:
    await get_client().create_vlan(
        name=body.name,
        vlan_id=body.vlan_id,
        interface=body.interface,
        comment=body.comment,
        disabled=body.disabled,
    )
    raw = await get_client().get_vlan(body.name)
    return VlanOut.from_raw(raw)


@app.patch("/vlans/{name}", response_model=VlanOut, tags=["vlan"], dependencies=[Depends(require_api_key)])
async def update_vlan(name: str, body: VlanUpdateIn) -> VlanOut:
    await get_client().update_vlan(
        name,
        name=body.name,
        vlan_id=body.vlan_id,
        interface=body.interface,
        comment=body.comment,
        disabled=body.disabled,
    )
    raw = await get_client().get_vlan(body.name or name)
    return VlanOut.from_raw(raw)


@app.delete(
    "/vlans/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    tags=["vlan"],
    dependencies=[Depends(require_api_key)],
)
async def delete_vlan(name: str) -> Response:
    await get_client().delete_vlan(name)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Client collegati
# ---------------------------------------------------------------------------


@app.get("/clients", response_model=list[ClientOut], tags=["client"], dependencies=[Depends(require_api_key)])
async def list_clients() -> list[ClientOut]:
    raw = await get_client().list_clients()
    return [ClientOut(**item) for item in raw]


@app.post(
    "/clients/traffic",
    response_model=TrafficOut,
    tags=["client"],
    dependencies=[Depends(require_api_key)],
    summary="Traffico istantaneo (bit/s) stimato per un client, via torch su IP + interfaccia noti",
)
async def get_client_traffic(body: ClientTrafficIn) -> TrafficOut:
    sample = await get_client().monitor_client_traffic(body.ip_address, body.interface)
    if sample is None:
        return TrafficOut(rx_bps=0, tx_bps=0, available=False)
    return TrafficOut(rx_bps=sample["rx_bps"], tx_bps=sample["tx_bps"], available=True)


@app.post(
    "/clients/traffic/batch",
    response_model=ClientTrafficBatchOut,
    tags=["client"],
    dependencies=[Depends(require_api_key)],
    summary="Traffico istantaneo di più client: una sola lettura torch per interfaccia",
)
async def get_clients_traffic_batch(body: ClientTrafficBatchIn) -> ClientTrafficBatchOut:
    pairs = [(t.ip_address, t.interface) for t in body.targets if t.ip_address and t.interface]
    raw = await get_client().monitor_clients_traffic(pairs)
    samples = {
        ip: (
            TrafficOut(rx_bps=s["rx_bps"], tx_bps=s["tx_bps"], available=True)
            if s is not None
            else TrafficOut(rx_bps=0, tx_bps=0, available=False)
        )
        for ip, s in raw.items()
    }
    return ClientTrafficBatchOut(samples=samples)


# ---------------------------------------------------------------------------
# Access-list CAPsMAN (autorizzazione dei client per MAC) e gruppi di client
# ---------------------------------------------------------------------------


async def _access_control_state() -> AccessControlOut:
    client = get_client()
    store = await get_clients_store().snapshot()
    status_ = await client.get_access_control_status()

    leases = {}
    if status_["available"] and status_["allowed"]:
        for lease in await client.list_dhcp_leases():
            mac = (lease.get("mac-address") or "").upper()
            if mac:
                leases[mac] = lease

    until = store["learning_until"]
    seconds_left = max(0, int(until - time.time())) if until is not None else None
    learning = bool(status_["available"]) and not status_["enforced"] and seconds_left is not None and seconds_left > 0

    assignments = {m: g for m, g in store["assignments"].items() if g in store["groups"]}
    counts = {name: 0 for name in store["groups"]}
    for group in assignments.values():
        counts[group] += 1

    allowed = []
    for mac in status_["allowed"]:
        label = store["labels"].get(mac) or client._lease_hostname(leases.get(mac, {}))[0]
        allowed.append({"mac_address": mac, "label": label, "group": assignments.get(mac)})

    return AccessControlOut(
        available=status_["available"],
        stacks=status_["stacks"],
        configured=status_["configured"],
        enforced=status_["enforced"],
        learning=learning,
        learning_seconds_left=seconds_left if learning else None,
        default_learning_minutes=get_settings().access_learning_default_minutes,
        allowed=allowed,
        groups=[{"name": n, "members": counts[n]} for n in store["groups"]],
        assignments=assignments,
        labels=store["labels"],
    )


async def _kick_unauthorized() -> None:
    """Disconnette i client CAPsMAN collegati che non hanno una regola di autorizzazione."""
    client = get_client()
    allowed = set((await client.get_access_control_status())["allowed"])
    for net in await client.list_wifi_networks(capsman_only=True):
        for c in net.get("clients", []):
            if c["mac_address"].upper() not in allowed:
                await client.disconnect_client(c["mac_address"])


@app.get(
    "/access-control",
    response_model=AccessControlOut,
    tags=["access-list"],
    dependencies=[Depends(require_api_key)],
    summary="Stato dell'access-list CAPsMAN, client autorizzati, gruppi e assegnazioni",
)
async def access_control_state() -> AccessControlOut:
    return await _access_control_state()


@app.post(
    "/access-control/enable",
    response_model=AccessControlOut,
    tags=["access-list"],
    dependencies=[Depends(require_api_key)],
    summary="Attiva l'access-list: possono collegarsi solo i client autorizzati",
)
async def access_control_enable(body: AccessEnableIn) -> AccessControlOut:
    client = get_client()
    if body.authorize_connected:
        for net in await client.list_wifi_networks(capsman_only=True):
            for c in net.get("clients", []):
                await client.allow_client(c["mac_address"])
                if c.get("hostname"):
                    await get_clients_store().set_label(c["mac_address"], c["hostname"])
    await client.set_access_enforcement(True)
    await get_clients_store().set_learning_until(None)
    if body.disconnect_unauthorized:
        await _kick_unauthorized()
    return await _access_control_state()


@app.post(
    "/access-control/learning/start",
    response_model=AccessControlOut,
    tags=["access-list"],
    dependencies=[Depends(require_api_key)],
    summary="Sospende l'access-list per aggiungere nuovi client; si riattiva da sola alla scadenza",
)
async def access_control_learning_start(body: AccessLearningStartIn) -> AccessControlOut:
    minutes = body.minutes or get_settings().access_learning_default_minutes
    await get_client().set_access_enforcement(False)
    await get_clients_store().set_learning_until(time.time() + minutes * 60)
    return await _access_control_state()


@app.post(
    "/access-control/learning/stop",
    response_model=AccessControlOut,
    tags=["access-list"],
    dependencies=[Depends(require_api_key)],
    summary="Termina la modalità aggiunta client e riattiva l'access-list",
)
async def access_control_learning_stop(body: Optional[AccessEnableIn] = None) -> AccessControlOut:
    await get_client().set_access_enforcement(True)
    await get_clients_store().set_learning_until(None)
    if body and body.disconnect_unauthorized:
        await _kick_unauthorized()
    return await _access_control_state()


@app.get(
    "/access-control/debug",
    tags=["access-list"],
    dependencies=[Depends(require_api_key)],
    summary="Dati grezzi di access-list, interfacce e registrazioni WiFi (diagnostica)",
)
async def access_control_debug() -> dict:
    return await get_client().access_debug()


@app.post(
    "/access-control/allow",
    tags=["access-list"],
    dependencies=[Depends(require_api_key)],
    summary="Aggiunge un client (per MAC) all'access-list",
)
async def access_control_allow(body: AccessAllowIn) -> dict:
    mac = normalize_mac(body.mac_address)
    result = await get_client().allow_client(mac)
    if body.label:
        await get_clients_store().set_label(mac, body.label)
    return result


@app.post(
    "/access-control/revoke",
    tags=["access-list"],
    dependencies=[Depends(require_api_key)],
    summary="Toglie un client dall'access-list (opzionalmente lo disconnette subito)",
)
async def access_control_revoke(body: AccessRevokeIn) -> dict:
    mac = normalize_mac(body.mac_address)
    client = get_client()
    result = await client.disallow_client(mac)
    await get_clients_store().forget_label(mac)
    if body.disconnect:
        result["disconnect"] = await client.disconnect_client(mac)
    return result


@app.post("/groups", tags=["gruppi"], dependencies=[Depends(require_api_key)], summary="Crea un gruppo di client")
async def create_group(body: GroupIn) -> dict:
    return {"name": await get_clients_store().create_group(body.name)}


@app.patch("/groups/{name}", tags=["gruppi"], dependencies=[Depends(require_api_key)], summary="Rinomina un gruppo")
async def rename_group(name: str, body: GroupIn) -> dict:
    return {"name": await get_clients_store().rename_group(name, body.name)}


@app.delete(
    "/groups/{name}",
    tags=["gruppi"],
    dependencies=[Depends(require_api_key)],
    summary="Elimina un gruppo (i suoi client restano senza gruppo)",
)
async def delete_group(name: str) -> dict:
    return {"unassigned": await get_clients_store().delete_group(name)}


@app.put(
    "/clients/group",
    tags=["gruppi"],
    dependencies=[Depends(require_api_key)],
    summary="Assegna uno o più client a un gruppo (group vuoto = toglie dal gruppo)",
)
async def assign_clients_group(body: GroupAssignIn) -> dict:
    return {"assigned": await get_clients_store().assign(body.mac_addresses, body.group or None)}


# ---------------------------------------------------------------------------
# Reti WiFi (radio/SSID configurati + client raggruppati per radio)
# ---------------------------------------------------------------------------


@app.get(
    "/wifi-networks",
    response_model=list[WifiNetworkOut],
    tags=["wifi"],
    dependencies=[Depends(require_api_key)],
    summary="Reti WiFi configurate (qualunque stack: wifi/CAPsMAN/wireless) con i client collegati per radio",
)
async def list_wifi_networks() -> list[WifiNetworkOut]:
    raw = await get_client().list_wifi_networks()
    return [WifiNetworkOut(**item) for item in raw]


@app.get(
    "/wifi-modules",
    response_model=WifiModuleStatusOut,
    tags=["wifi"],
    dependencies=[Depends(require_api_key)],
    summary="Presenza dei moduli/driver WiFi (wireless legacy, CAPsMAN, nuovo pacchetto wifi) su questo router",
)
async def wifi_module_status() -> WifiModuleStatusOut:
    return WifiModuleStatusOut(**await get_client().get_wifi_module_status())


@app.post(
    "/clients/block",
    tags=["client"],
    dependencies=[Depends(require_api_key)],
    summary="Blocca un client per MAC address (drop sul firewall del bridge, chain input+forward)",
)
async def block_client(body: ClientBlockIn) -> dict:
    return await get_client().block_client(body.mac_address, body.ip_address)


@app.post(
    "/clients/unblock",
    tags=["client"],
    dependencies=[Depends(require_api_key)],
    summary="Rimuove un client dalla lista di blocco",
)
async def unblock_client(body: ClientBlockIn) -> dict:
    return await get_client().unblock_client(body.mac_address, body.ip_address)


@app.post(
    "/clients/disconnect",
    tags=["client"],
    dependencies=[Depends(require_api_key)],
    summary="Forza la disconnessione immediata di un client già collegato (wifi/hotspot/ARP)",
)
async def disconnect_client(body: ClientDisconnectIn) -> dict:
    return await get_client().disconnect_client(body.mac_address)


@app.post(
    "/clients/kick",
    tags=["client"],
    dependencies=[Depends(require_api_key)],
    summary="Blocca il client e ne forza subito la disconnessione (block + disconnect in un solo passo)",
)
async def kick_client(body: ClientBlockIn) -> dict:
    client = get_client()
    block_result = await client.block_client(body.mac_address, body.ip_address)
    disconnect_result = await client.disconnect_client(body.mac_address)
    return {"block": block_result, "disconnect": disconnect_result}
