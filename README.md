# whacharjuntos

Servidor self-hosted para "ver cosas juntos": vos transmitís tu pantalla
**desde el navegador** (`/transmitir`) **o desde OBS**, y 3-5 amigos la ven en
el navegador abriendo un link y entrando con su usuario. Solo video + audio del
stream; la voz y la cámara van por Discord. El viewer es de **solo lectura**:
nunca pide micrófono ni cámara (y la `Permissions-Policy` se lo prohíbe al
navegador).

```
                          HTTPS 443 (señalización WHIP)
 OBS (tu PC) ─────────────────────────────┐
     │                                    ▼
     │ UDP 8189 (media WebRTC)     ┌─────────────┐  HTTP interno  ┌──────────────────┐
     └────────────────────────────►│             │ ──────────────►│ MediaMTX 1.21.2  │
                                   │   Caddy     │  :8889 WHIP/WHEP│  passthrough,    │
 Navegador amigo ── HTTPS 443 ────►│  (TLS LE)   │  :8888 LL-HLS   │  sin transcodear │
     ▲            (WHEP / LL-HLS)  └─────────────┘                └──────────────────┘
     │                                                                    │
     └──────────────────── UDP 8189 (media WebRTC, directo) ──────────────┘
```

- **MediaMTX** (`bluenviron/mediamtx:1.21.2`, pineado) recibe WHIP de OBS y lo
  reparte por WHEP (sub-segundo) y LL-HLS (≈1-3 s). Es passthrough puro: el
  codec y el bitrate los define OBS (H.264 + Opus). El VPS no transcodifica.
- **Caddy** (`caddy:2.11.7-alpine`, pineado) termina TLS con Let's Encrypt,
  sirve el viewer estático y hace proxy **solo de la señalización HTTP**.
- **Login sin base de datos**: cada amigo tiene su usuario y contraseña, que
  son usuarios de **solo lectura** de MediaMTX (se crean con
  `scripts/amigos.sh`). MediaMTX valida las credenciales en cada conexión.
- **Viewer**: `web/` — HTML + CSS + JS vanilla, sin build. Cliente WHEP escrito
  a mano con `RTCPeerConnection` + `fetch`. Para LL-HLS usa el `hls.min.js`
  que viene embebido en el propio binario de MediaMTX (lo sirve Caddy en
  `/_lib/hls.min.js`), así que no hay CDN ni dependencias vendorizadas.

## Archivos

| Archivo | Qué es |
|---|---|
| `docker-compose.yml` | Servicios `mediamtx` y `caddy`, red interna con subred fija. |
| `docker-compose.rtmp.yml` | Override opcional para el fallback RTMP (1935). |
| `docker-compose.nginx.yml` | Override para usar el nginx del host en vez de Caddy. |
| `deploy/nginx-whacharjuntos.conf` | vhost de nginx equivalente al `Caddyfile`. |
| `mediamtx.yml` | Config de MediaMTX (claves verificadas contra el `mediamtx.yml` de referencia de v1.21.2). |
| `Caddyfile` | TLS automático, ruteo de WHIP/WHEP/HLS y headers de seguridad. |
| `web/` | El viewer (`index.html`, `style.css`, `app.js`), con pantalla de login. |
| `web/transmitir/` | Página para transmitir desde el navegador, sin OBS (solo para vos). |
| `scripts/amigos.sh` | Alta/baja de los logins de tus amigos. |
| `viewers.env` | Lo genera `amigos.sh` (contraseñas hasheadas). **No se commitea.** |
| `.env.example` | Todas las variables. Copialo a `.env`. |

---

## Setup paso a paso

### 1. DNS

Creá un registro **A** para `watchando.blucaro.site` apuntando a la IPv4
pública del VPS (y AAAA si tenés IPv6 bien configurado). Esperá a que propague
(`dig +short watchando.blucaro.site`) **antes** del primer arranque: Caddy
necesita que el dominio resuelva al VPS para sacar el certificado.

### 2. Docker

En el VPS (Debian/Ubuntu):

```sh
curl -fsSL https://get.docker.com | sh
```

Necesitás Docker Engine con el plugin `docker compose` (v2).

### 3. Clonar y configurar

```sh
git clone <este repo> whacharjuntos && cd whacharjuntos
cp .env.example .env
```

Editá `.env`:

```sh
DOMAIN=watchando.blucaro.site
ACME_EMAIL=tu@email.com
PUBLIC_HOST=<IPv4 pública del VPS>           # curl -4 ifconfig.me
PUBLISH_USER=publisher
PUBLISH_PASS=$(openssl rand -hex 24)          # pegá el valor, no el comando
VIEWER_TOKEN=                                 # vacío = link compartido apagado (recomendado)
```

> Las contraseñas solo pueden usar `A-Z a-z 0-9 ! $ ( ) * + . ; < = > [ ] ^ _ - { } @ # &`
> y **nunca** `:` (separa usuario y contraseña en el Bearer token). Los valores
> hex de `openssl rand -hex` siempre sirven.

`docker compose` se niega a arrancar si falta `DOMAIN`, `ACME_EMAIL`,
`PUBLIC_HOST` o `PUBLISH_PASS`. Es a propósito: en MediaMTX una contraseña
vacía significa "acepta cualquier contraseña". Por el mismo motivo, si
`VIEWER_TOKEN` está vacío, compose le pone un hash imposible (nadie entra por
link), nunca un valor vacío.

### 3b. Crear los logins de tus amigos

```sh
scripts/amigos.sh agregar ana
scripts/amigos.sh agregar juan
```

Cada comando imprime el usuario y una contraseña aleatoria **que no se guarda
en ningún lado** (en `viewers.env` queda solo el hash sha256): pasásela a tu
amigo por Discord en ese momento.

```sh
scripts/amigos.sh listar             # quiénes tienen acceso
scripts/amigos.sh nueva-clave ana    # se la olvidó / la filtró
scripts/amigos.sh quitar juan        # le saca el acceso
```

Después de cualquier cambio: `docker compose up -d`. Eso reinicia MediaMTX (si
estás transmitiendo, OBS se reconecta y los viewers también, solos). Necesita
`openssl` en el VPS (viene en Debian/Ubuntu) y docker compose ≥ 2.24.

### 4. Firewall (ver la sección siguiente, es crítica)

### 5. Arrancar

```sh
docker compose up -d
docker compose logs -f
```

Tenés que ver en los logs de MediaMTX:

```
[HLS] started with listener on :8888 (TCP/HTTP)
[WebRTC] started with listeners on :8889 (TCP/HTTP), :8189 (UDP/ICE)
```

y en Caddy que obtuvo el certificado para `watchando.blucaro.site`.

### 6. Probar con curl

```sh
# Login correcto, todavía sin transmisión -> 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/sdp' -H 'Authorization: Bearer ana:<contraseña de ana>' \
  --data 'v=0' https://watchando.blucaro.site/sala/whep

# Contraseña incorrecta -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/sdp' -H 'Authorization: Bearer ana:nope' \
  --data 'v=0' https://watchando.blucaro.site/sala/whep
```

### 7. Link para tus amigos

```
https://watchando.blucaro.site/?r=<sala>
```

La página pide **usuario y contraseña** (los de `amigos.sh`). Con "Recordarme
en este dispositivo" no se los vuelve a pedir en ese navegador; el botón de
salir (en la barra de controles) los borra. Sin `?r=` la página pide también
la sala.

`<sala>` es el nombre que pusiste en la URL de OBS (`[A-Za-z0-9_-]`, hasta 64
caracteres). Pueden entrar antes de que arranques: el viewer muestra
"esperando transmisión" y se conecta solo cuando empezás.

**Link compartido sin login (opcional, apagado por defecto):** si ponés
`VIEWER_TOKEN` en `.env`, también funciona
`https://watchando.blucaro.site/?r=<sala>&t=<VIEWER_TOKEN>`. Es más cómodo
pero cualquiera que tenga el link entra (se puede reenviar), y revocarlo corta
a todos. El viewer saca el token de la barra de direcciones apenas lo lee.

---

## Si el VPS ya tiene nginx en 80/443

Caddy necesita 80/443. Si en el host ya hay un nginx sirviendo otros sitios,
no hace falta Caddy:

1. En `.env`: `COMPOSE_FILE=docker-compose.yml:docker-compose.nginx.yml`.
   Esto apaga Caddy y publica 8888/8889 de MediaMTX **solo en 127.0.0.1**.
   (`ACME_EMAIL` igual tiene que tener algún valor, no se usa.)
2. `docker compose up -d`
3. Instalar el vhost (`deploy/nginx-whacharjuntos.conf`, equivalente al
   Caddyfile: mismos headers y ruteo), ajustando `server_name` y `root`:

   ```sh
   cp deploy/nginx-whacharjuntos.conf /etc/nginx/sites-available/whacharjuntos
   ln -s ../sites-available/whacharjuntos /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d watchando.blucaro.site --redirect
   ```

4. Abrir **`8189/udp`** y **`8189/tcp`** (80/443 TCP ya los tiene nginx).

Con nginx, el proxy confiable que ve MediaMTX es el gateway de la red
`edge` (`172.30.80.1`), que está dentro de `EDGE_SUBNET`: no hay que tocar
nada más.

---

## Red y puertos (crítico)

| Puerto | Proto | Para qué | ¿Abrir? |
|---|---|---|---|
| 80 | TCP | Let's Encrypt (HTTP-01) + redirect a HTTPS | **Sí** |
| 443 | TCP | Viewer + señalización WHIP/WHEP + LL-HLS | **Sí** |
| **8189** | **UDP** | **Media WebRTC (OBS → VPS y VPS → viewers)** | **Sí, obligatorio** |
| 8189 | TCP | Respaldo ICE-TCP para redes que bloquean UDP | Recomendado |
| 443 | UDP | HTTP/3 (opcional, mejora un poco el HTTPS) | Opcional |
| 1935 | TCP | RTMP fallback (solo con `docker-compose.rtmp.yml`) | Solo si lo usás |
| 8888, 8889 | TCP | HLS / WHIP-WHEP de MediaMTX | **No.** No se publican; solo los ve Caddy por la red interna. |

### UDP 8189: el puerto que te va a hacer perder una tarde

Caddy hace proxy **solo de la señalización HTTP** (el intercambio de SDP de
WHIP/WHEP en 8889 y el HLS en 8888). El media de WebRTC **no pasa por Caddy**:
va directo entre OBS/el navegador y MediaMTX por **UDP 8189**. Todos los peers
comparten ese único puerto.

**Si UDP 8189 está cerrado, la señalización funciona igual** (el `POST /whep`
devuelve 201, todo parece bien en los logs de Caddy), pero ICE nunca conecta:
el player se queda cargando para siempre y **no hay ningún error obvio**. En
OBS el síntoma es que "Iniciar transmisión" arranca y a los segundos se corta.

Para que no pase desapercibido, el viewer detecta este caso: si a los 12 s ICE
no conectó, muestra *"La señalización respondió pero el media no llega (ICE no
conecta)… revisá que UDP 8189 esté abierto"*.

Además:

- El puerto tiene que ser **el mismo número afuera y adentro** del contenedor
  (`8189:8189/udp`): MediaMTX anuncia ese número en sus candidatos ICE.
- Dentro de Docker las interfaces tienen IPs privadas (172.x), que no le sirven
  a nadie de afuera. Por eso `webrtcIPsFromInterfaces: false` y la IP pública
  va en `webrtcAdditionalHosts` (variable `PUBLIC_HOST`). Si `PUBLIC_HOST`
  está mal, el síntoma es idéntico al de UDP 8189 cerrado.

### Cómo abrirlos

**Firewall del proveedor** (Hetzner Cloud Firewall, AWS Security Group, Oracle
Security List, DigitalOcean Cloud Firewall, etc.): agregá reglas de entrada
para `80/tcp`, `443/tcp`, `443/udp` y **`8189/udp`**. Esto es lo que más se
olvida, porque no se ve desde adentro del VPS.

**ufw** en el VPS:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 8189/udp
sudo ufw allow 8189/tcp
# sudo ufw allow 1935/tcp   # solo si usás el fallback RTMP
```

> Ojo: Docker escribe sus propias reglas de iptables para los puertos
> publicados y **se saltea ufw**. O sea, los puertos de `ports:` quedan
> accesibles aunque ufw diga otra cosa. Por eso 8888/8889 directamente no se
> publican. Las reglas de ufw igual conviene tenerlas por claridad (y si usás
> Docker con `"iptables": false`, ahí sí son necesarias).
>
> En Oracle Cloud la imagen trae reglas de iptables propias que bloquean todo
> menos 22: hay que abrir también ahí.

Verificar desde afuera (desde tu PC):

```sh
nc -vzu <IP_DEL_VPS> 8189     # UDP: "succeeded"/"open" no garantiza nada, pero "refused" = cerrado
```

La prueba real es: abrir el viewer con OBS transmitiendo y ver "EN VIVO".

---

## Transmitir desde el navegador (sin OBS)

Abrí **`https://watchando.blucaro.site/transmitir`** en Chrome, Edge o Firefox
de escritorio:

1. Completá **Sala** (ej. `peli`), **Usuario publisher** y **Contraseña
   publisher** (`PUBLISH_USER` / `PUBLISH_PASS` del `.env`). Con "Recordar"
   no los vuelve a pedir en esa compu.
2. Elegí **calidad** (de 720p30 a 4K60; el bitrate se completa solo con los
   valores de la tabla de OBS de abajo, y lo podés cambiar) y **contenido**:
   *Película/juego* prioriza fluidez, *Texto/código* prioriza nitidez.
3. Tocá **Elegir pantalla** (o directamente **Iniciar transmisión**) y elegí
   qué compartir en el selector del navegador.
4. **Iniciar transmisión.** El estado pasa a "en vivo" y abajo aparece el
   link para tus amigos con un botón de copiar.
5. **Detener transmisión** cuando terminás (o "Dejar de compartir" en la
   barra del navegador: también corta la transmisión).

Detalles:

- **Audio:** lo más prolijo es compartir una **pestaña** y marcar
  *"Compartir audio de la pestaña"* (Netflix en otra pestaña, YouTube, etc.).
  En Windows también podés compartir la pantalla entera con *"Compartir audio
  del sistema"*, pero ojo: **ahí también se transmite Discord** y tus amigos
  se escuchan con eco. Firefox no comparte audio. Se manda en Opus estéreo a
  160 kbps.
- **Nunca** pide micrófono ni cámara (la voz va por Discord). La captura de
  pantalla solo está permitida en `/transmitir`; en el viewer de tus amigos el
  navegador la tiene bloqueada por `Permissions-Policy`.
- **Cambiar en vivo:** "Cambiar pantalla" cambia la fuente sin cortar a
  nadie; calidad, bitrate y tipo de contenido también se aplican en vivo.
- **Codec:** H.264 (el mismo que con OBS). Si el navegador no codifica
  H.264, usa VP9, que también funciona por WebRTC y LL-HLS en navegadores
  actuales. Las stats del panel muestran el codec, bitrate, resolución y fps
  reales, y si la calidad está **limitada por CPU o por ancho de banda**.
- MediaMTX le pide un keyframe al navegador cada 2 s, así que los amigos que
  entran tarde ven imagen enseguida y LL-HLS funciona sin configurar nada.
- **Dejá la pestaña abierta** mientras transmitís (si la cerrás, te avisa).
  Si se corta la conexión, reintenta sola.
- **OBS sigue siendo mejor** si querés escenas, mezclar audios, capturar
  juegos en pantalla completa o 4K60 sostenido: el encoder de OBS (NVENC/x264)
  rinde más que el del navegador. Las dos formas publican igual (WHIP) y usan
  las mismas salas: tus amigos no notan la diferencia.

## Configuración de OBS

Requiere **OBS ≥ 30.0** (salida WHIP nativa).

### Ajustes → Emisión

| Campo | Valor |
|---|---|
| Servicio | `WHIP` |
| Servidor | `https://watchando.blucaro.site/<sala>/whip` (ej. `https://watchando.blucaro.site/peli/whip`) |
| Bearer Token | `PUBLISH_USER:PUBLISH_PASS` (ej. `publisher:3f9c…`, con los dos puntos) |

MediaMTX acepta `Authorization: Bearer usuario:contraseña`, que es exactamente
lo que manda OBS con el campo "Bearer Token".

### Ajustes → Salida (modo **Avanzado**) → Emisión

| Campo | Valor |
|---|---|
| Codificador de video | **NVENC H.264** (NVIDIA), **AMD HW H.264**, **QuickSync H.264** o **x264** (CPU). **H.264**, no HEVC/AV1. |
| Control de frecuencia | **CBR** |
| Tasa de bits | ver tabla abajo |
| Intervalo de fotogramas clave | **1 s** |
| Perfil | `high` |
| B-frames | **0** (WebRTC no los soporta bien; OBS los apaga en WHIP, pero verificalo) |
| Look-ahead / Psycho visual tuning (NVENC) | Off |
| x264: preset / tune | `veryfast` (o lo que aguante tu CPU) / `zerolatency`; opciones x264: `bframes=0` |

- **Audio:** WHIP usa **Opus** automáticamente. Bitrate de la pista 1:
  **160 kbps** (Ajustes → Salida → Audio). Frecuencia 48 kHz (Ajustes → Audio).
- **Keyframe a 1 s** porque: un viewer que entra (o se reconecta, o pierde un
  paquete grande) tiene que esperar al próximo keyframe para ver imagen, y
  LL-HLS necesita un keyframe por segmento (segmentos de 1 s). Con 2 s también
  funciona: un poco más de calidad por bit y un poco más de espera al entrar.
- **FPS constantes** (Ajustes → Video): LL-HLS en iPhone/Safari se queja si la
  duración de las partes varía.

### Bitrate recomendado (H.264, CBR)

| Resolución | 30 fps | 60 fps |
|---|---|---|
| 1080p | **6 Mbps** (6000 kbps) | **9 Mbps** (9000 kbps) |
| 4K (2160p) | **20 Mbps** (20000 kbps) | **35 Mbps** (35000 kbps) |

Para películas/series con poco movimiento, 1080p30 a 6 Mbps se ve muy bien.
Juegos o scroll de texto rápido piden 60 fps y la columna derecha.

**Cuentas de ancho de banda** (no hay transcodificación, cada viewer recibe el
bitrate completo):

- Subida de tu casa: el bitrate de OBS + ~20%.
- Salida del VPS: `bitrate × cantidad de viewers` (+ el doble si alguno usa
  LL-HLS y otro WebRTC, cuentan por separado). 5 amigos a 4K60 = ~175 Mbps
  sostenidos; revisá el límite de tráfico de tu plan.
- Bajada de cada amigo: el bitrate completo. **El que tenga la peor conexión
  manda**: no hay renditions más bajas. Si alguien no llega, que pruebe LL-HLS
  (TCP, aguanta mejor la pérdida de paquetes a costa de latencia). Si eso no
  alcanza, la solución sería transcodificar a una calidad menor en el VPS, y
  **eso no está implementado a propósito** (ver más abajo).
- 4K H.264 en WebRTC exige decodificación por hardware en el navegador del
  viewer; en máquinas viejas puede dropear frames (se ve en las stats, tecla `s`).

### Fallback RTMP (si WHIP te da problemas)

1. En `.env` descomentá `COMPOSE_FILE=docker-compose.yml:docker-compose.rtmp.yml`.
2. `docker compose up -d` y abrí `1935/tcp` en el firewall.
3. En OBS: Servicio `Personalizado…`, Servidor `rtmp://watchando.blucaro.site:1935/<sala>`,
   Clave de retransmisión `?user=<PUBLISH_USER>&pass=<PUBLISH_PASS>`
   (todo junto, empezando con `?`).
4. Audio: con RTMP OBS manda **AAC**, que WebRTC no soporta → por WHEP los
   viewers ven video **sin audio**; por LL-HLS sí hay audio. Otra razón para
   preferir WHIP.

RTMP viaja **sin cifrar**, contraseña incluida. Desactivalo cuando no lo uses.

---

## El viewer

- `https://watchando.blucaro.site/?r=<sala>` → pantalla de login → player.
  Al entrar con el botón "Entrar" el audio arranca activado (el click cuenta
  como gesto del usuario para la política de autoplay).
- Pantalla completa, fondo negro. Los controles (estado, mute, volumen,
  WebRTC/LL-HLS, stats, pantalla completa) aparecen al mover el mouse y se
  esconden a los 3 s (salvo que el mouse esté encima de la barra).
- Arranca **muteado** (si no, el navegador rechaza `play()` y parece roto) y
  muestra un botón grande **"Activar sonido"**. El volumen se recuerda.
- Estados: **esperando transmisión** (no hay publisher en esa sala),
  **conectando**, **en vivo**, **reconectando**. Reintenta solo con backoff
  exponencial (1 s → 2 s → 4 s…; tope 5 s mientras espera que arranques, 15 s
  ante errores).
- **WebRTC** (default, sub-segundo) o **LL-HLS** (≈1-3 s, más estable). La
  elección se guarda en `localStorage`.
- Atajos: `s` stats (bitrate, frames perdidos, paquetes perdidos, resolución,
  fps, RTT, jitter, latencia/buffer, leído de `getStats()` en WebRTC y de
  hls.js / `getVideoPlaybackQuality()` en LL-HLS), `f` pantalla completa,
  `m` mute. Doble click en el video = pantalla completa.
- Las credenciales van a MediaMTX en el header `Authorization`
  (`Bearer usuario:contraseña`), nunca en query strings. Caddy no guarda
  access logs y la página tiene `Referrer-Policy: no-referrer`.
- La página en sí (HTML/JS) es pública y no tiene nada secreto. Lo que está
  protegido es el stream: sin usuario y contraseña válidos MediaMTX contesta
  401 a WHEP y a LL-HLS.

### Compatibilidad

- WebRTC: Chrome, Edge, Firefox, Safari (desktop y iOS).
- LL-HLS: cualquier navegador con MSE (desktop; iOS ≥ 17.1 vía
  ManagedMediaSource). En navegadores sin MSE el viewer lo avisa y hay que usar
  WebRTC: el HLS nativo no permite mandar el header de autenticación.

---

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| Viewer: "La señalización respondió pero el media no llega" | **UDP 8189 cerrado** (firewall del proveedor o del VPS) o `PUBLIC_HOST` incorrecto. |
| OBS arranca a transmitir y se corta a los ~10 s | Mismo: UDP 8189 o `PUBLIC_HOST`. |
| OBS: "No se pudo conectar" al instante | URL mal (falta `/whip`) o Bearer Token mal (falta `usuario:`). En los logs de MediaMTX: `authentication failed`. |
| Viewer: "Usuario o contraseña incorrectos" | Contraseña mal copiada, o agregaste/cambiaste el amigo y no corriste `docker compose up -d`. |
| Viewer: "El link no es válido o fue revocado" | Link con `?t=` pero `VIEWER_TOKEN` vacío o distinto. |
| Viewer: "esperando transmisión" con OBS transmitiendo | La sala de la URL del viewer (`r=`) no es la misma que la de OBS. |
| Viewer: "HTTP 400: codecs not supported by client" | El navegador no tiene H.264 (pasa en builds de Chromium sin codecs propietarios). Usar Chrome/Edge/Firefox/Safari normales. |
| Caddy no saca el certificado | El DNS no apunta al VPS todavía, o 80/443 TCP cerrados. |
| Se cortó OBS de golpe (crash/red) y el viewer tarda ~30 s en pasar a "esperando transmisión" | Normal: MediaMTX espera el timeout de ICE. Si apretás "Detener transmisión", OBS avisa al server y el viewer se entera enseguida. |
| Imagen congelada / artefactos con bitrates altos | Pérdida de paquetes UDP. Bajá el bitrate o pasá a LL-HLS. Mirá "paquetes perdidos" en las stats. |

Logs útiles: `LOG_LEVEL=debug` en `.env` y `docker compose up -d`.

### Buffers UDP del kernel

Con bitrates altos, los buffers UDP por defecto de Linux (~208 KB) se llenan
en las ráfagas (keyframes) y el kernel descarta paquetes: artefactos o imagen
congelada aunque la red esté bien. En el VPS:

```sh
sudo tee /etc/sysctl.d/90-whacharjuntos-udp.conf <<'CONF'
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
CONF
sudo sysctl --system
docker compose up -d --force-recreate   # el contenedor toma los valores al crearse
```

---

## Decisiones de diseño (y lo que NO hace)

- **No transcodifica.** La imagen de MediaMTX es la standard (sin ffmpeg). El
  HLS es remux (cambio de contenedor), no recodificación. Si en algún momento
  hace falta (ej. un amigo con mala conexión necesita 720p), eso implica
  ffmpeg en el VPS y CPU/GPU para codificar: no está incluido a propósito.
- **Sin cuentas, base de datos, chat ni sincronización de playback.** Un solo
  publisher (vos) y un login de solo lectura por amigo, definido en un
  archivo de env.
- **Lectura no anónima:** no existe el usuario `any`. Los amigos (y el
  `viewer` del link opcional) solo tienen `read`; `publisher` solo tiene
  `publish`: la contraseña de OBS no sirve para mirar y la de un amigo no
  sirve para transmitir. Las contraseñas de `amigos.sh` son aleatorias de
  96 bits, así que adivinarlas por fuerza bruta no es viable. API, metrics, pprof, playback,
  RTSP, SRT y MoQ están apagados. Solo se aceptan nombres de sala
  `[A-Za-z0-9_-]{1,64}` y hasta 10 lectores por sala (`maxReaders`).
- **Proxies confiables:** Caddy y MediaMTX viven en una red con subred fija
  (`EDGE_SUBNET`, default `172.30.80.0/24`) que se declara en
  `webrtcTrustedProxies` / `hlsTrustedProxies`, así MediaMTX ve la IP real del
  cliente vía `X-Forwarded-For`.
- **CORS:** `webrtcAllowOrigins` / `hlsAllowOrigins` = `https://$DOMAIN`, no `*`.
- **Variables de entorno:** MediaMTX permite pisar cualquier clave del YAML
  con `MTX_<CLAVE>` (para listas: `MTX_AUTHINTERNALUSERS_0_PASS`). Así
  `mediamtx.yml` no tiene secretos ni datos de tu instalación; los
  placeholders de contraseña son hashes sin preimagen conocida.

### Actualizar versiones

Las imágenes están pineadas. Para subir MediaMTX, antes de cambiar el tag
compará `mediamtx.yml` contra el de referencia de la nueva versión
(`https://github.com/bluenviron/mediamtx/blob/vX.Y.Z/mediamtx.yml`): el
esquema de claves cambia entre versiones.
