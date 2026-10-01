"""Dati persistenti di TikPanel sui client: gruppi, assegnazioni, etichette, modalità aggiunta.

Salvati in un file JSON su storage persistente (clients_file, di norma accanto a users.json
nel mount /data), così sopravvivono a scollegamenti/ricollegamenti dei client e a un
/container/repull. Contenuto:

- groups: elenco dei nomi di gruppo definiti dall'utente (l'ordine è quello di creazione)
- assignments: MAC -> nome gruppo (un client appartiene al massimo a un gruppo)
- labels: MAC -> nome mostrato per i client autorizzati (utile anche quando sono offline e
  non c'è più un hostname DHCP da mostrare)
- learning_until: timestamp (epoch) di fine della modalità "aggiunta client", oppure None.
  Sta qui, e non in memoria, perché la riattivazione di sicurezza dell'access-list deve
  avvenire anche se il container viene riavviato mentre la modalità è aperta.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger("tikpanel.clientstore")

MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
GROUP_NAME_MAX = 40
LABEL_MAX = 80


class ClientDataError(RuntimeError):
    """Errore applicativo (gruppo duplicato/inesistente, MAC non valido...)."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def normalize_mac(mac: str) -> str:
    value = (mac or "").strip().upper().replace("-", ":")
    if not MAC_RE.match(value):
        raise ClientDataError(f"MAC address non valido: {mac!r}")
    return value


class ClientStore:
    def __init__(self, path: str):
        self._path = Path(path)
        self._lock = asyncio.Lock()

    @staticmethod
    def _empty() -> dict:
        return {"groups": [], "assignments": {}, "labels": {}, "learning_until": None}

    def _read(self) -> dict:
        data = self._empty()
        if self._path.exists():
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8") or "{}")
            except (OSError, ValueError):
                # File corrotto: meglio ripartire vuoti (e dirlo) che bloccare l'intera dashboard.
                logger.error("Impossibile leggere %s: parto da dati vuoti", self._path)
                raw = {}
            data["groups"] = [g for g in raw.get("groups", []) if isinstance(g, str)]
            data["assignments"] = {
                k: v for k, v in (raw.get("assignments") or {}).items() if isinstance(v, str)
            }
            data["labels"] = {k: v for k, v in (raw.get("labels") or {}).items() if isinstance(v, str)}
            lu = raw.get("learning_until")
            data["learning_until"] = float(lu) if isinstance(lu, (int, float)) else None
        return data

    def _write(self, data: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self._path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp_path, self._path)  # scrittura atomica: mai un file a metà in caso di crash

    @staticmethod
    def _clean_group_name(name: str) -> str:
        value = " ".join((name or "").split())
        if not value:
            raise ClientDataError("Il nome del gruppo non può essere vuoto")
        if len(value) > GROUP_NAME_MAX:
            raise ClientDataError(f"Il nome del gruppo è troppo lungo (max {GROUP_NAME_MAX} caratteri)")
        return value

    @staticmethod
    def _find_group(groups: list[str], name: str) -> Optional[str]:
        wanted = name.casefold()
        return next((g for g in groups if g.casefold() == wanted), None)

    async def snapshot(self) -> dict:
        async with self._lock:
            return self._read()

    # ---------- gruppi ----------

    async def create_group(self, name: str) -> str:
        name = self._clean_group_name(name)
        async with self._lock:
            data = self._read()
            if self._find_group(data["groups"], name):
                raise ClientDataError(f"Esiste già un gruppo chiamato '{name}'", status_code=409)
            data["groups"].append(name)
            self._write(data)
        return name

    async def rename_group(self, old: str, new: str) -> str:
        new = self._clean_group_name(new)
        async with self._lock:
            data = self._read()
            current = self._find_group(data["groups"], old)
            if current is None:
                raise ClientDataError(f"Gruppo '{old}' non trovato", status_code=404)
            clash = self._find_group(data["groups"], new)
            if clash and clash != current:
                raise ClientDataError(f"Esiste già un gruppo chiamato '{new}'", status_code=409)
            data["groups"] = [new if g == current else g for g in data["groups"]]
            data["assignments"] = {m: (new if g == current else g) for m, g in data["assignments"].items()}
            self._write(data)
        return new

    async def delete_group(self, name: str) -> int:
        """Elimina il gruppo; i suoi client restano semplicemente senza gruppo. Ritorna quanti."""
        async with self._lock:
            data = self._read()
            current = self._find_group(data["groups"], name)
            if current is None:
                raise ClientDataError(f"Gruppo '{name}' non trovato", status_code=404)
            data["groups"] = [g for g in data["groups"] if g != current]
            before = len(data["assignments"])
            data["assignments"] = {m: g for m, g in data["assignments"].items() if g != current}
            self._write(data)
            return before - len(data["assignments"])

    async def assign(self, macs: list[str], group: Optional[str]) -> int:
        """Assegna (o, con group=None, toglie dal gruppo) uno o più client. Ritorna quanti."""
        normalized = [normalize_mac(m) for m in macs]
        async with self._lock:
            data = self._read()
            target = None
            if group:
                target = self._find_group(data["groups"], group)
                if target is None:
                    raise ClientDataError(f"Gruppo '{group}' non trovato", status_code=404)
            for mac in normalized:
                if target:
                    data["assignments"][mac] = target
                else:
                    data["assignments"].pop(mac, None)
            self._write(data)
        return len(normalized)

    # ---------- etichette dei client autorizzati ----------

    async def set_label(self, mac: str, label: Optional[str]) -> None:
        mac = normalize_mac(mac)
        text = " ".join((label or "").split())[:LABEL_MAX]
        async with self._lock:
            data = self._read()
            if text:
                data["labels"][mac] = text
            else:
                data["labels"].pop(mac, None)
            self._write(data)

    async def forget_label(self, mac: str) -> None:
        await self.set_label(mac, None)

    # ---------- modalità aggiunta client ----------

    async def set_learning_until(self, timestamp: Optional[float]) -> None:
        async with self._lock:
            data = self._read()
            data["learning_until"] = timestamp
            self._write(data)
