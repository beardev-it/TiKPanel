"""Client minimale per la REST API di RouterOS (>= 7.1).

Documentazione RouterOS REST API: https://help.mikrotik.com/docs/display/ROS/REST+API
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import httpx

from .config import Settings

logger = logging.getLogger("tikpanel.routeros")


class RouterOSError(RuntimeError):
    """Errore restituito da RouterOS o dal trasporto verso di esso.

    `status_code` è lo status HTTP che TikPanel restituisce al chiamante (422 per
    errori RouterOS < 500, 502 per errori di trasporto/RouterOS >= 500) — NON lo
    status originale di RouterOS, che invece è in `upstream_status_code` (es. 400
    o 404 per un menu non disponibile). I controlli "questo è un menu opzionale
    assente" devono guardare `upstream_status_code`, non `status_code`.
    """

    def __init__(
        self,
        message: str,
        status_code: int = 502,
        detail: Any = None,
        upstream_status_code: Optional[int] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail
        self.upstream_status_code = upstream_status_code


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
                upstream_status_code=resp.status_code,
            )

        if not resp.content:
            return None
        return resp.json()

    # ---------- interfacce (fisiche e virtuali) ----------

    async def list_interfaces(self) -> list[dict]:
        # RouterOS a volte risponde 200 con body vuoto (non "[]") quando una lista non ha
        # elementi: senza il fallback qui, il chiamante riceverebbe None e crasherebbe
        # iterandoci sopra invece di vedere semplicemente "nessuna interfaccia".
        return await self._request("GET", "/interface") or []

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

    async def monitor_interface_traffic(self, name_or_id: str) -> Optional[dict]:
        """Traffico istantaneo di una qualunque interfaccia RouterOS (fisica, VLAN, radio
        WiFi/CAPsMAN/wireless: sono tutte interfacce dal punto di vista di RouterOS).

        Usa /interface/monitor-traffic con once=yes: è RouterOS stesso a campionare e
        calcolare i bit/s, non serve calcolare delta lato nostro tra due letture.
        """
        try:
            result = await self._request(
                "POST", "/interface/monitor-traffic", json={"interface": name_or_id, "once": "yes"}
            )
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return None
            raise
        if not result:
            return None
        sample = result[0] if isinstance(result, list) else result
        return {
            "rx_bps": int(sample.get("rx-bits-per-second", 0) or 0),
            "tx_bps": int(sample.get("tx-bits-per-second", 0) or 0),
            "rx_packets_per_second": int(sample.get("rx-packets-per-second", 0) or 0),
            "tx_packets_per_second": int(sample.get("tx-packets-per-second", 0) or 0),
        }

    async def monitor_interfaces_traffic(self, names: list[str]) -> dict[str, Optional[dict]]:
        """Traffico di più interfacce con UNA sola chiamata a /interface/monitor-traffic
        (accetta un elenco separato da virgole e restituisce una riga per interfaccia,
        identificata dal campo "name"). {nome: {"rx_bps","tx_bps"} | None}."""
        names = [n for n in dict.fromkeys(names) if n]
        if not names:
            return {}
        try:
            result = await self._request(
                "POST", "/interface/monitor-traffic", json={"interface": ",".join(names), "once": "yes"}
            )
        except RouterOSError:
            return {n: None for n in names}  # già loggato da _request
        samples: dict[str, Optional[dict]] = {n: None for n in names}
        for row in result if isinstance(result, list) else [result or {}]:
            name = row.get("name") or (names[0] if len(names) == 1 else None)
            if name in samples:
                samples[name] = {
                    "rx_bps": int(row.get("rx-bits-per-second", 0) or 0),
                    "tx_bps": int(row.get("tx-bits-per-second", 0) or 0),
                }
        return samples

    # ---------- VLAN (interface/vlan) ----------

    async def list_vlans(self) -> list[dict]:
        return await self._request("GET", "/interface/vlan") or []

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

    # RouterOS non è coerente: un menu assente (pacchetto non installato, hardware senza
    # wireless, CAPsMAN non configurato, nessun server DHCP...) a volte risponde 404, a
    # volte 400. Trattiamo entrambi come "funzionalità non disponibile qui" -> lista vuota,
    # mai un errore per l'utente: il caso "nessun client collegato a nessuna WiFi" (o nessun
    # server DHCP configurato) deve essere silenzioso, non un 422 in dashboard.
    _OPTIONAL_MENU_STATUS_CODES = (400, 404)

    async def list_dhcp_leases(self) -> list[dict]:
        return await self._list_optional("/ip/dhcp-server/lease")

    async def list_arp(self) -> list[dict]:
        return await self._list_optional("/ip/arp")

    async def list_wireless_registrations(self) -> list[dict]:
        try:
            return await self._request("GET", "/interface/wireless/registration-table") or []
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return []
            raise

    async def list_capsman_registrations(self) -> list[dict]:
        try:
            return await self._request("GET", "/caps-man/registration-table") or []
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return []
            raise

    async def list_wifi_registrations(self) -> list[dict]:
        """Client registrati sul nuovo pacchetto 'wifi' (RouterOS >= 7.13, sostituisce wireless-cm2)."""
        try:
            return await self._request("GET", "/interface/wifi/registration-table") or []
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return []
            raise

    async def list_hotspot_active(self) -> list[dict]:
        try:
            return await self._request("GET", "/ip/hotspot/active") or []
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return []
            raise

    @staticmethod
    def _lease_hostname(lease: dict) -> tuple[Optional[str], Optional[str]]:
        """Hostname da mostrare per un client, con una riserva quando RouterOS non ne ha
        ricevuto uno dal client via DHCP (host-name vuoto: dispositivo che non lo invia,
        randomizzazione privacy, IP statico, lease creato a mano...). In quel caso usiamo il
        commento del lease, se l'amministratore ne ha assegnato uno manualmente in RouterOS —
        non è "letto" dal client, è un'etichetta scelta da chi gestisce il router.
        Ritorna (hostname, source) dove source è 'dhcp' o 'comment' (None se non c'è nulla)."""
        host_name = (lease.get("host-name") or "").strip()
        if host_name:
            return host_name, "dhcp"
        comment = (lease.get("comment") or "").strip()
        if comment:
            return comment, "comment"
        return None, None

    async def list_clients(self) -> list[dict]:
        """Vista unificata dei client noti: incrocia lease DHCP, ARP e tabelle wireless."""
        leases = await self.list_dhcp_leases()
        arp = await self.list_arp()
        wireless = await self.list_wireless_registrations()
        capsman = await self.list_capsman_registrations()
        wifi = await self.list_wifi_registrations()
        hotspot = await self.list_hotspot_active()

        by_mac: dict[str, dict] = {}

        def norm(mac: Optional[str]) -> Optional[str]:
            return mac.upper() if mac else None

        for lease in leases:
            mac = norm(lease.get("mac-address"))
            if not mac:
                continue
            entry = by_mac.setdefault(mac, {"mac_address": mac})
            hostname, hostname_source = self._lease_hostname(lease)
            entry.update(
                {
                    "ip_address": lease.get("address"),
                    "hostname": hostname,
                    "hostname_source": hostname_source,
                    "dhcp_status": lease.get("status"),
                    "dhcp_lease_id": lease.get(".id"),
                    "dhcp_disabled": lease.get("disabled") == "true",
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

        for reg in wifi:
            mac = norm(reg.get("mac-address"))
            if not mac:
                continue
            entry = by_mac.setdefault(mac, {"mac_address": mac})
            entry["connection"] = "wireless (WiFi)"
            entry["wifi_interface"] = reg.get("interface")
            entry["wifi_registration_id"] = reg.get(".id")
            entry["signal_strength"] = reg.get("signal-strength", entry.get("signal_strength"))

        for act in hotspot:
            mac = norm(act.get("mac-address"))
            if not mac:
                continue
            entry = by_mac.setdefault(mac, {"mac_address": mac})
            entry["hotspot_active_id"] = act.get(".id")
            entry["hotspot_user"] = act.get("user")

        blocked_macs = {
            self._strip_mac_mask(r.get("src-mac-address")) for r in await self._list_bridge_block_rules()
        }
        for mac, entry in by_mac.items():
            entry["blocked"] = mac in blocked_macs

        return list(by_mac.values())

    # Blocco client via MAC address, a livello 2, sul firewall del bridge — non tocca IP,
    # lease DHCP o address-list: funziona a prescindere da come il client ottiene l'IP
    # (dinamico, statico, o anche senza affatto un lease), e non ha effetti collaterali
    # persistenti come rendere statico un lease.
    #
    # RouterOS espone due chain rilevanti su /interface/bridge/filter:
    # - "input": pacchetti il cui MAC di destinazione è il bridge stesso, cioè TUTTO il
    #   traffico che il client manda verso il gateway (quindi anche instradato: internet,
    #   altre VLAN...) — bloccarlo qui lo scarta PRIMA che raggiunga lo stack IP.
    # - "forward": pacchetti scambiati direttamente fra due host sulla stessa bridge (L2
    #   puro, senza passare dal router) — serve a impedire anche la comunicazione diretta
    #   con altri dispositivi sulla stessa rete locale.
    # Un blocco completo richiede entrambe; senza "forward" il client bloccato potrebbe
    # ancora raggiungere altri host sulla stessa LAN senza passare dal gateway.
    _BRIDGE_BLOCK_CHAINS = ("input", "forward")
    # RouterOS vuole sempre una maschera esplicita su src-mac-address/dst-mac-address quando
    # la regola viene creata via API o script ("invalid value for argument src-mac-address"
    # senza): WinBox la aggiunge da sola (di default /48, cioè "match esatto"), ma la REST
    # API no. /FF:FF:FF:FF:FF:FF è la maschera a 48 bit: match sul MAC esatto, nessun range.
    _MAC_EXACT_MASK = "FF:FF:FF:FF:FF:FF"

    @staticmethod
    def _bridge_block_comment(mac_address: str) -> str:
        return f"TikPanel: blocca client {mac_address.upper()}"

    @classmethod
    def _mac_with_exact_mask(cls, mac_address: str) -> str:
        return f"{mac_address}/{cls._MAC_EXACT_MASK}"

    @staticmethod
    def _strip_mac_mask(value: Optional[str]) -> str:
        """RouterOS restituisce src-mac-address/dst-mac-address con la maschera inclusa
        (es. "AA:BB:CC:DD:EE:FF/FF:FF:FF:FF:FF:FF"): per confrontarlo con un MAC "nudo"
        va tolta la parte dopo la "/"."""
        return (value or "").split("/", 1)[0].upper()

    async def _list_bridge_block_rules(self, mac_address: Optional[str] = None) -> list[dict]:
        rules = await self._list_optional("/interface/bridge/filter")
        prefix = "TikPanel: blocca client "
        matching = [r for r in rules if (r.get("comment") or "").startswith(prefix)]
        if mac_address is None:
            return matching
        comment = self._bridge_block_comment(mac_address)
        return [r for r in matching if r.get("comment") == comment]

    async def block_client(self, mac_address: str, ip_address: Optional[str] = None) -> dict:
        """Blocca un client per MAC address sul firewall del bridge (chain input + forward,
        drop): non richiede né modifica il lease DHCP, funziona anche per client con IP
        statico o senza lease. Se il router non ha nessuna interfaccia bridge (LAN instradata
        senza bridging), queste rule non hanno alcun bridge su cui applicarsi e non bloccano
        nulla: in quel caso serve un'altra strategia (fuori dai casi comuni, non gestita qui)."""
        comment = self._bridge_block_comment(mac_address)
        existing_chains = {r.get("chain") for r in await self._list_bridge_block_rules(mac_address)}
        for chain in self._BRIDGE_BLOCK_CHAINS:
            if chain in existing_chains:
                continue
            await self._request(
                "PUT",
                "/interface/bridge/filter",
                json={
                    "chain": chain,
                    "action": "drop",
                    "src-mac-address": self._mac_with_exact_mask(mac_address),
                    "comment": comment,
                },
            )
        return {"mac_address": mac_address, "ip_address": ip_address, "blocked": True, "method": "bridge-mac"}

    async def unblock_client(self, mac_address: str, ip_address: Optional[str] = None) -> dict:
        for rule in await self._list_bridge_block_rules(mac_address):
            await self._request("DELETE", f"/interface/bridge/filter/{rule['.id']}")
        await self._clear_legacy_block_leftovers(mac_address)
        return {"mac_address": mac_address, "ip_address": ip_address, "blocked": False, "method": "bridge-mac"}

    async def _clear_legacy_block_leftovers(self, mac_address: str) -> None:
        """Pulizia dei residui delle due versioni precedenti del blocco client (address-list
        IP + drop sul forward, poi block-access sul lease DHCP), sostituite dal blocco per
        MAC sul bridge: un client bloccato PRIMA del passaggio al nuovo meccanismo resterebbe
        altrimenti bloccato per sempre, perché lo sblocco nuovo non tocca lease o address-list
        e quindi non li rimuoverebbe mai da solo. Innocuo se non c'è nulla da pulire."""
        leases = await self._list_optional_params("/ip/dhcp-server/lease", {"mac-address": mac_address})
        for lease in leases:
            if lease.get("block-access") == "true":
                await self._request(
                    "PATCH", f"/ip/dhcp-server/lease/{lease['.id']}", json={"block-access": "no"}
                )

        legacy_comment = f"TiKPanel: {mac_address}".upper()
        for entry in await self._list_optional("/ip/firewall/address-list"):
            if (entry.get("comment") or "").upper() == legacy_comment:
                await self._request("DELETE", f"/ip/firewall/address-list/{entry['.id']}")

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

        wifi = await self.list_wifi_registrations()
        for reg in wifi:
            if (reg.get("mac-address") or "").upper() == mac_upper:
                await self._request("DELETE", f"/interface/wifi/registration-table/{reg['.id']}")
                actions.append("rimosso dalla tabella di registrazione WiFi")

        hotspot = await self.list_hotspot_active()
        for act in hotspot:
            if (act.get("mac-address") or "").upper() == mac_upper:
                await self._request("DELETE", f"/ip/hotspot/active/{act['.id']}")
                actions.append("sessione hotspot terminata")

        if not actions:
            # Un client cablato (o comunque non associato a nessuna radio/hotspot) non ha una
            # "sessione" che RouterOS possa chiudere: cancellare la voce ARP non lo disconnette
            # davvero, si ripopola al primo pacchetto successivo. L'unica azione reale è
            # bloccargli il traffico via MAC (block_client), non "disconnetterlo".
            actions.append(
                "nessuna sessione wireless/hotspot attiva trovata per questo MAC: un client cablato "
                "non può essere disconnesso da RouterOS, può solo essere bloccato via MAC "
                "(usa /clients/block) o scollegato fisicamente / disabilitando la porta dedicata"
            )

        return {"mac_address": mac_address, "actions": actions}

    # ---------- reti WiFi (radio/SSID configurati + client raggruppati) ----------

    async def _list_optional(self, path: str) -> list[dict]:
        """GET generico che tratta un menu assente (pacchetto non installato / hardware senza
        wireless) come lista vuota invece che come errore. Anche una lista genuinamente vuota
        conta: RouterOS a volte risponde 200 con body vuoto invece di "[]", nel qual caso
        _request ritorna None — senza il fallback qui il chiamante crasherebbe iterandoci."""
        try:
            return await self._request("GET", path) or []
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return []
            raise

    async def _list_optional_params(self, path: str, params: dict) -> list[dict]:
        """Come _list_optional, ma con query params (es. filtro per mac-address)."""
        try:
            return await self._request("GET", path, params=params) or []
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return []
            raise

    async def _menu_available(self, path: str) -> bool:
        """True se il menu esiste su questo router (pacchetto/driver presente), anche se
        vuoto. False solo se RouterOS risponde "no such command or directory" (400/404):
        pacchetto non installato o hardware assente. Usato per il badge "moduli installati",
        non per elencare dati (per quello si usa _list_optional/_get_optional, che su un
        menu assente tornano [] / None invece di propagare l'errore)."""
        try:
            await self._request("GET", path)
            return True
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return False
            raise

    async def get_wifi_module_status(self) -> dict:
        """Presenza dei moduli/driver WiFi su questo router, per il badge in testata.
        Indipendente dal fatto che siano configurati o abbiano client collegati."""
        return {
            "wireless": await self._menu_available("/interface/wireless"),
            "capsman": await self._menu_available("/caps-man/interface"),
            "wifi": await self._menu_available("/interface/wifi"),
        }

    # ---------- access-list CAPsMAN: autorizzazione dei client per MAC ----------
    #
    # Modello: nell'access-list di CAPsMAN le regole si valutano in ordine e vince la prima
    # che corrisponde. TikPanel mantiene
    #   - una regola "accept" per ogni MAC autorizzato (commento "TikPanel: autorizzato <MAC>")
    #   - UNA regola "reject" senza criteri (vale per tutti), sempre in fondo, che è
    #     l'interruttore: abilitata = solo i client in elenco possono collegarsi; disabilitata
    #     = chiunque può collegarsi (modalità "aggiunta client").
    # Le regole create a mano sul router (senza il nostro commento) non vengono toccate.
    #
    # Quale access-list: con CAPsMAN v2 (pacchetto 'wifi', RouterOS >= 7.13) è
    # /interface/wifi/access-list; con il vecchio CAPsMAN è /caps-man/access-list. Se sono
    # presenti entrambi gli stack si scrive su entrambi, così la regola vale per tutti i CAP.

    _ACCESS_REJECT_COMMENT = "TikPanel: nega i client non autorizzati"
    _ACCESS_ALLOW_PREFIX = "TikPanel: autorizzato "

    async def _access_menus(self) -> list[tuple[str, str]]:
        legacy = await self._menu_available("/caps-man/interface")
        wifi = await self._menu_available("/interface/wifi")
        wifi_capsman = await self._get_optional("/interface/wifi/capsman")
        wifi_v2 = bool(wifi_capsman) and wifi_capsman.get("enabled") == "true"
        menus: list[tuple[str, str]] = []
        if wifi and (wifi_v2 or not legacy):
            menus.append(("wifi", "/interface/wifi/access-list"))
        if legacy:
            menus.append(("capsman", "/caps-man/access-list"))
        return menus

    @classmethod
    def _allow_comment(cls, mac_address: str) -> str:
        return f"{cls._ACCESS_ALLOW_PREFIX}{mac_address.upper()}"

    async def _ensure_reject_rule(self, path: str, disabled: Optional[bool]) -> None:
        """Garantisce che la regola 'reject' esista, sia l'ULTIMA dell'access-list e (se
        `disabled` non è None) abbia lo stato richiesto. Se non è in fondo la si ricrea:
        RouterOS valuta in ordine, e una 'reject' davanti alle 'accept' le renderebbe inutili."""
        entries = await self._list_optional(path)
        rejects = [e for e in entries if e.get("comment") == self._ACCESS_REJECT_COMMENT]
        if not rejects:
            if disabled is None:
                return  # niente da riordinare: l'access-list non è ancora stata attivata
            await self._request(
                "PUT",
                path,
                json={
                    "action": "reject",
                    "comment": self._ACCESS_REJECT_COMMENT,
                    "disabled": "yes" if disabled else "no",
                },
            )
            return

        reject = rejects[0]
        currently_disabled = reject.get("disabled") == "true"
        target_disabled = currently_disabled if disabled is None else disabled
        is_last = bool(entries) and entries[-1].get(".id") == reject.get(".id")
        if not is_last:
            await self._request("DELETE", f"{path}/{reject['.id']}")
            await self._request(
                "PUT",
                path,
                json={
                    "action": "reject",
                    "comment": self._ACCESS_REJECT_COMMENT,
                    "disabled": "yes" if target_disabled else "no",
                },
            )
        elif target_disabled != currently_disabled:
            await self._request(
                "PATCH", f"{path}/{reject['.id']}", json={"disabled": "yes" if target_disabled else "no"}
            )
        # più regole 'reject' nostre (non dovrebbe succedere): teniamo solo la prima
        for extra in rejects[1:]:
            await self._request("DELETE", f"{path}/{extra['.id']}")

    async def get_access_control_status(self) -> dict:
        menus = await self._access_menus()
        if not menus:
            return {"available": False, "stacks": [], "configured": False, "enforced": False, "allowed": []}

        reject_state: list[tuple[bool, bool]] = []  # (esiste, abilitata) per stack
        allowed: dict[str, set[str]] = {}
        for stack, path in menus:
            entries = await self._list_optional(path)
            rejects = [e for e in entries if e.get("comment") == self._ACCESS_REJECT_COMMENT]
            reject_state.append((bool(rejects), bool(rejects) and rejects[0].get("disabled") != "true"))
            for entry in entries:
                comment = entry.get("comment") or ""
                if (
                    comment.startswith(self._ACCESS_ALLOW_PREFIX)
                    and entry.get("action", "accept") == "accept"
                    and entry.get("disabled") != "true"
                ):
                    mac = (entry.get("mac-address") or comment[len(self._ACCESS_ALLOW_PREFIX):]).upper()
                    allowed.setdefault(mac, set()).add(stack)

        configured = all(exists for exists, _ in reject_state)
        enforced = configured and all(enabled for _, enabled in reject_state)
        return {
            "available": True,
            "stacks": [stack for stack, _ in menus],
            "configured": configured,
            "enforced": enforced,
            "allowed": sorted(allowed),
        }

    async def allow_client(self, mac_address: str) -> dict:
        """Autorizza un client: regola 'accept' per il suo MAC su ogni access-list CAPsMAN."""
        menus = await self._access_menus()
        if not menus:
            raise RouterOSError("CAPsMAN non rilevato su questo router: access-list non disponibile", status_code=409)
        mac = mac_address.upper()
        comment = self._allow_comment(mac)
        for _stack, path in menus:
            existing = [e for e in await self._list_optional(path) if e.get("comment") == comment]
            if not existing:
                await self._request(
                    "PUT", path, json={"action": "accept", "mac-address": mac, "comment": comment}
                )
            await self._ensure_reject_rule(path, None)  # la 'reject' deve restare in fondo
        return {"mac_address": mac, "allowed": True}

    async def disallow_client(self, mac_address: str) -> dict:
        menus = await self._access_menus()
        mac = mac_address.upper()
        comment = self._allow_comment(mac)
        for _stack, path in menus:
            for entry in await self._list_optional(path):
                if entry.get("comment") == comment:
                    await self._request("DELETE", f"{path}/{entry['.id']}")
        return {"mac_address": mac, "allowed": False}

    async def set_access_enforcement(self, enforced: bool) -> dict:
        """Attiva (solo i MAC in elenco) o sospende (chiunque può collegarsi) l'access-list."""
        menus = await self._access_menus()
        if not menus:
            raise RouterOSError("CAPsMAN non rilevato su questo router: access-list non disponibile", status_code=409)
        for _stack, path in menus:
            await self._ensure_reject_rule(path, disabled=not enforced)
        return {"enforced": enforced}

    async def _get_optional(self, path: str) -> Optional[dict]:
        """Come _list_optional, ma per un menu che espone un singolo oggetto (non una
        lista), es. /interface/wifi/capsman. None se il menu non esiste su questo router."""
        try:
            return await self._request("GET", path)
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return None
            raise

    async def list_wifi_radios(self) -> list[dict]:
        """Radio/SSID configurati, qualunque sia lo stack WiFi in uso su questo router:
        nuovo pacchetto 'wifi' (RouterOS >= 7.13), CAPsMAN, o wireless standalone legacy.
        Router senza hardware WiFi o senza nulla configurato -> lista vuota, nessun errore.

        I due stack (legacy 'wireless'/CAPsMAN v1 e nuovo 'wifi'/CAPsMAN v2) sono tenuti
        distinti tramite il campo 'source', così l'interfaccia può mostrare chiaramente
        quale motore WiFi gestisce ciascuna radio invece di darle tutte per uguali.
        """
        radios: list[dict] = []

        # Il pacchetto 'wifi' ha un CAPsMAN integrato (menu singolo, non una lista): se
        # 'enabled', le radio sottostanti possono essere provisionate centralmente da lì
        # (quello che in giro viene chiamato informalmente "CAPsMAN v2", per distinguerlo
        # dal vecchio /caps-man legacy). Su router senza il pacchetto 'wifi' il menu non
        # esiste -> _get_optional torna None, e semplicemente non marchiamo nulla.
        wifi_capsman = await self._get_optional("/interface/wifi/capsman")
        wifi_capsman_v2_enabled = bool(wifi_capsman) and wifi_capsman.get("enabled") == "true"

        for item in await self._list_optional("/interface/wifi"):
            radios.append(
                {
                    "name": item.get("name"),
                    "ssid": item.get("configuration.ssid") or item.get("ssid") or item.get("master-interface"),
                    "disabled": item.get("disabled") == "true",
                    "running": item.get("running") == "true",
                    "source": "wifi",
                    "managed_by_capsman": wifi_capsman_v2_enabled,
                }
            )

        for item in await self._list_optional("/caps-man/interface"):
            radios.append(
                {
                    "name": item.get("name"),
                    "ssid": item.get("current-ssid") or item.get("configuration.ssid") or item.get("configuration"),
                    "disabled": item.get("disabled") == "true",
                    "running": item.get("running") == "true",
                    "source": "capsman",
                }
            )

        # Wireless standalone (non gestito da CAPsMAN): evitiamo di duplicare le interfacce
        # già viste come "master" di una VAP CAPsMAN.
        known_names = {r["name"] for r in radios}
        for item in await self._list_optional("/interface/wireless"):
            name = item.get("name")
            if name in known_names:
                continue
            radios.append(
                {
                    "name": name,
                    "ssid": item.get("ssid"),
                    "disabled": item.get("disabled") == "true",
                    "running": item.get("running") == "true",
                    "source": "wireless",
                }
            )

        return radios

    async def list_wifi_networks(self, capsman_only: bool = True) -> list[dict]:
        """Reti WiFi configurate con, per ciascuna, i client attualmente collegati su
        quella radio (arricchiti con IP/hostname da DHCP dove disponibili).

        Con capsman_only (default) si considerano solo le radio e i client gestiti da
        CAPsMAN: quello legacy (/caps-man) e quello del pacchetto 'wifi' (v2, solo se
        abilitato). Radio locali/standalone (/interface/wireless, o /interface/wifi senza
        CAPsMAN) e client non WiFi restano fuori: TikPanel gestisce i client dei CAP.
        """
        radios = await self.list_wifi_radios()
        if capsman_only:
            radios = [
                r
                for r in radios
                if r["source"] == "capsman" or (r["source"] == "wifi" and r.get("managed_by_capsman"))
            ]
            wireless_regs: list[dict] = []
            capsman_regs = await self.list_capsman_registrations()
            wifi_regs = (
                await self.list_wifi_registrations() if any(r["source"] == "wifi" for r in radios) else []
            )
        else:
            wireless_regs = await self.list_wireless_registrations()
            capsman_regs = await self.list_capsman_registrations()
            wifi_regs = await self.list_wifi_registrations()

        leases = await self.list_dhcp_leases()
        lease_by_mac: dict[str, dict] = {}
        for lease in leases:
            mac = (lease.get("mac-address") or "").upper()
            if mac:
                lease_by_mac[mac] = lease

        blocked_macs = {
            self._strip_mac_mask(r.get("src-mac-address")) for r in await self._list_bridge_block_rules()
        }

        by_radio: dict[str, list[dict]] = {}
        for reg in wireless_regs + capsman_regs + wifi_regs:
            iface = reg.get("interface")
            if not iface:
                continue
            mac = (reg.get("mac-address") or "").upper()
            lease = lease_by_mac.get(mac, {})
            hostname, hostname_source = self._lease_hostname(lease)
            by_radio.setdefault(iface, []).append(
                {
                    "mac_address": mac,
                    "ip_address": lease.get("address"),
                    "hostname": hostname,
                    "hostname_source": hostname_source,
                    "signal_strength": reg.get("signal-strength"),
                    "uptime": reg.get("uptime"),
                    "blocked": mac in blocked_macs,
                    # interfaccia radio su cui il client è registrato: serve a stimare il traffico
                    "interface": iface,
                }
            )

        networks: list[dict] = []
        seen_names = set()
        for radio in radios:
            name = radio["name"]
            seen_names.add(name)
            networks.append({**radio, "clients": by_radio.get(name, [])})

        # Client registrati su un'interfaccia non presente tra i radio "configurati" letti
        # sopra (edge case, es. interfaccia radio non più elencata ma con client ancora
        # agganciati): la mostriamo comunque, non far sparire client reali.
        for iface_name, clients in by_radio.items():
            if iface_name not in seen_names:
                networks.append(
                    {
                        "name": iface_name,
                        "ssid": None,
                        "disabled": False,
                        "running": True,
                        "source": "sconosciuta",
                        "clients": clients,
                    }
                )

        return networks

    # ---------- traffico in tempo reale per client ----------

    @staticmethod
    def _torch_flow_ip(value: Optional[str]) -> str:
        """I campi src-address/dst-address di un flow torch sono "ip:porta" (o "ip/mask"
        per alcuni protocolli): normalizza alla sola parte IP per confrontarla col client."""
        return (value or "").split("/", 1)[0].split(":", 1)[0]

    async def monitor_client_traffic(self, ip_address: Optional[str], interface: Optional[str]) -> Optional[dict]:
        """Traffico istantaneo di un singolo client, via /tool/torch sull'interfaccia su cui
        è noto (radio WiFi, o interfaccia ARP per un client cablato).

        RouterOS non tiene contatori per-client: torch è uno strumento diagnostico pensato
        per uno streaming continuo (come /tool/ping o /tool/bandwidth-test), non per una
        singola lettura "once" come /interface/monitor-traffic — su REST API va quindi fatto
        girare per una durata esplicita (qui 1s) e leggere il campione risultante, non
        richiesto con once=yes (che per torch non ha alcun effetto documentato: prima lo
        usavamo e la risposta arrivava sempre vuota).

        Una sola chiamata (non filtrata per IP: il filtro src/dst-address di torch è per
        singolo indirizzo, non supporta "client X" direttamente) restituisce tutti i flussi
        sull'interfaccia; sommiamo lato nostro quelli dove il client compare come sorgente
        (upload, rx-bits-per-second) o destinazione (download, tx-bits-per-second).
        Richiede sia l'IP che l'interfaccia: se uno dei due non è noto (es. client visto solo
        via ARP su un'interfaccia bridge sconosciuta) non è possibile stimare il traffico in
        modo affidabile -> None, non un errore.
        """
        if not ip_address or not interface:
            return None
        flows = await self._torch_flows(interface)
        if flows is None:
            return None
        return self._client_rates(flows, ip_address)

    async def _torch_flows(self, interface: str) -> Optional[list[dict]]:
        """Una lettura di /tool/torch (1s) su un'interfaccia; None se non disponibile."""
        try:
            result = await self._request(
                "POST",
                "/tool/torch",
                json={
                    "interface": interface,
                    "duration": "1",
                    # Senza questi filtri torch NON scompone per indirizzo: le righe non
                    # hanno src/dst-address e non c'è modo di attribuirle a un client.
                    "src-address": "0.0.0.0/0",
                    "dst-address": "0.0.0.0/0",
                },
            )
        except RouterOSError as exc:
            if exc.upstream_status_code in self._OPTIONAL_MENU_STATUS_CODES:
                return None
            raise
        return result or []

    @staticmethod
    def _torch_rate(flow: dict, *names: str) -> int:
        """Velocità in bit/s di un flusso torch. I campi della REST API sono "tx" e "rx"
        (non "rx-bits-per-second", che è di /interface/monitor-traffic). Accetta sia numeri
        (bit/s) sia stringhe formattate come nella CLI ("147.8kbps", "1.2Mbps")."""
        multipliers = {"bps": 1, "kbps": 1_000, "mbps": 1_000_000, "gbps": 1_000_000_000}
        for name in names:
            value = flow.get(name)
            if value in (None, ""):
                continue
            text = str(value).strip().lower()
            factor = 1
            for suffix in ("gbps", "mbps", "kbps", "bps"):
                if text.endswith(suffix):
                    factor = multipliers[suffix]
                    text = text[: -len(suffix)].strip()
                    break
            try:
                return int(float(text) * factor)
            except ValueError:
                continue
        return 0

    def _client_rates(self, flows: list[dict], ip_address: str) -> dict:
        """Torch produce UNA riga per flusso (src = chi ha aperto la connessione) con TX e RX
        visti dall'interfaccia: TX = ciò che esce verso la LAN, quindi download del client;
        RX = ciò che entra dalla LAN, quindi upload. Vale sia se il client è src sia se è
        dst della riga, quindi si sommano tutte le righe che lo coinvolgono."""
        upload_bps = 0
        download_bps = 0
        for flow in flows:
            if ip_address in (
                self._torch_flow_ip(flow.get("src-address")),
                self._torch_flow_ip(flow.get("dst-address")),
            ):
                download_bps += self._torch_rate(flow, "tx", "tx-rate", "tx-bits-per-second")
                upload_bps += self._torch_rate(flow, "rx", "rx-rate", "rx-bits-per-second")
        # Approssimazione ragionevole, non un contatore esatto per-client: RouterOS non ne
        # tiene uno nativo senza una coda (queue) dedicata.
        return {"rx_bps": download_bps, "tx_bps": upload_bps}

    async def monitor_clients_traffic(self, targets: list[tuple[str, str]]) -> dict[str, Optional[dict]]:
        """Traffico di più client con UNA sola chiamata torch per interfaccia (invece di una
        per client: torch dura ~1s sul router, con N client sarebbero N chiamate pesanti).

        `targets` = [(ip, interface)]. Restituisce {ip: {"rx_bps","tx_bps"} | None}; se
        una interfaccia fallisce (es. permessi) i suoi client risultano None senza
        impedire agli altri di avere il loro valore.
        """
        by_interface: dict[str, set[str]] = {}
        for ip, interface in targets:
            if ip and interface:
                by_interface.setdefault(interface, set()).add(ip)

        async def one(interface: str) -> tuple[str, Optional[list[dict]]]:
            try:
                return interface, await self._torch_flows(interface)
            except RouterOSError:
                return interface, None  # già loggato da _request

        results = await asyncio.gather(*(one(i) for i in by_interface))
        samples: dict[str, Optional[dict]] = {}
        for interface, flows in results:
            for ip in by_interface[interface]:
                samples[ip] = None if flows is None else self._client_rates(flows, ip)
        return samples
