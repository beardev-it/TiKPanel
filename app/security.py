"""Autenticazione delle richieste verso questo servizio (non verso RouterOS)."""
import hmac

from fastapi import Header, HTTPException, status

from .config import get_settings


async def require_api_key(x_api_key: str = Header(..., alias="X-API-Key")) -> None:
    settings = get_settings()
    if not hmac.compare_digest(x_api_key, settings.api_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="X-API-Key non valida")
