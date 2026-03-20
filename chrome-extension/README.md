# Aprova.ai Chrome Extension

Extensão Chrome (Manifest V3, Side Panel) para preenchimento inteligente de formulários de candidatura a fundos europeus — powered by Claude via Bridge Server.

## Arquitectura

```
┌─ Chrome Extension ──────────────────────────────────────────────┐
│                                                                 │
│  popup.html / popup.js          background.js                   │
│  ┌──────────────────┐           ┌───────────────┐               │
│  │ Side Panel UI    │  chrome   │ Service Worker │               │
│  │ - Chat (stream)  ├─messages─►│ - Routing      │               │
│  │ - Attach menu    │◄──────────┤ - Screenshots  │               │
│  │ - Scan/Fill/     │           │ - Context menu │               │
│  │   Validate       │           │ - Bridge proxy │               │
│  └──────────────────┘           └───────┬───────┘               │
│                                         │                       │
│  content.js (injected in every page)    │                       │
│  ┌──────────────────────────────────────┤                       │
│  │ - DOM scanning (fields, buttons)     │                       │
│  │ - Action execution (fill, click)     │                       │
│  │ - Push browser state (auto)          │                       │
│  │ - Context menu: scan select options  │                       │
│  │ - Form structure description         │                       │
│  └──────────────────────────────────────┘                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         │ SSE stream (fetch)           │ HTTP (fetch)
         ▼                              ▼
   /ask/stream                    Bridge Server :9090
```

## Features

### Side Panel (Chat UI)

- **Scan** — detecta campos, botões, headings e contexto da página
- **Fill** — preenche automaticamente com dados do projecto via Claude
- **Validate** — valida valores preenchidos contra dados do projecto
- **Ask Boris** — chat livre com Claude, respostas em streaming progressivo
- **Modo Confirmar** — revê cada acção antes de executar (OK / Skip / Stop)
- **Copy code** — copia blocos `<pre>` preservando formatação e line breaks completos

### Menu Anexar (+)

| Item | Função |
|------|--------|
| **Screenshot da página** | Captura full-page via DevTools Protocol, envia como imagem ao Claude |
| **Título da página** | Insere `[título]` na posição do cursor no input |
| **Describe Form Structure** | Scan completo: percorre todos os campos, force-load de opções dinâmicas em selects, gera texto descritivo. Anexa como thumbnail doc removível |

### Menu de Contexto (botão direito)

| Item | Função |
|------|--------|
| **Scan Opções** | Extrai opções do `<select>` sob o cursor. Se dentro de tabela, inclui header da coluna no formato `Header: id combo:\nopções`. Insere no input na posição do cursor |

### Push Automático de Estado

O content script envia automaticamente o estado da página ao bridge:
- **Page load** — scan inicial
- **Navegação SPA** — popstate, hashchange
- **Alterações DOM** — MutationObserver debounced 2s
- **Heartbeat** — cada 30s

O bridge escreve `tmp/.browser-state.json` para Claude Code terminal poder ler.

## Instalação

### Pré-requisitos

1. Bridge Server a correr em `localhost:9090` (ver `bridge-server/README.md`)

### Carregar extensão

1. Abrir `chrome://extensions/`
2. Activar **Developer mode** (canto superior direito)
3. Clicar **Load unpacked**
4. Seleccionar a pasta `chrome-extension/`
5. A extensão aparece na toolbar com o ícone "A"
6. Clicar no ícone abre o Side Panel

### Após actualizar código

1. `chrome://extensions/` → clicar refresh na extensão
2. Recarregar a página do portal (F5)

## Ficheiros

| Ficheiro | Função |
|----------|--------|
| `manifest.json` | Manifest V3 — permissões: activeTab, storage, sidePanel, debugger, contextMenus |
| `popup.html` | Side Panel UI (chat dark theme, CSS variables) |
| `popup.js` | Controlador: sessões, streaming SSE, attachments, markdown renderer |
| `content.js` | Scan DOM, execução de acções, push state, form structure description |
| `background.js` | Service worker: routing messages, context menu, full-page screenshots |
| `styles.css` | Estilos dos overlays de confirmação no content script |
| `icons/` | Ícones da extensão (16, 48, 128px) |

## Permissões

| Permissão | Porquê |
|-----------|--------|
| `activeTab` | Aceder ao conteúdo da tab activa para scan e fill |
| `storage` | Guardar preferências (projecto, modo confirmar) |
| `sidePanel` | Abrir o side panel ao clicar no ícone |
| `debugger` | Capturar screenshots full-page via Chrome DevTools Protocol |
| `contextMenus` | Menu "Scan Opções" ao clicar direito |

## Workflow Típico

1. Iniciar bridge: `py -3 aprova_ai_bridge.py --headless -v`
2. Abrir portal de candidatura (ex: Balcão 2030)
3. Clicar no ícone da extensão → Side Panel abre
4. Escolher projecto → **Iniciar Sessão** (~5-10s, uma vez)
5. **Scan** — ver campos detectados
6. **Fill** — Claude analisa e preenche (~1-3s), resposta aparece progressivamente
7. Campo com dúvida → perguntar no chat
8. Botão direito num `<select>` → **Scan Opções** → opções no input
9. **+** → **Describe Form Structure** → scan completo com opções dinâmicas
10. **+** → **Screenshot** → Claude analisa visualmente a página
11. Próxima página → repetir (contexto da sessão mantido)
12. **Desligar Sessão** quando terminar

## Configuração

### Projectos

A lista de projectos no dropdown é estática em `popup.html`. Editar os `<select>` para adicionar/remover projectos.

### Modo Confirmar vs Auto

- **Confirmar** (default): cada acção aparece com preview — OK / Skip / Stop
- **Auto**: executa tudo sem confirmação, reporta resultado

Toggle nas Settings (ícone no header).

## Autor

Rui Barbosa @rmblda 2026
