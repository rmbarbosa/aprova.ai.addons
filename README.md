# Aprova.ai Addons

Sistema bidirecional que liga o Claude Code (terminal) ao browser (Chrome Extension) para preenchimento inteligente de formulários de candidatura a fundos europeus.

## Arquitectura

```
                        Aprova.ai Addons
   ┌─────────────────────────────────────────────────────────┐
   │                                                         │
   │  Chrome Extension              Bridge Server            │   Claude Code Terminal
   │  (Side Panel UI)               (Flask :9090)            │   (CLI / Agent SDK)
   │                                                         │
   │  ┌──────────┐   HTTP POST    ┌──────────────┐          │   ┌──────────────┐
   │  │content.js├───────────────►│POST /ask      │          │   │              │
   │  │          │  push state    │POST /fill     │  SDK     │   │  Claude Code │
   │  │popup.js  ├───────────────►│POST /validate ├─────────►│   │  Terminal    │
   │  │          │◄──── SSE ──────┤GET /ask/stream│◄─────────┤   │              │
   │  │background│                │               │          │   │              │
   │  │   .js    │                │POST /browser/ │          │   │   Read tool  │
   │  └────┬─────┘                │     state     │          │   │      │       │
   │       │                      └───────┬───────┘          │   └──────┼───────┘
   │       │  push-page-state             │                  │          │
   │       │  (on navigate/               │ write            │          │ read
   │        change/heartbeat)             ▼                  │          ▼
   │                              tmp/.browser-state.json  ◄─┼──────────┘
   │                                                         │
   └─────────────────────────────────────────────────────────┘
```

### Modelo Bidirecional

O sistema funciona em dois sentidos:

**Browser → Claude Code (via Bridge)**
- A extensão envia o scan da página (campos, valores, botões, opções de selecção) ao bridge
- O bridge encaminha ao Claude Agent SDK que responde com acções de preenchimento
- As respostas são streamed progressivamente via SSE (`/ask/stream`)

**Browser → Claude Code Terminal (via ficheiro)**
- O content script empurra automaticamente o estado da página para `POST /browser/state`
- O bridge escreve `tmp/.browser-state.json` com URL, título, campos e botões
- Qualquer sessão Claude Code no terminal pode ler este ficheiro para saber o que o utilizador tem aberto
- Actualizado em: page load, navegação SPA, alterações DOM (debounced 2s), heartbeat 30s

## Componentes

```
aprova.ai.addons/
├── bridge-server/           # Servidor Flask — intermediário entre extensão e Claude
│   ├── aprova_ai_bridge.py  # Servidor principal (rotas, SDK, SSE streaming, tray icon)
│   ├── requirements.txt     # Dependências Python
│   └── __main__.py          # Entry point (python -m bridge-server)
├── chrome-extension/        # Extensão Chrome Manifest V3
│   ├── manifest.json        # Permissões, content scripts, side panel
│   ├── popup.html           # UI do side panel (chat dark theme)
│   ├── popup.js             # Controlador (sessões, streaming, attachments)
│   ├── content.js           # Scan DOM, execução de acções, push state
│   ├── background.js        # Service worker (routing, context menu, screenshots)
│   ├── styles.css           # Estilos dos overlays no content script
│   └── icons/               # Ícones (16, 48, 128px)
└── README.md                # Este ficheiro
```

## Features

### Extensão Chrome (Side Panel)

| Feature | Descrição |
|---------|-----------|
| **Scan** | Detecta campos, botões, headings e contexto da página |
| **Fill** | Preenche automaticamente com dados do projecto via Claude |
| **Validate** | Valida valores preenchidos contra dados do projecto |
| **Ask Boris** | Chat livre com Claude, com contexto da página |
| **Streaming** | Respostas aparecem progressivamente (SSE) |
| **Screenshot** | Captura full-page via DevTools Protocol, envia ao Claude |
| **Describe Form Structure** | Scan completo do formulário com force-load de opções dinâmicas de selects |
| **Scan Opções** | Menu de contexto (botão direito) — extrai opções de selects com detecção de headers de tabela |
| **Título da página** | Insere o título da tab activa no input |
| **Modo Confirmar** | Revê cada acção antes de executar (OK / Skip / Stop) |
| **Copy code** | Copia código dos blocos `<pre>` preservando formatação completa |

### Bridge Server

| Feature | Descrição |
|---------|-----------|
| **Sessões persistentes** | Contexto do projecto carregado 1x, mantido em memória |
| **SSE Streaming** | `/ask/stream` envia respostas token a token |
| **Browser State** | Recebe e escreve estado da página para Claude Code terminal |
| **System Tray** | Ícone com status (verde/vermelho), menu Start/Stop/Quit |
| **Headless / Daemon** | Modos sem UI para servidores e automação |
| **Screenshots** | Guarda screenshots temporários para o Claude analisar |

### Claude Code Terminal

| Feature | Descrição |
|---------|-----------|
| **Browser State** | Lê `tmp/.browser-state.json` para saber o que está aberto no Chrome |
| **Stale detection** | Campo `age_seconds` indica frescura do estado (>60s = possivelmente desactualizado) |

## Setup

### 1. Bridge Server

```bash
cd bridge-server

# Instalar dependências
pip install -r requirements.txt

# Iniciar (escolher um modo)
py -3 aprova_ai_bridge.py              # com system tray icon
py -3 aprova_ai_bridge.py --headless   # terminal mode
py -3 aprova_ai_bridge.py --headless -v # terminal + verbose logging
py -3 aprova_ai_bridge.py -d           # daemon (background)
py -3 aprova_ai_bridge.py -f           # force restart (mata instância anterior)
```

**Requisitos:** Python 3.10+, Claude Code CLI instalado e autenticado (`claude login`)

### 2. Chrome Extension

1. Abrir `chrome://extensions/`
2. Activar **Developer mode** (canto superior direito)
3. Clicar **Load unpacked** → seleccionar pasta `chrome-extension/`
4. A extensão aparece na toolbar com o ícone "A"
5. Clicar no ícone abre o Side Panel

### 3. Claude Code Terminal (opcional)

Para que o Claude Code no terminal saiba o que está no browser:

1. Garantir que o bridge está a correr
2. Abrir uma página com a extensão carregada
3. No terminal Claude Code (com cwd em `C:\trabalhos\aprova.ai`):

```
> Lê tmp/.browser-state.json — que página está o utilizador a ver?
```

O ficheiro `CLAUDE.md` no root do projecto aprova.ai documenta esta convenção.

## Workflow Típico

1. Iniciar bridge: `py -3 aprova_ai_bridge.py --headless -v`
2. Abrir portal de candidatura (ex: Balcão 2030)
3. Clicar no ícone da extensão → Side Panel abre
4. Escolher projecto → **Iniciar Sessão** (~5-10s, uma vez)
5. **Scan** — ver campos detectados
6. **Fill** — Claude analisa e preenche (~1-3s)
7. Campos com dúvida → perguntar no chat
8. Botão direito num `<select>` → **Scan Opções** → opções inseridas no input
9. **+** → **Describe Form Structure** → scan completo com opções dinâmicas
10. Próxima página → repetir (contexto da sessão mantido)

## API Endpoints

| Método | Endpoint | Função |
|--------|----------|--------|
| `GET` | `/status` | Health check + sessões activas |
| `GET` | `/session/list` | Lista sessões Claude Code vivas |
| `POST` | `/session/start` | Cria sessão nova para um projecto |
| `POST` | `/session/attach` | Cria sessão com contexto de sessão existente |
| `POST` | `/session/end` | Fecha sessão activa |
| `POST` | `/fill` | Scan → acções de preenchimento |
| `POST` | `/fix` | Corrige campo específico |
| `POST` | `/ask` | Pergunta livre (resposta completa) |
| `POST` | `/ask/stream` | Pergunta livre (SSE streaming) |
| `POST` | `/validate` | Valida valores preenchidos |
| `GET` | `/browser/state` | Estado actual do browser (com `age_seconds`, `stale`) |
| `POST` | `/browser/state` | Recebe push de estado da extensão |

## Segurança

- Bridge escuta **apenas** em `localhost:9090` (nunca exposto à rede)
- CORS restrito a `chrome-extension://` e `localhost`
- Sem credenciais próprias — usa a autenticação do Claude Code CLI
- Screenshots temporários apagados após análise
- Working directory fixo: `C:\trabalhos\aprova.ai`

## Autor

Rui Barbosa @rmblda 2026
