"""Modelli Pydantic per le richieste/risposte dell'API."""
from typing import Optional

from pydantic import BaseModel, Field


class InterfaceOut(BaseModel):
    id: str = Field(alias=".id")
    name: str
    type: Optional[str] = None
    running: Optional[bool] = None
    disabled: Optional[bool] = None
    comment: Optional[str] = None
    mac_address: Optional[str] = Field(default=None, alias="mac-address")

    model_config = {"populate_by_name": True}

    @classmethod
    def from_raw(cls, raw: dict) -> "InterfaceOut":
        return cls(
            **{
                ".id": raw.get(".id"),
                "name": raw.get("name"),
                "type": raw.get("type"),
                "running": raw.get("running") == "true",
                "disabled": raw.get("disabled") == "true",
                "comment": raw.get("comment"),
                "mac-address": raw.get("mac-address"),
            }
        )


class InterfaceStateIn(BaseModel):
    disabled: bool = Field(..., description="true per disabilitare l'interfaccia, false per abilitarla")


class VlanOut(BaseModel):
    id: str = Field(alias=".id")
    name: str
    vlan_id: Optional[int] = Field(default=None, alias="vlan-id")
    interface: Optional[str] = None
    disabled: Optional[bool] = None
    running: Optional[bool] = None
    comment: Optional[str] = None

    model_config = {"populate_by_name": True}

    @classmethod
    def from_raw(cls, raw: dict) -> "VlanOut":
        vlan_id = raw.get("vlan-id")
        return cls(
            **{
                ".id": raw.get(".id"),
                "name": raw.get("name"),
                "vlan-id": int(vlan_id) if vlan_id is not None else None,
                "interface": raw.get("interface"),
                "disabled": raw.get("disabled") == "true",
                "running": raw.get("running") == "true",
                "comment": raw.get("comment"),
            }
        )


class VlanCreateIn(BaseModel):
    name: str = Field(..., description="Nome della nuova interfaccia VLAN, es. vlan100-ospiti")
    vlan_id: int = Field(..., ge=1, le=4094, description="VLAN ID 802.1Q (1-4094)")
    interface: str = Field(..., description="Interfaccia fisica o bridge su cui creare la VLAN, es. ether2 o bridge1")
    comment: Optional[str] = None
    disabled: bool = False


class VlanUpdateIn(BaseModel):
    name: Optional[str] = None
    vlan_id: Optional[int] = Field(default=None, ge=1, le=4094)
    interface: Optional[str] = None
    comment: Optional[str] = None
    disabled: Optional[bool] = None


class ClientOut(BaseModel):
    mac_address: str
    ip_address: Optional[str] = None
    hostname: Optional[str] = None
    connection: Optional[str] = None
    blocked: Optional[bool] = None

    model_config = {"extra": "allow"}


class ClientBlockIn(BaseModel):
    mac_address: str = Field(..., description="Indirizzo MAC del client, es. AA:BB:CC:DD:EE:FF")
    ip_address: Optional[str] = Field(default=None, description="IP del client, se noto (consigliato)")


class ClientDisconnectIn(BaseModel):
    mac_address: str = Field(..., description="Indirizzo MAC del client da disconnettere forzatamente")


class WifiClientOut(BaseModel):
    mac_address: str
    ip_address: Optional[str] = None
    hostname: Optional[str] = None
    signal_strength: Optional[str] = None
    uptime: Optional[str] = None

    model_config = {"extra": "allow"}


class WifiNetworkOut(BaseModel):
    name: str
    ssid: Optional[str] = None
    disabled: Optional[bool] = None
    running: Optional[bool] = None
    source: Optional[str] = Field(
        default=None, description="Stack WiFi che espone questa radio: wifi, capsman, wireless o sconosciuta"
    )
    managed_by_capsman: Optional[bool] = Field(
        default=None,
        description=(
            "Solo per source='wifi': True se la radio è provisionata centralmente dal CAPsMAN "
            "integrato nel pacchetto 'wifi' (RouterOS >= 7.13, a volte chiamato 'CAPsMAN v2'), "
            "False se è gestita localmente. Per source='capsman' la gestione centrale è implicita "
            "(è il vecchio CAPsMAN, v1); per source='wireless' è sempre locale/standalone."
        ),
    )
    clients: list[WifiClientOut] = Field(default_factory=list)


class WifiModuleStatusOut(BaseModel):
    wireless: bool = Field(description="Driver legacy /interface/wireless presente su questo router")
    capsman: bool = Field(description="Vecchio CAPsMAN (/caps-man) presente su questo router")
    wifi: bool = Field(description="Nuovo driver /interface/wifi (RouterOS >= 7.13) presente su questo router")

    model_config = {"populate_by_name": True}


class TrafficOut(BaseModel):
    rx_bps: int = Field(0, description="Bit al secondo in ricezione/download")
    tx_bps: int = Field(0, description="Bit al secondo in trasmissione/upload")
    available: bool = Field(True, description="False se il traffico non è stimabile per questo elemento")


class ClientTrafficIn(BaseModel):
    ip_address: Optional[str] = Field(default=None, description="IP del client (richiesto per stimare il traffico)")
    interface: Optional[str] = Field(
        default=None, description="Interfaccia su cui è noto il client (radio WiFi o interfaccia ARP)"
    )


class LoginIn(BaseModel):
    username: str = Field(..., description="Nome utente RouterOS")
    password: str = Field(..., description="Password RouterOS (mai persistita, solo verificata)")


class LoginOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    username: str
