# Naistaxi Dashboard 🚕

Dashboard en tiempo real del canal **#ride-requests** de Slack.

## Despliegue en Vercel (gratis, 5 minutos)

### 1. Añade tu Slack Token

Abre `index.html` y busca la línea:
```js
const SLACK_TOKEN = 'REPLACE_WITH_YOUR_SLACK_BOT_TOKEN';
```
Reemplaza `REPLACE_WITH_YOUR_SLACK_BOT_TOKEN` con tu token `xoxb-...`

### 2. Sube a GitHub

1. Ve a https://github.com/new
2. Crea un repositorio (ej: `naistaxi-dashboard`)
3. Sube los archivos `index.html` y `vercel.json`

### 3. Despliega en Vercel

1. Ve a https://vercel.com
2. Click **"Add New Project"**
3. Importa tu repositorio de GitHub
4. Click **Deploy** — ¡listo!

Tu dashboard estará en una URL pública tipo:
`https://naistaxi-dashboard.vercel.app`

---

## Modificar el dashboard

Para añadir un nuevo canal:
```js
const CHANNEL_ID = 'C0APSN13G3T'; // cambia por el ID del nuevo canal
```

Para cambiar el intervalo de refresco:
```js
const POLL_MS = 30000; // 30 segundos. Cambia a 60000 para 1 minuto
```

---

## Permisos necesarios en Slack App

- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `users:read`
