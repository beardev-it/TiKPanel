# Guida all'installazione di TiKPanel su router MikroTik

Questa guida documenta la procedura **effettivamente testata e funzionante** per installare
TiKPanel direttamente su una RouterBOARD (validata su RB5009UPr, RouterOS 7.24.4, arm64).
Include gli errori incontrati durante il setup e come sono stati risolti, così da evitarli.

## Prerequisiti

- RouterOS **≥ 7.4** con supporto al pacchetto `container` (architettura arm, arm64 o x86 — non mipsbe)
- Un disco esterno (microSD o USB) collegato e riconosciuto da RouterOS
- Accesso WinBox/CLI con utente amministratore

## Panoramica della procedura

1. Formattare/preparare il disco esterno e (opzionale ma consigliato) creare una partizione di swap
2. Abilitare il pacchetto `container` (richiede conferma fisica + riavvio)
3. Creare un certificato TLS self-signed e abilitare la REST API (`www-ssl`)
4. Creare un utente API dedicato con permessi minimi
5. Configurare la rete per il container (interfaccia `veth`, **senza** un bridge aggiuntivo)
6. Configurare il subsystem container (registry, storage temporaneo)
7. Aggiungere le variabili d'ambiente e avviare il container

Lo script `tikpanel-full-setup.rsc` allegato automatizza i punti 3-7. I punti 1-2 vanno
fatti a parte (il punto 2 richiede un'interazione fisica sul router e non è scriptabile).

---

## 1. Disco esterno e swap

```
/disk print detail
```
Prendi nota dello **slot** (es. `usb1`). Se non è formattato:
```
/disk format-drive usb1 file-system=ext4
```

Molti router MikroTik hanno poca RAM (128-512 MB); i container possono andare in sofferenza di
memoria durante il pull/decompressione dell'immagine. Aggiungere uno swap sul disco esterno aiuta
a evitare crash per out-of-memory:
```
/disk add type=swap slot=usb1
```
(sostituisci `usb1` con lo slot reale; opzionale `size=1G` per limitare la dimensione)

**Nota importante**: lo swap creato **non compare** in `/system resource print` come memoria
totale aggiuntiva — quel campo riporta solo la RAM fisica, esattamente come `free -h` su Linux
tiene RAM e Swap separati. Per verificare che lo swap sia attivo controlla `/disk print detail`
(deve mostrare una riga `type=swap`), oppure mettilo sotto stress (pull di un'immagine grande) e
osserva che il router non vada in crash per OOM.

## 2. Abilita il pacchetto container

```
/system/device-mode/update container=yes
```
Il router chiede conferma fisica (di solito il tasto reset) e si riavvia da solo. Dopo il riavvio:
```
/system/device-mode/print
```
deve mostrare `container: yes`.

## 3-7. Setup automatico

Apri `tikpanel-full-setup.rsc`, personalizza in cima al file:

| Variabile | Cosa impostare |
|---|---|
| `apiPassword` | password forte per l'utente `api-user` |
| `diskSlot` | lo slot del tuo disco esterno (es. `usb1`) |
| `gateApiKey` | chiave lunga e casuale — sarà la `X-API-Key` per uso programmatico (script/curl) |
| `gateSecretKey` | **obbligatoria**, diversa da `gateApiKey` — firma le sessioni di login della dashboard web `/ui`. Senza questa il container non parte |
| `dashboardAdminUser` / `dashboardAdminPassword` | credenziali di **bootstrap** per il primissimo accesso alla dashboard TikPanel. **Non** sono un utente RouterOS e non creano da sole un utente permanente: al primo login la dashboard obbliga subito a scegliere nome utente e password del vero (unico) amministratore, salvato con hash in `users.json` — da lì potrai poi creare altri utenti con ruolo operatore/utente |
| `containerSubnet` / `containerIp` / `gatewayIp` | modifica solo se `172.16.99.0/24` è già in uso sulla tua rete |
| `image` | lascia `ghcr.io/beardev-it/tikpanel:latest` salvo tu voglia un'immagine tua |

Poi:
```
/import file-name=tikpanel-full-setup.rsc
```

Segui l'avanzamento con:
```
/container/print detail
/log print where topics~"container"
```

Il pull dell'immagine da ghcr.io può richiedere qualche minuto la prima volta.

## Verifica finale

```
/tool fetch url="http://<containerIp>:8000/health" http-method=get output=user
```
Deve rispondere `{"status":"ok"}` (nessuna autenticazione richiesta su questo endpoint).

Per un endpoint autenticato:
```
/tool fetch url="http://<containerIp>:8000/interfaces" http-method=get \
  http-header-field="X-API-Key: la-tua-gateApiKey" output=user
```
Deve rispondere con la lista delle interfacce del router in formato JSON.

Infine apri da un browser sulla tua LAN `http://<containerIp>:8000/ui` (dashboard **TikPanel**):
fai login con `dashboardAdminUser`/`dashboardAdminPassword` (non sono credenziali RouterOS: sono
solo il bootstrap del primissimo accesso). La dashboard mostrerà subito, senza possibilità di
uscirne, una schermata obbligatoria per creare il vero amministratore: scegli lì nome utente e
password definitivi (salvati con hash in `users.json`) e prosegui — sarà l'unico amministratore, da
cui potrai poi creare altri utenti con ruolo operatore o utente dalla tab "Utenti".

**Importante**: `INITIAL_ADMIN_PASSWORD` (la variabile dietro `dashboardAdminPassword`) resta in
chiaro nella configurazione del container finché non la rimuovi — serve solo al primissimo avvio, e
smette comunque di funzionare non appena crei il vero amministratore nella schermata di setup. Una
volta completato il setup, rimuovila:
```
/container/envs remove [find where name=tikpanel-env and key=INITIAL_ADMIN_PASSWORD]
/container/stop 0
/container/start 0
```

## Aggiornare il container senza perdere gli utenti

`tikpanel-full-setup.rsc` crea un **mount persistente** (`/container/mounts`) per `/data`,
separato dal `root-dir` del container. È necessario perché `root-dir` viene interamente
ri-estratto dall'immagine ad ogni `/container/repull`: qualunque cosa scritta lì dall'app in
esecuzione — incluso `users.json`, con gli utenti della dashboard — andrebbe persa a ogni
aggiornamento. Il mount invece non fa parte dell'immagine, quindi sopravvive.

Con questo mount configurato, aggiornare è sicuro:
```
/container/stop 0
/container/repull 0
/container/start 0
```

### Hai già un'installazione senza il mount?

Se hai installato TiKPanel prima che questo mount esistesse (o se hai già perso gli utenti dopo
un repull), va migrata una volta sola:

1. **Salva gli utenti attuali** (se ti interessano): apri WinBox → Files, naviga fino a
   `<tuo-disco>/containers/tikpanel/data/users.json` (il percorso dentro il `root-dir` esistente)
   e scaricalo sul tuo PC — oppure segna semplicemente username/ruoli da ricreare a mano dopo,
   se sono pochi (le password non sono comunque recuperabili, sono hash: dovrai reimpostarle).
2. **Crea il mount e collegalo al container esistente** (il campo che identifica un mount è
   `list`, non `name`; il container lo referenzia con `mountlists`, non `mounts`):
   ```
   /container/mounts add list=tikpanel-data src=<tuo-disco>/containers/tikpanel-data dst=/data
   /container/stop 0
   /container/set 0 mountlists=tikpanel-data
   ```
   Se la tua versione di RouterOS non permette di modificare `mountlists` su un container già
   creato (`/container/set` rifiuta), rimuovi il container e ricrealo da capo:
   ```
   /container/remove 0
   ```
   poi rilancia `tikpanel-full-setup.rsc` (ha già il mount incluso: i passi già fatti, come
   certificato e utente API, vengono rilevati e saltati automaticamente).
3. **Ripristina il file** (se salvato al passo 1): tramite WinBox → Files, copia lo
   `users.json` salvato dentro `<tuo-disco>/containers/tikpanel-data/users.json` (il nuovo
   percorso del mount, ancora vuoto a questo punto).
4. **Riavvia**:
   ```
   /container/start 0
   ```
   Se non hai ripristinato nessun file al passo 3, al primo accesso la dashboard chiederà di
   nuovo il setup dell'amministratore (con le credenziali `INITIAL_ADMIN_*`, se ancora presenti
   nelle variabili d'ambiente — altrimenti vanno riaggiunte prima di riavviare).

Da questo momento in poi, `/container/repull` non tocca più `/data`.

---

## Errori incontrati durante il setup (e come evitarli)

Questi sono i problemi reali riscontrati durante l'installazione su RB5009UPr — lo script
`tikpanel-full-setup.rsc` li evita già tutti, ma è utile saperli riconoscere se qualcosa
va storto in una configurazione diversa dalla tua.

### `/ip address add address=X interface=veth1` in conflitto

Se usi una veth "nuda" (senza bridge, come in questa guida), **non** aggiungere manualmente
un indirizzo IP separato sull'interfaccia veth con `/ip address add`: l'indirizzo del lato
router è già quello passato come `gateway=` nel comando `/interface veth add`. Aggiungerne
uno secondo manualmente crea ambiguità di routing e i pacchetti verso/dal container smettono
di funzionare (timeout).

### `MIKROTIK_HOST=127.0.0.1` non funziona dal container

Il container ha un proprio namespace di rete: il suo `127.0.0.1` è se stesso, non il router
che lo ospita. Per raggiungere la REST API di RouterOS dal container va usato l'IP del router
**visto dal lato veth**, cioè il gateway (`172.16.99.1` in questa guida) — non `127.0.0.1` e
non necessariamente l'IP LAN "principale" del router.

### `502 Bad Gateway` dagli endpoint che parlano con RouterOS

Sintomo di TiKPanel quando non riesce a raggiungere la REST API di RouterOS. Cause
riscontrate, in ordine di probabilità:
1. `MIKROTIK_HOST` sbagliato (vedi sopra)
2. Certificato TLS mancante o non firmato su `www-ssl` (vedi sotto) — solo se `MIKROTIK_USE_SSL=true`
3. Credenziali dell'utente API errate

### `SSL: ssl: fatal alert handshake (6)` testando la REST API in HTTPS

Il servizio `www-ssl` non aveva un certificato assegnato (o assegnato ma mai firmato con
`/certificate sign`). Un certificato "vuoto" di chiave privata utilizzabile fa fallire
l'handshake TLS ancora prima della verifica del client. Verifica con:
```
/certificate print detail
```
il certificato usato da `www-ssl` deve avere il flag **K** (chiave privata presente). Se manca,
ricrealo e firmalo:
```
/certificate add name=tikpanel-cert common-name=tikpanel-cert days-valid=3650 key-usage=key-cert-sign,crl-sign,tls-server
/certificate sign tikpanel-cert
/ip service set www-ssl certificate=tikpanel-cert disabled=no
```

### `critical login failure for user api-user via api`

Fallimento di autenticazione REST — il log lo riporta come `via api` perché la REST API di
RouterOS 7 usa lo stesso backend di autenticazione della vecchia API binaria. Verifica:
```
/user print detail where name=api-user
/user group print detail where name=api-group
```
che l'utente non sia `disabled=yes` e che il gruppo includa almeno `read,write,api,rest-api`.
Se il sospetto è la password, resettala esplicitamente con `/user set ... password=...` e
riprova — evita temporaneamente caratteri come `!`/`` ` ``/`$` nei test diagnostici per
escludere problemi di escaping nella catena di comandi.

### Metodo di diagnosi generale che ha funzionato

Quando qualcosa non risponde, isola il problema un livello alla volta invece di ipotizzare:
1. `/ping <ip-container>` — livello di rete di base
2. `/tool fetch` **in HTTP semplice** (`/ip service enable www` temporaneamente) verso la REST
   API — isola se il problema è SSL o è più a monte (rete, autenticazione, servizio disattivo)
3. `/tool fetch ... check-certificate=no` in HTTPS — isola un problema di certificato non
   fidato da un handshake che fallisce comunque (es. certificato mancante lato server)
4. Test diretto **dal router stesso** verso la REST API (bypassando il container) — isola se il
   problema è nel container/nella rete container-router o nella REST API stessa
5. Solo dopo aver isolato il livello, guarda il body/log dell'errore specifico
