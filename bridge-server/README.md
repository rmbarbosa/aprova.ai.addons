# Aprova.ai Bridge Server

Servidor Flask que liga a extensão Chrome ao Claude Code via Agent SDK, mantendo sessões persistentes com todo o contexto do projecto.

## Arquitectura

```
Chrome Extension  ──HTTP──>  Bridge Server (Flask :9090)  ──SDK──>  Claude Agent SDK
                                    │
                                    └── Sessão persistente (contexto carregado 1x)
```

## Requisitos

- Python 3.10+
- Conta Anthropic com API key configurada (`ANTHROPIC_API_KEY`)

## Instalação

```bash
pip install flask flask-cors claude-code-sdk pystray pillow
```

## Uso

### Com system tray (default — ícone junto ao relógio)

```bash
py -3 aprova-ai-bridge.py
```

- Ícone verde = servidor activo, vermelho = desligado
- Clique direito: Start / Stop / Status / Quit
- Sem janela de terminal visível

### Modo terminal (headless)

```bash
py -3 aprova-ai-bridge.py --headless
```

## Endpoints

| Método | Endpoint | Função |
|--------|----------|--------|
| `GET` | `/status` | Health check + sessões activas |
| `GET` | `/session/list` | Lista sessões Claude Code recentes |
| `POST` | `/session/start` | Cria sessão nova para um projecto |
| `POST` | `/session/attach` | Liga-se a sessão Claude existente (por `sessionId`) |
| `POST` | `/session/end` | Fecha/desliga sessão activa |
| `POST` | `/fill` | Envia campos da página, devolve acções de preenchimento |
| `POST` | `/fix` | Corrige um campo específico |
| `POST` | `/ask` | Pergunta livre ao Claude ("Ask Boris") |
| `POST` | `/validate` | Valida valores preenchidos |

## Exemplos curl

```bash
# Health check
curl http://localhost:9090/status

# Iniciar sessão
curl -X POST http://localhost:9090/session/start \
  -H "Content-Type: application/json" \
  -d '{"project": "enredo-astuto-2026"}'

# Preencher campos
curl -X POST http://localhost:9090/fill \
  -H "Content-Type: application/json" \
  -d '{"project": "enredo-astuto-2026", "pageScan": {"fields": [{"id": "nipc", "label": "NIPC", "type": "text"}], "pageContext": {"title": "Dados do Beneficiário"}}}'

# Perguntar ao Boris
curl -X POST http://localhost:9090/ask \
  -H "Content-Type: application/json" \
  -d '{"project": "enredo-astuto-2026", "question": "Qual o CAE principal?"}'
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
- CORS restrito a `chrome-extension://[ID]`
- Sem credenciais próprias — usa `ANTHROPIC_API_KEY` da env
- Working directory fixo: `C:\trabalhos\aprova.ai`

## Autor

Rui Barbosa @rmblda 2026
