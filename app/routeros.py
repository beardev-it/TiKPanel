"""Client minimale per la REST API di RouterOS (>= 7.1).

Documentazione RouterOS REST API: https://help.mikrotik.com/docs/display/ROS/REST+API
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from .config import Settings

logger = logging.getLogger("mikrotik-gate.routeros")


class RouterOSError(RuntimeError):
    """Errore restituito da RouterOS o dal trasporto verso di esso."""

    def __init__(self, message: str, status_code: int = 502, detail: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail


async def verify_user_credentials(
    settings: Settings, username: str, password: str
) -> bool:
    """Verifica in tempo reale una coppia utente/password contro la REST API di RouterOS.

    Usata dal login della dashboard: se la richiesta ha successo, l'utente esiste,
    non è disabilitato e appartiene a un gruppo con permessi api/rest-api — RouterOS
    stesso fa da "elenco degli utenti abilitati", senza bisogno di duplicarlo qui.
    Non viene mai loggata né persistita la password.
    """
    scheme = "https" if settings.mikrotik_use_ssl else "http"
    base_url = f"{scheme}://{settings.mikrotik_host}:{settings.mikrotik_port}/rest"
    async with httpx.AsyncClient(
        base_url=base_url,
        auth=(username, password),
        verify=settings.mikrotik_verify_ssl,
        timeout=settings.mikrotik_timeout,
    ) as client:
        try:
            resp = await client.get("/system/identity")
        except httpx.TransportError as exc:
            raise RouterOSError(f"Impossibile raggiungere il router MikroTik: {exc}", status_code=502) from exc
        return resp.status_code == 200


class RouterOSClient:
    """Wrapper sottile su httpx per parlare con la REST API di RouterOS."""

    def __init__(self, settings: Settings):
        scheme = "https" if settings.mikrotik_use_ssl else "http"
        base_url = f"{scheme}://{settings.mikrotik_host}:{settings.mikrotik_port}/rest"
        self._client = httpx.AsyncClient(
            base_url=base_url,
            auth=(settings.mikrotik_user, settings.mikrotik_password),
            verify=settings.mikrotik_verify_ssl,
            timeout=settings.mikrotik_timeout,
        )
        self.settings = settings

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            resp = await self._client.request(method, path, **kwargs)
        except httpx.TransportError as exc:
            logger.error("Errore di trasporto verso RouterOS (%s %s): %s", method, path, exc)
            raise RouterOSError(f"Impossibile raggiungere il router MikroTik: {exc}", status_code=502) from exc

        if resp.status_code >= 400:
            try:
                detail = resp.json()
            except Exception:
                detail = resp.text
            logger.warning("RouterOS ha risposto %s per %s %s: %s", resp.status_code, method, path, detail)
            raise RouterOSError(
                f"RouterOS ha rifiutato la richiesta ({resp.status_code})",
                status_code=422 if resp.status_code < 500 else 502,
                detail=detail,
            )

        if not resp.content:
            return None
        return resp.json()

    # ---------- interfacce (fisiche e virtuali) ----------

    async def list_interfaces(self) -> list[dict]:
        return await self._request("GET", "/interface")

    async def get_interface(self, name_or_id: str) -> dict:
        items = await self._request("GET", "/interface", params={"name": name_or_id})
        if not items:
            # può essere un .id RouterOS (es. *1) invece del nome
            items = [await self._request("GET", f"/interface/{name_or_id}")]
        if not items:
            raise RouterOSError(f"Interfaccia '{name_or_id}' non trovata", status_code=404)
        return items[0]

    async def set_interface_disabled(self, name_or_id: str, disabled: bool) -> dict:
        iface = await self.get_interface(name_or_id)
        iface_id = iface[".id"]
        return await self._request(
            "PATCH", f"/interface/{iface_id}", json={"disabled": "yes" if disabled else "no"}
        )

    async def set_interface_comment(self, name_or_id: str, comment: str) -> dict:
        iface = await self.get_interface(name_or_id)
        iface_id = iface[".id"]
        return await self._request("PATCH", f"/interface/{iface_id}", json={"comment": comment})

    # ---------- VLAN (interface/vlan) ----------

    async def list_vlans(self) -> list[dict]:
        return await self._request("GET", "/interface/vlan")

    async def get_vlan(self, name_or_id: str) -> dict:
        items = await self._request("GET", "/interface/vlan", params={"name": name_or_id})
        if not items:
            try:
                items = [await self._request("GET", f"/interface/vlan/{name_or_id}")]
            except RouterOSError:
                items = []
        if not items:
            raise RouterOSError(f"VLAN '{name_or_id}' non trovata", status_code=404)
        return items[0]

    async def create_vlan(
        self, name: str, vlan_id: int, interface: str, comment: Optional[str] = None, disabled: bool = False
    ) -> dict:
        payload = {
            "name": name,
            "vlan-id": str(vlan_id),
            "interface": interface,
            "disabled": "yes" if disabled else "no",
        }
        if comment:
            payload["comment"] = comment
        return await self._request("PUT", "/interface/vlan", json=payload)

    async def update_vlan(self, name_or_id: str, **fields: Any) -> dict:
        vlan = await self.get_vlan(name_or_id)
        vlan_id = vlan[".id"]
        payload = {}
        if "vlan_id" in fields and fields["vlan_id"] is not None:
            payload["vlan-id"] = str(fields["vlan_id"])
        if "interface" in fields and fields["interface"] is not None:
            payload["interface"] = fields["interface"]
        if "name" in fields and fields["name"] is not None:
            payload["name"] = fields["name"]
        if "comment" in fields and fields["comment"] is not None:
            payload["comment"] = fields["comment"]
        if "disabled" in fields and fields["disabled"] is not None:
            payload["disabled"] = "yes" if fields["disabled"] else "no"
        if not payload:
            return vlan
        return await self._request("PATCH", f"/interface/vlan/{vlan_id}", json=payload)

    async def delete_vlan(self, name_or_id: str) -> None:
        vlan = await self.get_vlan(name_or_id)
        vlan_id = vlan[".id"]
        await self._request("DELETE", f"/interface/vlan/{vlan_id}")

    # ---------- client collegati ----------

    async def list_dhcp_leases(self) -> list[dict]:
        return await self._request("GET", "/ip/dhcp-server/lease")

    async def list_arp(self) -> list[dict]:
        return await self._request("GET", "/ip/arp")

    async def list_wireless_registrations(self) -> list[dict]:
        try:
            return await self._request("GET", "/interface/wireless/registration-table")
        except RouterOSError as exc:
            if exc.status_code == 404:
                return []
            raise

    async def list_capsman_registrations(self) -> list[dict]:
        try:
            return await self._request("GET", "/caps-man/registration-table")
        except RouterOSError as exc:
            if exc.status_code == 404:
                return []
            raise

    async def list_hotspot_active(self) -> list[dict]:
        try:
            return await self._request("GET", "/ip/hotspot/active")
        except RouterOSError as exc:
            if exc.status_code == 404:
                return []
            raise

    async def list_clients(self) -> list[dict]:
        """Vista unificata dei client noti: incrocia lease DHCP, ARP e tabelle wireless."""
        leases = await self.list_dhcp_leases()
        arp = await self.list_arp()
        wireless = await self.list_wireless_registrations()
        capsman = await self.list_capsman_registrations()
        hotspot = await self.list_hotspot_active()

        by_mac: dict[str, dict] = {}

        def norm(mac: Optional[str]) -> Optional[str]:
            return mac.upper() if mac else None

        for lease in leases:
            mac = norm(lease.get("mac-address"))
            if not mac:
                continue
            entry = by_mac.setdefault(mac, {"mac_address": mac})
            entry.update(
                {
                    "ip_address": lease.get("address"),
                    "hostname": lease.get("host-name"),
                    "dhcp_status": lease.get("status"),
                    "dhcp_lease_id": lease.get(".id"),
                    "dhcp_disabled": lease.get("disabled") == "true",
                    "blocked": lease.get("block-access") == "true",
                }
            )

        for entry_arp in arp:
            mac = norm(entry_arp.get("mac-address"))
            if not mac:
                continue
            entry = by_mac.setdefault(mac, {"mac_address": mac})
            entry.setdefault("ip_address", entry_arp.get("address"))
            entry["arp_interface"] = entry_arp.get("interface")
            entry["arp_id"] = entry_arp.get(".id")

        for reg in wireless:
            mac = norm(reg.get("mac-address"))
            if not mac:
                continue
            entry = by_mac.setdefault(mac, {"mac_address": mac})
            entry["connection"] = "wireless"
            entry["wireless_interface"] = reg.get("interface")
            entry["wireless_registration_id"] = reg.get(".id")
            entry["signal_strength"] = reg.get("signal-strength")

        for reg in capsman:
            mac = norm(reg.get("mac-address"))
            if not mac:
                continue
            entry = by_mac.setdefault(mac, {"mac_address": mac})
            entry["connection"] = "wireless (CAPsMAN)"
            entry["capsman_interface"] = reg.get("interface")
            entry["capsman_registration_id"] = reg.get(".id")
            entry["signal_strength"] = reg.get("signal-strength", entry.get("signal_strength"))

        for act in hotspot:
            mac = norm(act.get("mac-address"))
            if not mac:
                continue
            entry = by_mac.setdefault(mac, {"mac_address": mac})
            entry["hotspot_active_id"] = act.get(".id")
            entry["hotspot_user"] = act.get("user")

        return list(by_mac.values())

    async def _ensure_block_list_rule(self) -> None:
        """Crea (se assenti) le regole firewall che scartano il traffico della address-list di blocco."""
        list_name = self.settings.block_address_list
        existing_forward = await self._request(
            "GET",
            "/ip/firewall/filter",
            params={"src-address-list": list_name, "chain": "forward"},
        )
        if not existing_forward:
            await self._request(
                "PUT",
                "/ip/firewall/filter",
                json={
                    "chain": "forward",
                    "src-address-list": list_name,
                    "action": "drop",
                    "comment": f"mikrotik-gate: blocca client in {list_name}",
                },
            )
        existing_forward_dst = await self._request(
            "GET",
            "/ip/firewall/filter",
            params={"dst-address-list": list_name, "chain": "forward"},
        )
        if not existing_forward_dst:
            await self._request(
                "PUT",
                "/ip/firewall/filter",
                json={
                    "chain": "forward",
                    "dst-address-list": list_name,
                    "action": "drop",
                    "comment": f"mikrotik-gate: blocca client in {list_name} (risposte)",
                },
            )

    async def block_client(self, mac_address: str, ip_address: Optional[str] = None) -> dict:
        """Blocca un client: address-list + drop firewall, opzionale disabilitazione lease DHCP."""
        list_name = self.settings.block_address_list

        if self.settings.auto_create_firewall_rule:
            await self._ensure_block_list_rule()

        if ip_address:
            existing = await self._request(
                "GET", "/ip/firewall/address-list", params={"list": list_name, "address": ip_address}
            )
            if not existing:
                await self._request(
                    "PUT",
                    "/ip/firewall/address-list",
                    json={"list": list_name, "address": ip_address, "comment": f"mikrotik-gate: {mac_address}"},
                )

        leases = await self._request("GET", "/ip/dhcp-server/lease", params={"mac-address": mac_address})
        for lease in leases:
            await self._request("PATCH", f"/ip/dhcp-server/lease/{lease['.id']}", json={"block-access": "yes"})

        return {"mac_address": mac_address, "ip_address": ip_address, "blocked": True, "address_list": list_name}

    async def unblock_client(self, mac_address: str, ip_address: Optional[str] = None) -> dict:
        list_name = self.settings.block_address_list

        if ip_address:
            existing = await self._request(
                "GET", "/ip/firewall/address-list", params={"list": list_name, "address": ip_address}
            )
            for item in existing:
                await self._request("DELETE", f"/ip/firewall/address-list/{item['.id']}")

        leases = await self._request("GET", "/ip/dhcp-server/lease", params={"mac-address": mac_address})
        for lease in leases:
            await self._request("PATCH", f"/ip/dhcp-server/lease/{lease['.id']}", json={"block-access": "no"})

        return {"mac_address": mac_address, "ip_address": ip_address, "blocked": False, "address_list": list_name}

    async def disconnect_client(self, mac_address: str) -> dict:
        """Forza la disconnessione immediata di un client già collegato (wifi/hotspot/ARP)."""
        actions: list[str] = []
        mac_upper = mac_address.upper()

        wireless = await self.list_wireless_registrations()
        for reg in wireless:
            if (reg.get("mac-address") or "").upper() == mac_upper:
                await self._request("DELETE", f"/interface/wireless/registration-table/{reg['.id']}")
                actions.append("rimosso dalla tabella di registrazione wireless")

        capsman = await self.list_capsman_registrations()
        for reg in capsman:
            if (reg.get("mac-address") or "").upper() == mac_upper:
                await self._request("DELETE", f"/caps-man/registration-table/{reg['.id']}")
                actions.append("rimosso dalla tabella di registrazione CAPsMAN")

        hotspot = await self.list_hotspot_active()
        for act in hotspot:
            if (act.get("mac-address") or "").upper() == mac_upper:
                await self._request("DELETE", f"/ip/hotspot/active/{act['.id']}")
                actions.append("sessione hotspot terminata")

        arp = await self.list_arp()
        for entry in arp:
            if (entry.get("mac-address") or "").upper() == mac_upper:
                await self._request("DELETE", f"/ip/arp/{entry['.id']}")
                actions.append("voce ARP rimossa")

        if not actions:
            actions.append(
                "nessuna sessione attiva trovata da terminare direttamente: per un client cablato "
                "usa /clients/block per tagliargli il traffico, oppure disabilita la porta bridge dedicata"
            )

        return {"mac_address": mac_address, "actions": actions}
