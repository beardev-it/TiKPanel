"""Autenticazione delle richieste verso questo servizio (non verso RouterOS).

Due modalità, entrambe accettate sulle stesse rotte:
- X-API-Key: pensata per uso programmatico (script, curl, integrazioni) — considerata
  sempre pienamente autorizzata, incluse le rotte che richiedono ruolo amministratore
- Authorization: Bearer <token>: sessione della dashboard web, rilasciata da /auth/login
  dopo verifica delle credenziali di un utente TikPanel (vedi auth.py, users.py)
"""
import hmac
from typing import Optional

import jwt
from fastapi import Header, HTTPException, status

from .auth import decode_session_token
from .config import get_settings


async def require_api_key(
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> None:
    settings = get_settings()

    if x_api_key is not None and hmac.compare_digest(x_api_key, settings.api_key):
        return

    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        try:
            decode_session_token(settings, token)
            return
        except jwt.PyJWTError:
            pass

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Autenticazione richiesta: X-API-Key valida oppure sessione (Bearer token) valida",
    )


async def require_bootstrap(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:
    """Per /auth/setup-admin: accetta SOLO un token di bootstrap (create_bootstrap_token),
    mai una X-API-Key né una sessione normale. Ritorna lo username del bootstrap (payload 'sub')."""
    settings = get_settings()

    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        try:
            payload = decode_session_token(settings, token)
        except jwt.PyJWTError:
            payload = None
        if payload is not None and payload.get("bootstrap") is True:
            return str(payload.get("sub"))

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Richiesto un login con le credenziali iniziali (env) non ancora completato con il setup",
    )


async def require_admin(
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> None:
    """Come require_api_key, ma per le rotte di gestione utenti: una sessione (Bearer)
    deve avere ruolo 'amministratore'. La X-API-Key resta sempre autorizzata (è già
    piena fiducia per tutte le altre rotte programmatiche)."""
    settings = get_settings()

    if x_api_key is not None and hmac.compare_digest(x_api_key, settings.api_key):
        return

    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        try:
            payload = decode_session_token(settings, token)
        except jwt.PyJWTError:
            payload = None
        if payload is not None:
            if payload.get("role") == "amministratore":
                return
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Richiesto ruolo amministratore",
            )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Autenticazione richiesta: X-API-Key valida oppure sessione (Bearer token) valida",
    )
