"""SupervisorTik / mikrotik-gate: API REST per gestire interfacce, VLAN e client di un router MikroTik.

Il servizio è pensato per girare come container:
- direttamente sul router MikroTik (RouterOS 7.4+, feature "container"), oppure
- su un PC/server esterno con accesso di rete al router (che deve avere la REST API attiva).
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Response, status
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, get_settings
from .routeros import RouterOSClient, RouterOSError
from .schemas import (
    ClientBlockIn,
    ClientDisconnectIn,
    ClientOut,
    InterfaceOut,
    InterfaceStateIn,
    VlanCreateIn,
    VlanOut,
    VlanUpdateIn,
)
from .security import require_api_key

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mikrotik-gate")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.getLogger().setLevel(settings.log_level.upper())
    app.state.routeros = RouterOSClient(settings)
    logger.info("mikrotik-gate avviato, target RouterOS: %s:%s", settings.mikrotik_host, settings.mikrotik_port)
    try:
        yield
    finally:
        await app.state.routeros.aclose()


app = FastAPI(
    title="SupervisorTik / mikrotik-gate",
    description=(
        "API per operare su interfacce fisiche/VLAN di un router MikroTik e per gestire "
        "(bloccare/disconnettere) i client collegati."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


def get_client() -> RouterOSClient:
    return app.state.routeros


@app.exception_handler(RouterOSError)
async def routeros_error_handler(_request, exc: RouterOSError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc), "detail": exc.detail})


@app.get("/health", tags=["meta"])
async def health() -> dict:
    return {"status": "ok"}


@app.get("/", tags=["meta"])
async def root() -> dict:
    return {"service": "mikrotik-gate", "docs": "/docs", "ui": "/ui"}


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
    "/clients/block",
    tags=["client"],
    dependencies=[Depends(require_api_key)],
    summary="Blocca il traffico di un client (address-list + firewall drop, lease DHCP disabilitato)",
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
