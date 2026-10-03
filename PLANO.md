# Subathon Timer (Twitch) — Plano do Projeto

## Contexto
Projeto open source para streamers rodarem **localmente** um timer de subathon: cada evento (bits, subs e, numa fase futura, Pix via PixGG) soma minutos ao timer. São três partes no mesmo repositório:

- **Bot/backend**: capta os eventos e grava tudo em JSON local.
- **Painel de controle**: configura as regras, pausa, finaliza e mostra o histórico.
- **Overlay**: entra no OBS como browser source.

O público-alvo não é técnico, então o README deve ser em PT-BR e com passo a passo detalhado.

---

## Decisões confirmadas

### Escopo
- **Pix/PixGG fica fora do escopo agora** (fase 2). Notas para quando chegar a hora:
  - A API oficial do PixGG (Applications) só envia webhook (`donation.created` / `donation.paid`, assinado com HMAC-SHA256 no header `x-pixgg-signature-256`) para uma **URL pública**. Rodando local, isso exige um túnel (cloudflared/ngrok).
  - A alternativa 100% local é o canal Pusher do widget de alertas (a chave do widget é o nome do canal). Não é oficial e pode quebrar sem aviso.
  - Referências: [OBSSocial PR #41](https://github.com/WardzdesouzA/OBSSocial/pull/41), [OBSSocial PR #39](https://github.com/WardzdesouzA/OBSSocial/pull/39).

### Stack e distribuição
- Node.js com **JavaScript puro**. Painel e overlay em HTML/CSS/JS **sem etapa de build**.
- Instalação: o streamer instala o Node (≥ 22) e roda `npm install` + `npm start`.
- **Um único processo** e três pastas: `src/` (bot), `public/panel/`, `public/overlay/`. Tudo fica em `http://localhost:PORTA`.

### Twitch
- **Cada streamer cria o próprio app** em dev.twitch.tv (tipo *Public*) e cola o Client ID no painel. Nenhuma credencial é compartilhada pelo projeto.

### Regras de tempo
| Evento | Regra |
|---|---|
| Bits | Proporcional: a cada N bits, X minutos. Ex.: 250 bits com N=100 → 2,5 × X. |
| Sub T1 / T2 / T3 | Valor de minutos próprio para cada tier. |
| Prime | Igual ao T1. |
| Resub | Conta, pelo valor do tier. |
| Sub gift | Conta como N × minutos do tier do gift, creditado a **quem presenteou**. Os subs recebidos de presente não contam de novo. |

### Timer
- Tempo inicial configurável.
- Ajuste manual de ± minutos pelo painel.
- Pausar e despausar.
- **Se o bot cair, o timer congela**: ele não conta tempo com o bot desligado.
- Ao chegar em 00:00, **para e mostra "Fim"**. Doações recebidas depois disso **não reabrem** o timer.
- **Finalizar** arquiva o subathon em `data/archive/<data>.json` e permite começar um novo.

### Overlay
- **Uma URL única** (`/overlay`), com:
  - o timer;
  - alertas com animação CSS (doação recebida, tempo adicionado, timer pausado, fim);
  - o **último doador de cada frente** (bits, sub, gift).
- Visual personalizável pelo painel (cores e fonte).

### Painel
- Login na Twitch e status da conexão.
- Configuração das regras e do tempo inicial.
- Controles: iniciar, pausar/continuar, ajustar ± minutos, finalizar.
- Histórico de doações.
- Exportar o histórico em CSV.
- **Simular evento**, para testar o overlay sem doação real.
- Personalizar o overlay.
- Link do overlay com botão de copiar.

---

## Arquitetura

### Princípio: zero ou quase zero dependências
- **Node ≥ 22**:
  - `fetch` e o cliente `WebSocket` nativos dão conta da Twitch;
  - `node:http` serve os arquivos estáticos e a API;
  - nenhum framework.
- **Atualizações em tempo real via SSE** (`EventSource` nativo no navegador) para o painel e o overlay. As ações do painel vão por `fetch POST`, então não é preciso a lib `ws`.
- **Testes com `node:test`**, sem framework.

### Autenticação na Twitch: Device Code Flow
1. O streamer cola o Client ID no painel e clica em "Conectar".
2. O bot pede um device code e o painel mostra o código e o link `twitch.tv/activate`.
3. O bot consulta a Twitch até o streamer autorizar e então guarda o `access_token` e o `refresh_token` em `data/config.json`.
4. O token é renovado automaticamente quando expira (refresh token).

- Escopos: `bits:read`, `channel:read:subscriptions`.
- Não precisa de redirect URL.

### EventSub via WebSocket
Conexão: `wss://eventsub.wss.twitch.tv/ws`. Não precisa de URL pública.

| Assinatura | Uso |
|---|---|
| `channel.cheer` | Bits (`bits`, `user_name`, `is_anonymous`) |
| `channel.subscribe` | Sub nova. **Ignorar quando `is_gift=true`**, para não contar o gift duas vezes. |
| `channel.subscription.message` | Resub (`tier`, `user_name`) |
| `channel.subscription.gift` | Gifts (`total`, `tier`, `user_name`, `is_anonymous`) |

- Tratar `session_welcome`: com o `session_id`, criar as assinaturas via Helix `POST /eventsub/subscriptions`.
- Tratar `session_keepalive`: sem keepalive dentro do prazo, reconectar.
- Tratar `session_reconnect`: conectar na nova URL antes de fechar a antiga.
- Deduplicar eventos por `message_id`.
- Prime chega como tier `1000`, então já vale como T1 sem tratamento especial.

### Estrutura de arquivos
```
package.json              # "start": "node src/server.js", "test": "node --test"
src/server.js             # http: estáticos, API REST do painel, SSE, CSV
src/twitch.js             # device flow, refresh, EventSub WS → evento normalizado
src/subathon.js           # estado do timer, regras (minutesFor puro), persistência JSON
src/subathon.test.js      # testes das regras e do fim do timer
public/panel/index.html
public/panel/panel.js
public/panel/panel.css
public/overlay/index.html
public/overlay/overlay.js
public/overlay/overlay.css   # animações
data/                     # no .gitignore
  config.json
  state.json
  events.json
  archive/
README.md                 # PT-BR
.gitignore
LICENSE                   # (definir: MIT?)
```

### Modelo de dados

**`data/config.json`**
```json
{
  "port": 3000,
  "twitch": { "clientId": "", "accessToken": "", "refreshToken": "", "userId": "", "login": "" },
  "rules": {
    "bits": { "per": 100, "minutes": 1 },
    "sub": { "t1": 5, "t2": 10, "t3": 25 }
  },
  "initialMinutes": 240,
  "overlay": { "primaryColor": "#9146FF", "textColor": "#FFFFFF", "font": "Inter" }
}
```

**`data/state.json`**: gravado a cada tick de 1 segundo.
```json
{
  "remainingMs": 14400000,
  "status": "idle | running | paused | ended",
  "startedAt": "2026-10-03T18:00:00Z",
  "lastByType": {
    "bits": { "user": "fulano", "amount": 250 },
    "sub":  { "user": "ciclano", "tier": "1000" },
    "gift": { "user": "beltrano", "amount": 5, "tier": "2000" }
  }
}
```
Como o arquivo guarda o tempo restante, e não a hora de término, o timer congela sozinho se o processo cair.

**`data/events.json`**: lista do histórico.
```json
[{ "id": "...", "type": "bits|sub|resub|gift", "user": "fulano", "amount": 250, "tier": null, "minutesAdded": 2.5, "at": "...", "simulated": false }]
```

### API local
| Método | Rota | Função |
|---|---|---|
| GET | `/` → `/panel/` | Painel |
| GET | `/overlay/` | Overlay |
| GET | `/api/stream` | SSE: `state`, `event` e `config` (overlay) |
| GET | `/api/state` | Estado atual |
| GET/POST | `/api/config` | Ler e salvar regras, tempo inicial e estilo |
| POST | `/api/timer/start` | Iniciar |
| POST | `/api/timer/pause` | Pausar |
| POST | `/api/timer/resume` | Continuar |
| POST | `/api/timer/adjust` | `{ minutes: ±N }` |
| POST | `/api/timer/finish` | Arquivar e zerar |
| POST | `/api/simulate` | `{ type, user, amount, tier }` |
| GET | `/api/events` | Histórico |
| GET | `/api/events.csv` | Exportar CSV |
| POST | `/api/twitch/connect` | Iniciar o device flow |
| POST | `/api/twitch/disconnect` | Esquecer os tokens |

O servidor escuta **só em `127.0.0.1`**, o que dispensa senha.

### Fluxo de um evento
```
Twitch EventSub / Simular
   → twitch.js normaliza { type, user, amount, tier }
   → subathon.apply(event)
       → status === "ended"? ignora (registra no histórico com 0 min)
       → minutesFor(event, rules) → soma em remainingMs
       → atualiza lastByType, grava state.json e events.json
   → broadcast SSE { event, state }
   → overlay: animação de alerta + "+X min"; painel: atualiza o histórico
```

### Tick do timer
- Um `setInterval` de 1 segundo, ativo só com `status === "running"`, desconta o tempo **real decorrido** (diferença de `Date.now()`), não 1000 ms fixos, para não acumular atraso.
- Ao chegar em `remainingMs <= 0`: zera, muda para `status = "ended"` e envia o broadcast.

---

## Padrões adotados (ajustáveis)
- Ao reiniciar o bot com o timer rodando, ele volta **pausado** e o streamer clica em "Continuar".
- Interface e README **só em PT-BR**.
- Bits e gifts anônimos aparecem como **"Anônimo"**.
- Licença: **a definir** (sugestão: MIT).

---

## Fases de implementação
1. **Núcleo**: `subathon.js` (regras, timer, persistência) e os testes.
2. **Servidor**: `server.js` (estáticos, API, SSE, CSV) e o simulador.
3. **Overlay**: timer, últimos doadores, alertas e animações, estilo vindo da config.
4. **Painel**: controles, regras, histórico, simular, personalizar, link do overlay.
5. **Twitch**: device flow, EventSub, reconexão, deduplicação.
6. **README** em PT-BR.
7. *(Fase 2)* **Pix via PixGG**, depois de escolher entre o webhook oficial com túnel e o canal do widget.

---

## README (PT-BR) — roteiro
1. O que é e o que faz (com GIF do overlay).
2. Requisitos: Node 22 ou mais novo (links de download para Windows, Mac e Linux).
3. Instalação: baixar o ZIP ou fazer `git clone`, depois `npm install` e `npm start`.
4. Criar o app na Twitch, passo a passo com prints (tipo *Public*, copiar o Client ID).
5. Conectar no painel (código em `twitch.tv/activate`).
6. Configurar as regras e o tempo inicial.
7. Adicionar o overlay no OBS (browser source, URL, tamanho recomendado, fundo transparente).
8. Testar com o botão "Simular".
9. Durante a live: pausar, ajustar, finalizar e arquivar.
10. Exportar o histórico em CSV.
11. FAQ e solução de problemas: porta em uso, token expirado, overlay em branco, eventos que não chegam.

---

## Verificação
1. `npm test`: regras (bits proporcionais, tiers, Prime, gift sem contagem dupla) e fim do timer (evento depois de `ended` não soma).
2. `npm start` e abrir o painel. Simular bits 250, gift 5×T2 e resub, e conferir minutos, histórico, CSV e animações no overlay.
3. Pausar, matar o processo e reiniciar: o tempo deve estar preservado e o timer pausado.
4. Usar a Twitch CLI (`twitch event websocket start-server` + `twitch event trigger channel.cheer --transport=websocket`) para validar o EventSub sem live real. Depois, testar com uma conta real.
5. Deixar o timer zerar: o overlay mostra "Fim" e um evento posterior não soma tempo.
