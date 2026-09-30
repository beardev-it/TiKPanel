"""Utenti della dashboard TikPanel (distinti dagli utenti RouterOS).

Fino alla versione precedente il login verificava le credenziali in tempo reale
contro RouterOS stesso. Ora TikPanel ha un proprio elenco utenti, con password
con hash bcrypt, salvato in un file JSON su storage persistente (users_file).
Ogni utente ha un ruolo tra "utente", "operatore" e "amministratore" — cosa
può fare esattamente ciascun ruolo sulle singole funzionalità verrà definito
in seguito; per ora solo la gestione utenti stessa richiede "amministratore".

Le chiamate verso RouterOS (interfacce/VLAN/client) continuano a usare le
credenziali di sistema in MIKROTIK_USER/MIKROTIK_PASSWORD, invariate: quelle
sono l'utenza con cui TikPanel stesso parla con il router, non c'entrano con
chi fa login sulla dashboard.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Literal, Optional

import bcrypt
from pydantic import BaseModel, Field

logger = logging.getLogger("tikpanel.users")

Role = Literal["utente", "operatore", "amministratore"]
ROLES: tuple[Role, ...] = ("utente", "operatore", "amministratore")


class UserRecord(BaseModel):
    username: str
    password_hash: str
    role: Role
    disabled: bool = False
    created_at: int = Field(default_factory=lambda: int(time.time()))


class UserError(RuntimeError):
    """Errore applicativo (username duplicato, utente non trovato, ultimo admin...)."""


class UserStore:
    """Elenco utenti persistito su file JSON, con accesso serializzato da un lock
    (asyncio.Lock: evita che due richieste concorrenti si pestino i piedi scrivendo
    il file contemporaneamente — il volume di scritture qui è bassissimo, quindi
    un lock semplice va benissimo, non serve un vero database)."""

    def __init__(self, path: str):
        self._path = Path(path)
        self._lock = asyncio.Lock()

    def _read(self) -> dict[str, UserRecord]:
        if not self._path.exists():
            return {}
        raw = json.loads(self._path.read_text(encoding="utf-8") or "{}")
        return {name: UserRecord(**data) for name, data in raw.items()}

    def _write(self, users: dict[str, UserRecord]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {name: user.model_dump() for name, user in users.items()}
        tmp_path = self._path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(tmp_path, self._path)  # scrittura atomica: mai un file a metà in caso di crash

    @staticmethod
    def _hash_password(password: str) -> str:
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")

    @staticmethod
    def _verify_password(password: str, password_hash: str) -> bool:
        try:
            return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("ascii"))
        except ValueError:
            return False

    async def ensure_bootstrap_admin(self, username: str, password: Optional[str]) -> None:
        """Se non esiste ancora nessun utente, crea il primo amministratore da env var.
        Senza questo, dopo il passaggio a utenti locali nessuno potrebbe più fare login."""
        async with self._lock:
            users = self._read()
            if users:
                return
            if not password:
                # Nessun utente e nessuna password di bootstrap configurata: lo segnaliamo
                # forte in log, ma non blocchiamo l'avvio del servizio (health/API restano
                # utilizzabili con la X-API-Key anche senza nessun utente dashboard).
                logger.warning(
                    "Nessun utente TikPanel esiste e INITIAL_ADMIN_PASSWORD non è impostata: "
                    "nessuno potrà fare login sulla dashboard finché non imposti questa variabile "
                    "d'ambiente e riavvii il container."
                )
                return
            users[username] = UserRecord(
                username=username, password_hash=self._hash_password(password), role="amministratore"
            )
            self._write(users)

    async def list_users(self) -> list[UserRecord]:
        async with self._lock:
            return sorted(self._read().values(), key=lambda u: u.username)

    async def get_user(self, username: str) -> Optional[UserRecord]:
        async with self._lock:
            return self._read().get(username)

    async def verify_credentials(self, username: str, password: str) -> Optional[UserRecord]:
        async with self._lock:
            user = self._read().get(username)
        if not user or user.disabled:
            return None
        if not self._verify_password(password, user.password_hash):
            return None
        return user

    async def create_user(self, username: str, password: str, role: Role) -> UserRecord:
        async with self._lock:
            users = self._read()
            if username in users:
                raise UserError(f"L'utente '{username}' esiste già")
            record = UserRecord(username=username, password_hash=self._hash_password(password), role=role)
            users[username] = record
            self._write(users)
            return record

    async def update_user(
        self,
        username: str,
        *,
        password: Optional[str] = None,
        role: Optional[Role] = None,
        disabled: Optional[bool] = None,
    ) -> UserRecord:
        async with self._lock:
            users = self._read()
            user = users.get(username)
            if not user:
                raise UserError(f"Utente '{username}' non trovato")

            if role is not None and role != "amministratore" and user.role == "amministratore":
                self._assert_not_last_admin(users, exclude=username)
            if disabled is True and user.role == "amministratore":
                self._assert_not_last_admin(users, exclude=username)

            if password is not None:
                user.password_hash = self._hash_password(password)
            if role is not None:
                user.role = role
            if disabled is not None:
                user.disabled = disabled

            users[username] = user
            self._write(users)
            return user

    async def delete_user(self, username: str) -> None:
        async with self._lock:
            users = self._read()
            user = users.get(username)
            if not user:
                raise UserError(f"Utente '{username}' non trovato")
            if user.role == "amministratore":
                self._assert_not_last_admin(users, exclude=username)
            del users[username]
            self._write(users)

    @staticmethod
    def _assert_not_last_admin(users: dict[str, UserRecord], *, exclude: str) -> None:
        remaining_admins = [
            u for name, u in users.items() if name != exclude and u.role == "amministratore" and not u.disabled
        ]
        if not remaining_admins:
            raise UserError("Impossibile: deve rimanere almeno un amministratore attivo")
