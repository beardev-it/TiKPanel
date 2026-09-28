"""Configurazione del servizio, letta da variabili d'ambiente (.env)."""
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Connessione al router MikroTik (RouterOS REST API, richiede RouterOS >= 7.1)
    mikrotik_host: str = Field(..., description="IP o hostname del router MikroTik")
    mikrotik_port: int = Field(443, description="Porta della REST API di RouterOS")
    mikrotik_user: str = Field(..., description="Utente RouterOS con permessi API/write/policy")
    mikrotik_password: str = Field(..., description="Password dell'utente RouterOS")
    mikrotik_use_ssl: bool = Field(True, description="Usa https invece di http verso RouterOS")
    mikrotik_verify_ssl: bool = Field(
        False, description="Verifica il certificato TLS del router (spesso self-signed)"
    )
    mikrotik_timeout: float = Field(10.0, description="Timeout (secondi) per le chiamate a RouterOS")

    # Sicurezza di questo servizio
    api_key: str = Field(..., description="Chiave richiesta nell'header X-API-Key per usare queste API")

    # Comportamento del blocco client
    block_address_list: str = Field(
        "supervisortik-blocked",
        description="Nome della address-list RouterOS usata per bloccare il traffico dei client",
    )
    auto_create_firewall_rule: bool = Field(
        True,
        description="Crea automaticamente le regole firewall che scartano il traffico della address-list di blocco",
    )

    log_level: str = Field("INFO")


@lru_cache
def get_settings() -> Settings:
    return Settings()
