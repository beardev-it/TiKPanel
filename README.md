# TikPanel

**v0.9beta**

TikPanel è un'**interfaccia web** (dashboard) per gestire un router **MikroTik (RouterOS)** —
interfacce, VLAN e client collegati — senza dover passare dalla riga di comando di RouterOS per
le operazioni di tutti i giorni. Gira come container, con una dashboard su `/ui` e, sotto il
cofano, una API REST che la dashboard stessa usa (utilizzabile anche direttamente per script e
integrazioni).

Cosa si può fare dalla dashboard (o via API):

- abilitare/disabilitare interfacce fisiche e virtuali
- creare, modificare, eliminare **VLAN** (`interface/vlan`)
- vedere i **client collegati** (DHCP, ARP, WiFi/CAPsMAN, Hotspot)
- **bloccare** il traffico di un client (address-list + regole firewall + lease DHCP)
- **forzare la disconnessione** di un client già collegato (kick da WiFi/CAPsMAN/Hotspot, pulizia ARP)
- vedere le **reti WiFi configurate** (radio/SSID, qualunque stack: pacchetto `wifi`, CAPsMAN o
  wireless legacy) con i client collegati raggruppati per radio

L'accesso alla dashboard avviene con un vero login: si inseriscono le proprie credenziali
RouterOS, verificate in tempo reale contro il router stesso — nessuna password viene mai salvata,
solo una sessione firmata con scadenza. La dashboard ha un tema chiaro e uno scuro (icona in alto
a destra, segue anche le preferenze del sistema di default).

Il container può girare in due modi:

1. **Dentro il router MikroTik stesso**, usando la funzione "container" di RouterOS 7.4+ (richiede un
   modello con storage esterno, es. microSD/USB — non tutti i router la supportano).
2. **Su un PC/server esterno** che raggiunge il router in rete: è il modo più semplice e compatibile,
   consigliato salvo bisogno specifico di eseguire tutto a bordo router.

In entrambi i casi il servizio parla con RouterOS tramite la sua **REST API nativa** (`/rest`,
disponibile da RouterOS 7.1), quindi non serve installare nulla sul router oltre ad abilitarla.

## Requisiti sul router

1. RouterOS **≥ 7.1** con la REST API attiva (di solito già attiva se è abilitato `www-ssl` o `www`):
   ```
   /ip service enable www-ssl
   /ip service set www-ssl certificate=<tuo-certificato>
   ```
   Con RouterOS 7 la REST API risponde sulle stesse porte di `www`/`www-ssl` (default 80/443),
   sotto il percorso `/rest`.
2. Un **utente API dedicato**, non l'admin principale, con permessi minimi necessari:
   ```
   /user group add name=api-group policy=read,write,api,rest-api,!local,!telnet,!ssh,!ftp,!reboot,!policy,!password,!sensitive,!romon
   /user add name=api-user group=api-group password=<password-forte>
   ```
   (adatta la policy alle tue esigenze; servono almeno `read`, `write` e l'accesso REST/API).

   **In alternativa**, usa lo script incluso `router-setup.rsc`: genera un certificato TLS
   self-signed, abilita `www-ssl` (disabilitando `www` in chiaro), crea l'utente API dedicato con
   permessi minimi e, opzionalmente, limita via firewall l'accesso alla REST API al solo IP del
   PC/server che eseguirà mikrotik-gate. Modifica le variabili in cima al file (password, IP
   consentito), copialo sul router e lancialo con:
   ```
   /import file-name=router-setup.rsc
   ```
3. Se vuoi far girare il container **sul router**: abilita il pacchetto `container` e un disco esterno
   (vedi la guida ufficiale MikroTik "Container" nella documentazione RouterOS). Se invece esegui il
   container su un **PC esterno**, ti basta che quel PC raggiunga l'IP di gestione del router.

## Configurazione

Copia `.env.example` in `.env` e compila i valori:

```
cp .env.example .env
```

Variabili principali:

| Variabile | Descrizione |
|---|---|
| `MIKROTIK_HOST` | IP/hostname del router |
| `MIKROTIK_PORT` | Porta REST API (default 443, https) |
| `MIKROTIK_USER` / `MIKROTIK_PASSWORD` | Credenziali dell'utente API dedicato |
| `MIKROTIK_USE_SSL` | `true`/`false`, usa https verso il router |
| `MIKROTIK_VERIFY_SSL` | `true` per validare il certificato TLS del router (spesso self-signed → `false`) |
| `API_KEY` | Chiave segreta richiesta nell'header `X-API-Key` per uso programmatico (script, curl, integrazioni) |
| `SECRET_KEY` | **Obbligatoria.** Firma i token di sessione (JWT) rilasciati dal login della dashboard `/ui`. Deve essere diversa da `API_KEY`, lunga e casuale (es. `openssl rand -hex 32`). Senza questa variabile il container non si avvia. |
| `SESSION_EXPIRE_MINUTES` | Durata della sessione dopo il login nella dashboard (default `480`, cioè 8 ore) |
| `PUBLIC_BASE_URL` | URL base che il frontend usa per parlare col servizio. Lascia vuoto se la dashboard è servita dallo stesso container (caso normale) |
| `BLOCK_ADDRESS_LIST` | Nome della address-list RouterOS usata per bloccare i client |
| `AUTO_CREATE_FIREWALL_RULE` | Se `true`, crea automaticamente le regole firewall di drop per quella lista |

## Dashboard web (`/ui`)

La dashboard di TikPanel è su `http://<host>:8000/ui`, con tre sezioni: Interfacce, VLAN, Client.
Il login (non l'`API_KEY`, riservata all'uso programmatico) usa le credenziali RouterOS
dell'utente, valide per la durata di `SESSION_EXPIRE_MINUTES`: può accedere chiunque abbia un
utente RouterOS con permessi `api`+`rest-api` (lo stesso gruppo usato per `MIKROTIK_USER`, o un
gruppo dedicato per gli operatori della dashboard).

## Avvio con Docker

```bash
docker compose up -d --build
```

Il servizio risponde su `http://<host-del-container>:8000`, con documentazione interattiva su
`/docs` (Swagger) e `/redoc`.

### Build manuale senza compose

```bash
docker build -t mikrotik-gate .
docker run -d --name mikrotik-gate --env-file .env -p 8000:8000 --restart unless-stopped mikrotik-gate
```

### Esecuzione a bordo router MikroTik

Su RouterOS con il pacchetto `container` abilitato:

```
/container/mounts/add name=gate-env src-path=/gate/.env dst-path=/app/.env
/container/add remote-image=<tuo-registry>/mikrotik-gate:latest interface=veth1 root-dir=usb1/gate mounts=gate-env
/container/start [find comment="mikrotik-gate"]
```

Nota: sul router **non puoi usare `MIKROTIK_HOST=127.0.0.1`** puntando al router stesso mentre giri
dentro il router — di norma funziona comunque perché il container parla con RouterOS tramite l'IP di
loopback del router (`127.0.0.1`) o l'IP dell'interfaccia `veth` assegnata; verifica la connettività con
`/container/shell` una volta avviato.

## Autenticazione delle chiamate

Tutte le rotte (tranne `/health` e `/`) richiedono l'header:

```
X-API-Key: <il valore di API_KEY nel tuo .env>
```

## Esempi d'uso

### Interfacce

```bash
# elenco interfacce fisiche e virtuali
curl -s -H "X-API-Key: $KEY" http://localhost:8000/interfaces

# disabilita una interfaccia (es. ether3)
curl -s -X PUT -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"disabled": true}' \
     http://localhost:8000/interfaces/ether3/state

# riabilitala
curl -s -X PUT -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"disabled": false}' \
     http://localhost:8000/interfaces/ether3/state
```

### VLAN

```bash
# crea una VLAN 100 "ospiti" sopra il bridge1
curl -s -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"name":"vlan100-ospiti","vlan_id":100,"interface":"bridge1"}' \
     http://localhost:8000/vlans

# elenco VLAN
curl -s -H "X-API-Key: $KEY" http://localhost:8000/vlans

# modifica il VLAN ID
curl -s -X PATCH -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"vlan_id":150}' \
     http://localhost:8000/vlans/vlan100-ospiti

# elimina la VLAN
curl -s -X DELETE -H "X-API-Key: $KEY" http://localhost:8000/vlans/vlan100-ospiti
```

### Client collegati

```bash
# elenco client noti (DHCP + ARP + WiFi/CAPsMAN + Hotspot)
curl -s -H "X-API-Key: $KEY" http://localhost:8000/clients

# blocca il traffico di un client (address-list + firewall drop + lease DHCP)
curl -s -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"mac_address":"AA:BB:CC:DD:EE:FF","ip_address":"192.168.88.50"}' \
     http://localhost:8000/clients/block

# sblocca
curl -s -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"mac_address":"AA:BB:CC:DD:EE:FF"}' \
     http://localhost:8000/clients/unblock

# forza subito la disconnessione (WiFi/CAPsMAN/Hotspot/ARP)
curl -s -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"mac_address":"AA:BB:CC:DD:EE:FF"}' \
     http://localhost:8000/clients/disconnect

# scorciatoia: blocca e disconnette in un solo passo
curl -s -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"mac_address":"AA:BB:CC:DD:EE:FF","ip_address":"192.168.88.50"}' \
     http://localhost:8000/clients/kick
```

### Reti WiFi

```bash
# reti/radio configurate (nuovo pacchetto wifi, CAPsMAN o wireless legacy — qualunque sia
# disponibile sul router) con i client collegati raggruppati per radio
curl -s -H "X-API-Key: $KEY" http://localhost:8000/wifi-networks
```

Se il router non ha hardware WiFi o non ha nessuna radio configurata, l'endpoint risponde con
una lista vuota `[]` invece di un errore: nessun client collegato via WiFi è una condizione
normale, non un guasto.

## Note importanti

- **Client via cavo (Ethernet)**: RouterOS non offre un modo diretto per "staccare" una singola porta di
  uno switch integrato per un solo host. `/clients/block` gli taglia comunque il traffico (address-list +
  firewall drop) e disabilita il lease DHCP; `/clients/disconnect` ripulisce eventuali voci ARP note. Per
  un blocco fisico reale su una porta dedicata, disabilita quella interfaccia con `/interfaces/{nome}/state`.
- **Client WiFi/CAPsMAN/Hotspot**: la disconnessione è immediata perché il client viene rimosso dalla
  tabella di registrazione radio o dalla sessione hotspot attiva; se il dispositivo tenta di riconnettersi,
  resta comunque bloccato dalla regola firewall finché non lo sblocchi.
- **Sicurezza**: esponi questo servizio solo su rete fidata o dietro VPN/reverse proxy con TLS; la
  `API_KEY` viaggia in chiaro se non usi HTTPS davanti al servizio. Usa sempre un utente RouterOS dedicato
  con permessi minimi, mai l'account amministratore principale.
- Documentazione RouterOS REST API: https://help.mikrotik.com/docs/display/ROS/REST+API
