"""Sessioni di login per la dashboard web.

Le credenziali (username/password) sono quelle di un utente TikPanel (vedi
users.py), non un utente RouterOS. Dopo la verifica si rilascia un token di
sessione firmato (JWT) che il browser conserva al posto delle credenziali;
il ruolo dell'utente viene incluso nel token stesso, così le rotte che
richiedono un ruolo specifico non devono rileggere lo user store a ogni
richiesta (il ruolo può risultare non aggiornatissimo se cambiato mentre la
sessione è attiva: si applica al prossimo login, non serve invalidare tutto).
"""
from __future__ import annotations

import time
from typing import Any

import jwt

from .config import Settings
from .users import Role

ALGORITHM = "HS256"


def create_session_token(settings: Settings, username: str, role: Role) -> tuple[str, int]:
    """Crea un JWT di sessione per l'utente. Ritorna (token, secondi-di-validità)."""
    expires_in = settings.session_expire_minutes * 60
    now = int(time.time())
    payload = {
        "sub": username,
        "role": role,
        "iat": now,
        "exp": now + expires_in,
    }
    token = jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)
    return token, expires_in


BOOTSTRAP_TOKEN_EXPIRE_SECONDS = 15 * 60


def create_bootstrap_token(settings: Settings, username: str) -> tuple[str, int]:
    """Crea un JWT "di bootstrap": non porta nessun ruolo (require_admin/require_api_key lo
    rifiutano sempre), è valido solo per completare il setup del primo amministratore su
    /auth/setup-admin e scade rapidamente. Non deve MAI dare accesso al resto dell'API."""
    expires_in = BOOTSTRAP_TOKEN_EXPIRE_SECONDS
    now = int(time.time())
    payload = {
        "sub": username,
        "bootstrap": True,
        "iat": now,
        "exp": now + expires_in,
    }
    token = jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)
    return token, expires_in


def decode_session_token(settings: Settings, token: str) -> dict[str, Any]:
    """Decodifica e valida un JWT di sessione. Solleva jwt.PyJWTError se non valido/scaduto."""
    return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
