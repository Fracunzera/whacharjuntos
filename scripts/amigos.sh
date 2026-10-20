#!/bin/sh
# Gestiona los logins de tus amigos (sin base de datos).
#
# Cada amigo es un usuario de MediaMTX con permiso SOLO de lectura. Se guardan
# en viewers.env (no se commitea) como variables MTX_AUTHINTERNALUSERS_<n>_*,
# con la contraseña hasheada (sha256). docker-compose.yml carga ese archivo.
#
#   scripts/amigos.sh agregar <nombre>     crea el usuario y muestra su contraseña
#   scripts/amigos.sh nueva-clave <nombre> le genera una contraseña nueva
#   scripts/amigos.sh quitar <nombre>      lo borra (pierde el acceso)
#   scripts/amigos.sh listar
#
# Después de cualquier cambio: docker compose up -d
# (reinicia MediaMTX: si estás transmitiendo, OBS se reconecta).
set -eu

cd "$(dirname "$0")/.."
FILE=viewers.env
# 0 = publisher, 1 = viewer del link ?t= (ver mediamtx.yml). Los amigos van después.
FIRST_INDEX=2

die() { echo "error: $*" >&2; exit 1; }

# Imprime "nombre hash" por amigo, en orden.
entries() {
  [ -f "$FILE" ] || return 0
  awk '
    /^MTX_AUTHINTERNALUSERS_[0-9]+_USER=/ {
      split($0, a, "_"); i = a[3]; order[++n] = i
      user[i] = substr($0, index($0, "=") + 1)
    }
    /^MTX_AUTHINTERNALUSERS_[0-9]+_PASS=/ {
      split($0, a, "_"); pass[a[3]] = substr($0, index($0, "=") + 1)
    }
    END { for (k = 1; k <= n; k++) print user[order[k]], pass[order[k]] }
  ' "$FILE"
}

# Lee "nombre hash" por stdin y reescribe viewers.env con índices consecutivos.
write() {
  tmp="$FILE.tmp.$$"
  umask 077
  {
    echo "# Generado por scripts/amigos.sh. No editar a mano."
    awk -v first="$FIRST_INDEX" 'NF == 2 {
      i = first + n++
      printf "MTX_AUTHINTERNALUSERS_%d_USER=%s\n", i, $1
      printf "MTX_AUTHINTERNALUSERS_%d_PASS=%s\n", i, $2
      printf "MTX_AUTHINTERNALUSERS_%d_PERMISSIONS_0_ACTION=read\n", i
    }'
  } > "$tmp"
  mv "$tmp" "$FILE"
}

exists() { entries | awk -v u="$1" '$1 == u { found = 1 } END { exit !found }'; }

hash() { printf '%s' "$1" | openssl dgst -binary -sha256 | openssl base64 -A; }

check_name() {
  echo "$1" | grep -Eq '^[a-z0-9_-]{1,32}$' \
    || die "nombre inválido: usá minúsculas, números, _ o - (hasta 32)"
  case "$1" in
    any | viewer | publisher) die "\"$1\" es un nombre reservado" ;;
  esac
}

domain() { sed -n 's/^DOMAIN=//p' .env 2>/dev/null | tail -n 1; }

show_login() {
  d=$(domain)
  echo
  echo "  Usuario:    $1"
  echo "  Contraseña: $2"
  echo "  Página:     https://${d:-TU_DOMINIO}/?r=<sala>"
  echo
  echo "La contraseña no se guarda en ningún lado: copiásela ahora."
  echo "Aplicá el cambio con: docker compose up -d"
}

command -v openssl >/dev/null || die "falta openssl"

cmd=${1:-}
name=${2:-}

case "$cmd" in
  agregar | add)
    [ -n "$name" ] || die "uso: $0 agregar <nombre>"
    check_name "$name"
    ! exists "$name" || die "\"$name\" ya existe (usá nueva-clave)"
    pass=$(openssl rand -hex 12)
    { entries; echo "$name sha256:$(hash "$pass")"; } | write
    echo "Agregado \"$name\"."
    show_login "$name" "$pass"
    ;;
  nueva-clave | reset)
    [ -n "$name" ] || die "uso: $0 nueva-clave <nombre>"
    exists "$name" || die "\"$name\" no existe"
    pass=$(openssl rand -hex 12)
    entries | awk -v u="$name" -v h="sha256:$(hash "$pass")" '{ print $1, ($1 == u ? h : $2) }' | write
    echo "Contraseña nueva para \"$name\"."
    show_login "$name" "$pass"
    ;;
  quitar | remove)
    [ -n "$name" ] || die "uso: $0 quitar <nombre>"
    exists "$name" || die "\"$name\" no existe"
    entries | awk -v u="$name" '$1 != u' | write
    echo "Quitado \"$name\". Aplicá el cambio con: docker compose up -d"
    ;;
  listar | list)
    n=$(entries | wc -l | tr -d ' ')
    if [ "$n" = 0 ]; then
      echo "Todavía no hay amigos. Agregá uno con: $0 agregar <nombre>"
    else
      entries | awk '{ print $1 }'
    fi
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
