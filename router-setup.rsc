# =============================================================================
# router-setup.rsc — Setup RouterOS per TiKPanel
#
# Cosa fa:
#   1. Genera un certificato TLS self-signed e lo assegna al servizio www-ssl
#      (REST API di RouterOS in HTTPS)
#   2. Abilita www-ssl (porta 443) e disabilita www in chiaro (porta 80)
#   3. Crea un gruppo utente con permessi minimi e un utente API dedicato
#      (NON l'admin principale)
#   4. (opzionale) Limita l'accesso alla REST API al solo IP del PC/host che
#      esegue il container TiKPanel
#
# COME USARLO:
#   1. Modifica le variabili qui sotto (password, IP consentito, validità cert)
#   2. Copia questo file sul router (Files, WinBox drag&drop, o scp) oppure
#      incolla il contenuto direttamente nel terminale RouterOS
#   3. Eseguilo con:  /import file-name=router-setup.rsc
#   4. Segna la password generata: ti servirà nel file .env di TiKPanel
#      (MIKROTIK_USER / MIKROTIK_PASSWORD)
#
# Va eseguito con un utente che ha già permessi "policy" e "write" (es. admin).
# =============================================================================

# ---- Variabili da personalizzare -------------------------------------------
:local apiUser "api-user"
:local apiPassword "CAMBIA-QUESTA-PASSWORD-LUNGA-E-CASUALE"
:local certName "tikpanel-cert"
:local certDaysValid 3650
# IP (o subnet, es. 192.168.88.50/32) del PC/server che eseguirà TiKPanel.
# Lascia stringa vuota "" per NON restringere l'accesso via firewall (sconsigliato).
:local allowedSource "192.168.88.50/32"

# ---- 1. Certificato TLS self-signed -----------------------------------------
:if ([:len [/certificate find where name=$certName]] = 0) do={
    /certificate add name=$certName common-name=$certName days-valid=$certDaysValid \
        key-usage=key-cert-sign,crl-sign,tls-server
    /certificate sign $certName
    :log info ("TiKPanel: certificato '" . $certName . "' creato e firmato")
} else={
    :log info ("TiKPanel: certificato '" . $certName . "' gia' presente, salto")
}

# ---- 2. Servizio REST API (HTTPS su porta 443) -------------------------------
/ip service set www-ssl certificate=$certName disabled=no port=443
/ip service set www disabled=yes
:log info "TiKPanel: www-ssl abilitato con certificato, www (http) disabilitato"

# ---- 3. Gruppo e utente API dedicato -----------------------------------------
# NOTA: "test" è necessario per /tool/torch (traffico in tempo reale dei client) e per
# gli altri strumenti diagnostici di RouterOS (ping, bandwidth-test...). Senza "test"
# RouterOS rifiuta quelle richieste con un 500 "not enough permissions (9)".
:local apiGroupPolicy "read,write,api,rest-api,test,!local,!telnet,!ssh,!ftp,!reboot,!policy,!password,!sensitive,!romon,!dude,!tikapp,!winbox"

:if ([:len [/user group find where name=api-group]] = 0) do={
    /user group add name=api-group policy=$apiGroupPolicy
    :log info "TiKPanel: gruppo 'api-group' creato"
} else={
    /user group set [find where name=api-group] policy=$apiGroupPolicy
    :log info "TiKPanel: gruppo 'api-group' gia' presente, permessi aggiornati (incluso 'test')"
}

:if ([:len [/user find where name=$apiUser]] = 0) do={
    /user add name=$apiUser group=api-group password=$apiPassword
    :log info ("TiKPanel: utente '" . $apiUser . "' creato")
} else={
    /user set [find where name=$apiUser] password=$apiPassword group=api-group
    :log info ("TiKPanel: utente '" . $apiUser . "' gia' esistente, password aggiornata")
}

# ---- 4. (opzionale) Limita l'accesso www-ssl a un solo host ------------------
:if ([:len $allowedSource] > 0) do={
    :if ([:len [/ip firewall filter find where comment="TiKPanel: consenti REST API"]] = 0) do={
        /ip firewall filter add chain=input protocol=tcp dst-port=443 src-address=$allowedSource \
            action=accept comment="TiKPanel: consenti REST API" place-before=0
        /ip firewall filter add chain=input protocol=tcp dst-port=443 \
            action=drop comment="TiKPanel: blocca REST API da altri IP" place-before=1
        :log info ("TiKPanel: accesso a www-ssl (443) limitato a " . $allowedSource)
    }
} else={
    :log warning "TiKPanel: nessuna restrizione firewall impostata su www-ssl (ATTENZIONE)"
}

:put "Setup completato."
:put ("Utente API: " . $apiUser)
:put "Ricorda di copiare host/utente/password nel file .env di TiKPanel (MIKROTIK_* )."
:put "Se il certificato e' self-signed, imposta MIKROTIK_VERIFY_SSL=false nel .env."
