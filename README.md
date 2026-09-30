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
- **bloccare** il traffico di un client (address-list + regole firewall + lease DHCP — se il
  lease del client è ancora dinamico, RouterOS non permette di modificarlo direttamente:
  TikPanel lo rende prima statico automaticamente, il che significa che quel client mantiene
  da quel momento sempre lo stesso IP, anche dopo uno sblocco)
- **forzare la disconnessione** di un client già collegato (kick da WiFi/CAPsMAN/Hotspot, pulizia ARP)
- vedere le **reti WiFi configurate** (radio/SSID, qualunque stack: pacchetto `wifi`, CAPsMAN o
  wireless legacy) con i client collegati raggruppati per radio, **attivabili/disattivabili**
  e selezionabili in blocco (checkbox) per azioni di gruppo sui client (blocca/sblocca/disconnetti)
- vedere il **traffico in tempo reale** (bit/s in download e upload) di ogni interfaccia, VLAN,
  radio WiFi e client collegato

L'accesso alla dashboard avviene con un vero login: **utenti propri di TikPanel** (non gli utenti
RouterOS), con password salvate con hash bcrypt e ruolo **utente / operatore / amministratore**.
Può esistere **un solo amministratore alla volta** (non un elenco di più admin), ed è lui solo a
poter gestire gli altri utenti (tab "Utenti"). Finché non esiste ancora nessun utente, il login con
`INITIAL_ADMIN_USERNAME`/`INITIAL_ADMIN_PASSWORD` (vedi sotto) è accettato, ma **non crea da solo un
utente permanente**: è provvisorio e obbliga subito a scegliere nome utente e password del vero
amministratore in una schermata dedicata — nessun'altra parte della dashboard è raggiungibile prima
di completare questo passaggio. Da quel momento le credenziali da env var smettono di funzionare
(anche senza riavviare il container) e puoi rimuoverle dalla configurazione. La dashboard ha un tema
chiaro e uno scuro (icona in alto a destra, segue anche le preferenze del sistema di default).

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
   PC/server che eseguirà TiKPanel. Modifica le variabili in cima al file (password, IP
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
| `USERS_FILE` | Percorso del file con utenti/ruoli della dashboard (default `/data/users.json`). Deve stare su storage persistente — vedi sotto |
| `INITIAL_ADMIN_USERNAME` | Username delle credenziali di bootstrap, usate solo se `USERS_FILE` è vuoto/assente per sbloccare la schermata obbligatoria di creazione del vero amministratore (default `admin`) |
| `INITIAL_ADMIN_PASSWORD` | Password di bootstrap. **Obbligatoria al primo avvio**: senza, nessuno può fare login finché non crei un utente per altra via. Non crea da sola un utente: al login la dashboard obbliga a scegliere nome utente e password del vero amministratore, poi questa variabile smette subito di funzionare — **rimuovila dalla configurazione dopo il setup** (vedi sotto), è in chiaro come ogni variabile d'ambiente |

## Dashboard web (`/ui`)

La dashboard di TikPanel è su `http://<host>:8000/ui`, con quattro sezioni: Interfacce, VLAN,
Gestione WiFi, Utenti (solo l'amministratore). Il login (non l'`API_KEY`, riservata all'uso
programmatico) usa utenti propri di TikPanel — non gli utenti RouterOS — con ruolo utente,
operatore o amministratore, validi per la durata di `SESSION_EXPIRE_MINUTES`. L'amministratore è
unico: solo lui vede la tab "Utenti" e può creare/modificare/eliminare gli altri utenti (ma non
creare un secondo amministratore — va prima retrocesso o eliminato quello esistente); cosa può fare
esattamente ciascun ruolo sulle altre funzionalità (interfacce, VLAN, client) è ancora da definire —
per ora un utente autenticato con qualsiasi ruolo può operare su tutto tranne la gestione utenti
stessa.

### Primo accesso (nessun utente ancora creato)

Finché `USERS_FILE` è vuoto, la schermata di login accetta `INITIAL_ADMIN_USERNAME`/
`INITIAL_ADMIN_PASSWORD`, ma quel login è solo provvisorio: la dashboard mostra subito (senza
possibilità di uscirne) una schermata che obbliga a scegliere nome utente e password del vero
amministratore. Da quel momento:

- quel nuovo utente, con hash bcrypt salvato in `USERS_FILE`, è l'unico amministratore di TikPanel;
- le credenziali `INITIAL_ADMIN_*` smettono immediatamente di funzionare, anche senza riavviare il
  container — puoi rimuoverle dalla configurazione quando vuoi.

**Persistenza**: gli utenti sono salvati in `USERS_FILE` dentro il container. Su un host esterno
con `docker compose`, il file compose già include un volume dedicato (`tikpanel-data:/data`),
quindi sopravvive a un `docker compose up -d --build`. Sul router MikroTik, `/data` sta dentro il
`root-dir` del container, che è già l'intero filesystem persistito sul disco esterno — nessuna
configurazione aggiuntiva necessaria lì.

### Segreti in chiaro: cosa sapere

Le password **dentro** `USERS_FILE` sono salvate con hash bcrypt, mai in chiaro. Le **variabili
d'ambiente** del container invece sono in chiaro per natura (né Docker Compose in modalità
semplice né `/container/envs` di RouterOS le cifrano):

- `INITIAL_ADMIN_PASSWORD` serve solo al primissimo avvio. Dopo che il primo amministratore è
  stato creato (il log del container lo conferma: cerca "Primo amministratore TikPanel creato"),
  **rimuovila** dalla configurazione:
  - RouterOS: `/container/envs remove [find where name=tikpanel-env and key=INITIAL_ADMIN_PASSWORD]`,
    poi riavvia il container
  - Docker: toglila da `.env`, poi `docker compose up -d`
- `MIKROTIK_PASSWORD`, `API_KEY`, `SECRET_KEY` restano necessarie sempre (credenziali di servizio
  usate a ogni richiesta), quindi non si possono rimuovere allo stesso modo. Limita chi può
  leggerle: su Docker tieni `.env` con permessi ristretti (`chmod 600 .env`, e non committarlo mai
  — è già in `.gitignore`); su RouterOS solo chi ha accesso admin al router vede
  `/container/envs print`, già un livello di fiducia alto.

## Avvio con Docker

```bash
docker compose up -d --build
```

Il servizio risponde su `http://<host-del-container>:8000`, con documentazione interattiva su
`/docs` (Swagger) e `/redoc`.

### Build manuale senza compose

```bash
docker build -t tikpanel .
docker run -d --name tikpanel --env-file .env -p 8000:8000 --restart unless-stopped tikpanel
```

### Esecuzione a bordo router MikroTik

Su RouterOS con il pacchetto `container` abilitato:

```
/container/mounts/add name=gate-env src-path=/gate/.env dst-path=/app/.env
/container/add remote-image=ghcr.io/beardev-it/tikpanel:latest interface=veth1 root-dir=usb1/gate mounts=gate-env
/container/start [find comment="tikpanel"]
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

# traffico istantaneo (bit/s) — funziona su qualunque interfaccia RouterOS: fisica, VLAN
# o radio WiFi/CAPsMAN/wireless, dato che per RouterOS sono tutte "interface"
curl -s -H "X-API-Key: $KEY" http://localhost:8000/interfaces/ether3/traffic
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

# traffico istantaneo (bit/s) stimato per un client (via torch, richiede IP + interfaccia
# su cui il client è noto — la dashboard li passa automaticamente da /clients o /wifi-networks)
curl -s -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"ip_address":"192.168.88.50","interface":"wlan1"}' \
     http://localhost:8000/clients/traffic
```

> Il traffico per client è una stima best-effort (RouterOS non tiene un contatore nativo
> per singolo client senza una coda dedicata): se IP o interfaccia non sono noti risponde
> `{"available": false}` invece di un errore.

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
