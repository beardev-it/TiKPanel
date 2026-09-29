"""Autenticazione delle richieste verso questo servizio (non verso RouterOS).

Due modalità, entrambe accettate sulle stesse rotte:
- X-API-Key: pensata per uso programmatico (script, curl, integrazioni)
- Authorization: Bearer <token>: sessione della dashboard web, rilasciata da /auth/login
  dopo verifica delle credenziali RouterOS dell'utente (vedi auth.py)
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
