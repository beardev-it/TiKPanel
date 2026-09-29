"""Sessioni di login per la dashboard web.

Le credenziali (username/password RouterOS dell'utente) vengono verificate
UNA VOLTA, in tempo reale, contro la REST API di RouterOS stesso: se il login
ha successo l'utente appartiene di fatto al gruppo RouterOS con permessi
api/rest-api (altrimenti RouterOS stesso avrebbe rifiutato l'autenticazione).
Non viene mai salvata alcuna password: dopo il login si rilascia un token di
sessione firmato (JWT) che il browser conserva al posto delle credenziali.
"""
from __future__ import annotations

import time
from typing import Any

import jwt

from .config import Settings

ALGORITHM = "HS256"


def create_session_token(settings: Settings, username: str) -> tuple[str, int]:
    """Crea un JWT di sessione per l'utente. Ritorna (token, secondi-di-validità)."""
    expires_in = settings.session_expire_minutes * 60
    now = int(time.time())
    payload = {
        "sub": username,
        "iat": now,
        "exp": now + expires_in,
    }
    token = jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)
    return token, expires_in


def decode_session_token(settings: Settings, token: str) -> dict[str, Any]:
    """Decodifica e valida un JWT di sessione. Solleva jwt.PyJWTError se non valido/scaduto."""
    return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
