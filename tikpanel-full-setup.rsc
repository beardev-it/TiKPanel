# =============================================================================
# tikpanel-full-setup.rsc — Setup completo RouterOS per TiKPanel
#
# Consolida l'intera procedura validata: certificato TLS, servizio REST API,
# utente API dedicato, rete per i container (veth, senza bridge aggiuntivo),
# configurazione del subsystem container e avvio del container TiKPanel.
#
# COME USARLO:
#   1. Personalizza le variabili nella sezione "Variabili da personalizzare"
#   2. Copia questo file sul router (Files, WinBox drag&drop, o scp)
#   3. Eseguilo con: /import file-name=tikpanel-full-setup.rsc
#   4. Se il pacchetto "container" non è ancora abilitato, il router te lo
#      segnala e si ferma: esegui manualmente
#         /system/device-mode/update container=yes
#      conferma quando richiesto (di solito va premuto il tasto reset fisico),
#      attendi il riavvio, poi rilancia questo script.
# =============================================================================

# ---- Variabili da personalizzare -------------------------------------------
:local apiUser "api-user"
:local apiPassword "CAMBIA-QUESTA-PASSWORD-LUNGA-E-CASUALE"
:local certName "tikpanel-cert"
:local certDaysValid 3650

# Rete dedicata al container (nessun bridge aggiuntivo: solo veth + NAT)
:local vethName "veth1"
:local containerIp "172.16.99.2"
:local gatewayIp "172.16.99.1"
:local containerSubnet "172.16.99.0/24"

# Disco esterno (stesso usato per lo swap) — nome slot da /disk print detail
:local diskSlot "usb1"

# Immagine e configurazione del container TiKPanel
:local image "ghcr.io/beardev-it/tikpanel:latest"
:local containerRootDir ($diskSlot . "/containers/tikpanel")
:local envListName "tikpanel-env"
:local gateApiKey "CAMBIA-CON-UNA-CHIAVE-LUNGA-E-CASUALE"
:local gateSecretKey "CAMBIA-CON-UN-ALTRA-CHIAVE-LUNGA-E-CASUALE-DIVERSA"

# Primo utente della dashboard TikPanel (ruolo amministratore), creato in automatico
# al primo avvio se non esiste ancora nessun utente. Non è un utente RouterOS: serve
# solo per fare login su TikPanel stessa, poi da lì puoi crearne altri con ruoli diversi.
:local dashboardAdminUser "admin"
:local dashboardAdminPassword "CAMBIA-CON-UNA-PASSWORD-LUNGA-E-CASUALE"

# =============================================================================
# 1. Certificato TLS self-signed per la REST API (www-ssl)
# =============================================================================
:if ([:len [/certificate find where name=$certName]] = 0) do={
    /certificate add name=$certName common-name=$certName days-valid=$certDaysValid \
        key-usage=key-cert-sign,crl-sign,tls-server
    /certificate sign $certName
    :log info ("TiKPanel: certificato '" . $certName . "' creato e firmato")
} else={
    :log info ("TiKPanel: certificato '" . $certName . "' gia' presente, salto")
}

/ip service set www-ssl certificate=$certName disabled=no port=443
/ip service set www disabled=yes
:log info "TiKPanel: www-ssl abilitato con certificato, www (http) disabilitato"

# =============================================================================
# 2. Utente API dedicato con permessi minimi
# =============================================================================
:if ([:len [/user group find where name=api-group]] = 0) do={
    /user group add name=api-group \
        policy=read,write,api,rest-api,!local,!telnet,!ssh,!ftp,!reboot,!policy,!password,!sensitive,!romon,!dude,!tikapp,!winbox
    :log info "TiKPanel: gruppo 'api-group' creato"
}

:if ([:len [/user find where name=$apiUser]] = 0) do={
    /user add name=$apiUser group=api-group password=$apiPassword
    :log info ("TiKPanel: utente '" . $apiUser . "' creato")
} else={
    /user set [find where name=$apiUser] password=$apiPassword group=api-group disabled=no
    :log info ("TiKPanel: utente '" . $apiUser . "' gia' esistente, password aggiornata")
}

# =============================================================================
# 3. Rete per il container (solo veth + NAT, nessun bridge aggiuntivo)
# =============================================================================
:if ([:len [/interface veth find where name=$vethName]] = 0) do={
    /interface veth add name=$vethName address=($containerIp . "/24") gateway=$gatewayIp
    :log info ("TiKPanel: interfaccia veth '" . $vethName . "' creata")
} else={
    :log info ("TiKPanel: interfaccia veth '" . $vethName . "' gia' presente, salto")
}

:if ([:len [/ip firewall nat find where comment="TiKPanel: NAT container"]] = 0) do={
    /ip firewall nat add chain=srcnat action=masquerade src-address=$containerSubnet \
        comment="TiKPanel: NAT container"
    :log info "TiKPanel: regola NAT per il container aggiunta"
}

# =============================================================================
# 4. Subsystem container: registry e storage temporaneo sul disco esterno
# =============================================================================
/container/config set registry-url="https://ghcr.io" tmpdir=($diskSlot . "/pull")
:log info "TiKPanel: registry-url e tmpdir configurati"

# =============================================================================
# 4bis. Mount persistente per i dati di TiKPanel (utenti/ruoli)
# =============================================================================
# IMPORTANTE: root-dir viene interamente ri-estratto dall'immagine ad ogni
# /container/repull (aggiornamento a una nuova versione): qualunque cosa scritta
# lì dall'app in esecuzione (come /data/users.json, creato al primo login) andrebbe
# persa ad ogni aggiornamento. Un mount dedicato invece vive FUORI dal root-dir e
# non fa parte dell'immagine, quindi il repull non lo tocca.
:local dataMountName "tikpanel-data"
:local dataMountSrc ($diskSlot . "/containers/tikpanel-data")

# NOTA: il campo che identifica un mount su /container/mounts si chiama "list" (non
# "name" — un errore facile, perché "name" esiste su tante altre menu RouterOS ma non
# qui), e /container/add lo referenzia con "mountlists" (non "mounts").
:if ([:len [/container/mounts find where list=$dataMountName]] = 0) do={
    /container/mounts add list=$dataMountName src=$dataMountSrc dst="/data"
    :log info ("TiKPanel: mount persistente '" . $dataMountName . "' creato (" . $dataMountSrc . " -> /data)")
} else={
    :log info ("TiKPanel: mount persistente '" . $dataMountName . "' gia' presente, salto")
}

# =============================================================================
# 5. Variabili d'ambiente del container (equivalenti al file .env)
# =============================================================================
:if ([:len [/container/envs find where name=$envListName]] > 0) do={
    /container/envs remove [find where name=$envListName]
}
/container/envs add name=$envListName key=MIKROTIK_HOST value=$gatewayIp
/container/envs add name=$envListName key=MIKROTIK_PORT value="443"
/container/envs add name=$envListName key=MIKROTIK_USE_SSL value="true"
/container/envs add name=$envListName key=MIKROTIK_VERIFY_SSL value="false"
/container/envs add name=$envListName key=MIKROTIK_USER value=$apiUser
/container/envs add name=$envListName key=MIKROTIK_PASSWORD value=$apiPassword
/container/envs add name=$envListName key=API_KEY value=$gateApiKey
/container/envs add name=$envListName key=SECRET_KEY value=$gateSecretKey
/container/envs add name=$envListName key=INITIAL_ADMIN_USERNAME value=$dashboardAdminUser
/container/envs add name=$envListName key=INITIAL_ADMIN_PASSWORD value=$dashboardAdminPassword
:log info "TiKPanel: variabili d'ambiente del container configurate"

# =============================================================================
# 6. Aggiungi e avvia il container
# =============================================================================
:if ([:len [/container find where root-dir=$containerRootDir]] = 0) do={
    /container/add remote-image=$image interface=$vethName root-dir=$containerRootDir \
        mountlists=$dataMountName envlist=$envListName logging=yes
    :log info "TiKPanel: container aggiunto, pull immagine in corso..."
} else={
    :log warning "TiKPanel: un container con questo root-dir esiste gia', non ricreato (se veniva da una installazione precedente senza il mount persistente, vedi INSTALL.md per la migrazione)"
}

:delay 3s
/container/start [find where root-dir=$containerRootDir]

:put "Setup completato."
:put ("Utente API: " . $apiUser)
:put ("Container IP: " . $containerIp . "  Gateway/Router: " . $gatewayIp)
:put "Il pull dell'immagine puo' richiedere qualche minuto: controlla con /container/print detail"
:put ("Test: /tool fetch url=\"http://" . $containerIp . ":8000/health\" http-method=get output=user")
