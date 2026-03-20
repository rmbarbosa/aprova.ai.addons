# Aprova.ai Bridge Server

Servidor Flask que funciona como intermediário bidirecional entre a extensão Chrome e o Claude Code (Agent SDK + terminal), mantendo sessões persistentes com todo o contexto do projecto.

## Arquitectura

```
Chrome Extension                Bridge Server (Flask :9090)              Claude
   popup.js ──── HTTP POST ────►  /ask, /fill, /validate  ── SDK ──►  Agent SDK
   popup.js ◄─── SSE stream ───  /ask/stream               ◄────────  (sessão persistente)
   content.js ── HTTP POST ────►  /browser/state
                                     │
                                     └── write ──► tmp/.browser-state.json ◄── Read ── Claude Code Terminal
```

### Modelo Bidirecional

**Extensão → Claude (pedidos):**
Os pedidos da extensão (fill, ask, validate) são encaminhados ao Claude Agent SDK que mantém sessão persistente com o contexto do projecto carregado.

**Extensão → Claude Code Terminal (estado do browser):**
O content script empurra o estado da página (URL, campos, botões) via `POST /browser/state`. O bridge escreve `tmp/.browser-state.json` que qualquer sessão Claude Code no terminal pode ler.

**Claude → Extensão (streaming):**
O endpoint `/ask/stream` envia respostas via Server-Sent Events (SSE), permitindo que o texto apareça progressivamente no side panel. O SDK corre numa thread separada, eventos passam por uma `queue.Queue` para o generator Flask.

## Autenticação

> **O bridge server NÃO precisa de API key.** Usa o Claude Code SDK que invoca o CLI `claude` — a autenticação é a do próprio CLI. Basta ter feito `claude login` uma vez.

## Requisitos

- Python 3.10+
- Claude Code CLI instalado e autenticado (`claude login`)

## Instalação

```bash
pip install -r requirements.txt
```

Dependências: `flask`, `flask-cors`, `claude-code-sdk`, `waitress`, `pystray`, `pillow`

## Uso

```bash
# System tray (default — ícone junto ao relógio)
py -3 aprova_ai_bridge.py

# Terminal mode
py -3 aprova_ai_bridge.py --headless

# Terminal + verbose (log de todos os requests)
py -3 aprova_ai_bridge.py --headless -v

# Daemon (background, sem janela)
py -3 aprova_ai_bridge.py -d

# Force restart (mata instância anterior)
py -3 aprova_ai_bridge.py --headless -f

# Combinações
py -3 aprova_ai_bridge.py -d -f    # daemon + force restart
```

### System Tray

- Ícone com status dot: verde = activo, vermelho = parado
- Menu: Start Server / Stop Server / Status / Quit
- Auto-start ao lançar

## Endpoints

### Sessões

| Método | Endpoint | Função |
|--------|----------|--------|
| `GET` | `/status` | Health check + sessões activas + project dir |
| `GET` | `/session/list` | Lista sessões Claude Code vivas (verifica PIDs) |
| `POST` | `/session/start` | Cria sessão SDK para um projecto |
| `POST` | `/session/attach` | Cria sessão com contexto de sessão existente |
| `POST` | `/session/end` | Fecha sessão activa |

### Acções (requerem sessão activa)

| Método | Endpoint | Função |
|--------|----------|--------|
| `POST` | `/fill` | Scan da página → acções de preenchimento (JSON) |
| `POST` | `/fix` | Corrige campo específico com feedback |
| `POST` | `/ask` | Pergunta livre — resposta completa |
| `POST` | `/ask/stream` | Pergunta livre — SSE streaming progressivo |
| `POST` | `/validate` | Valida valores preenchidos |

### Browser State (bidirecional)

| Método | Endpoint | Função |
|--------|----------|--------|
| `POST` | `/browser/state` | Recebe push de estado da extensão, escreve ficheiro |
| `GET` | `/browser/state` | Devolve estado actual + `age_seconds` + `stale` |

### Formato SSE (`/ask/stream`)

```
data: {"type": "step", "text": "Read ./projects/enredo-astuto-2026/_projeto.md"}
data: {"type": "step", "text": "Grep CAE"}
data: {"type": "text", "text": "O CAE principal é..."}
data: {"type": "result", "text": "Resposta final completa aqui."}
data: [DONE]
```

Tipos de evento:
- `step` — thinking/tool use intermediário (mostrado como indicador)
- `text` — texto parcial da resposta (substitui o anterior, não acumula)
- `result` — resposta final
- `error` — erro durante processamento

### Formato `tmp/.browser-state.json`

```json
{
  "tabUrl": "https://balcao.portugal2030.pt/...",
  "tabTitle": "Formulário de Candidatura - Passo 3",
  "timestamp": 1742486400.5,
  "iso_timestamp": "2026-03-20T15:00:00+00:00",
  "age_seconds": 12.3,
  "pageScan": {
    "fields": [...],
    "buttons": [...],
    "pageContext": { "title", "url", "pageNumber", "headings" }
  }
}
```

## Exemplos curl

```bash
# Health check
curl http://localhost:9090/status

# Iniciar sessão
curl -X POST http://localhost:9090/session/start \
  -H "Content-Type: application/json" \
  -d '{"project": "enredo-astuto-2026"}'

# Pergunta com streaming
curl -N http://localhost:9090/ask/stream \
  -H "Content-Type: application/json" \
  -d '{"project": "enredo-astuto-2026", "question": "Qual o CAE principal?"}'

# Browser state actual
curl http://localhost:9090/browser/state
```

## Sessão Persistente vs `claude -p`

| | `claude -p` por pedido | Agent SDK sessão persistente |
|---|---|---|
| Cold start | ~5-10s por pedido | ~5-10s apenas no 1.º pedido |
| Contexto | Re-carregado a cada vez | Mantido em memória |
| Consistência | Sem memória entre pedidos | Lembra o que já preencheu |
| Latência (2.º+) | ~5-10s | ~1-3s |

## Segurança

- Escuta APENAS em `localhost:9090` (nunca exposto à rede)
- CORS restrito a `chrome-extension://` e `localhost`
- Sem credenciais próprias — usa a autenticação do Claude Code CLI
- Screenshots temporários apagados após análise
- Working directory fixo: `C:\trabalhos\aprova.ai`

## Autor

Rui Barbosa @rmblda 2026
