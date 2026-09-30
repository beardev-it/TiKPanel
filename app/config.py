"""Configurazione del servizio, letta da variabili d'ambiente (.env)."""
from functools import lru_cache
from typing import Optional

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
    api_key: str = Field(..., description="Chiave richiesta nell'header X-API-Key per l'uso programmatico delle API")

    # Login utenti (dashboard web): utenti propri di TikPanel (non gli utenti RouterOS),
    # con password con hash bcrypt salvate in users_file. Sessione firmata dopo verifica.
    secret_key: str = Field(
        ..., description="Chiave usata per firmare i token di sessione (JWT). Generane una lunga e casuale."
    )
    session_expire_minutes: int = Field(480, description="Durata della sessione dopo il login (default 8 ore)")
    users_file: str = Field(
        "/data/users.json",
        description="Percorso del file con utenti/ruoli della dashboard TikPanel (deve stare su storage persistente)",
    )
    initial_admin_username: str = Field(
        "admin", description="Username del primo amministratore, creato automaticamente se users_file è vuoto/assente"
    )
    initial_admin_password: Optional[str] = Field(
        None,
        description=(
            "Password del primo amministratore, creato solo al primo avvio se non esiste ancora nessun "
            "utente. Obbligatoria al primo avvio (altrimenti nessuno può fare login); non serve più "
            "dopo che il primo admin è stato creato."
        ),
    )

    # URL base che il frontend deve usare per parlare con questo servizio.
    # Vuoto = stessa origine (caso normale: dashboard servita dallo stesso container).
    # Valorizzalo solo se la dashboard viene servita da un host diverso dal backend.
    public_base_url: str = Field("", description="URL base dell'API per il frontend, vuoto = stessa origine")

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
