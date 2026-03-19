# Aprova.ai Extension

Extensão Chrome para preenchimento inteligente de formulários de candidatura nos portais Balcão 2030 / Fundos UE — powered by Claude via Bridge Server.

## Funcionalidades

- **Scan** — detecta todos os campos, botões e contexto da página actual
- **Fill** — preenche automaticamente com dados do projecto (via Claude)
- **Fix** — corrige um campo específico com feedback do utilizador
- **Validate** — valida valores preenchidos contra dados do projecto
- **Ask Boris** — pergunta livre ao Claude com contexto completo
- **Modo Confirmar** — revê cada acção antes de executar (default)
- **Modo Auto** — executa tudo e reporta resultado

## Portais Suportados

- `balcao.portugal2030.pt`
- `balcao2030.gov.pt`
- `balcao.fundoseuropeus.pt`
- `*.iapmei.pt`
- `*.compete2020.gov.pt`

Para adicionar portais, editar `matches` em `manifest.json`.

## Instalação

### Pré-requisitos

1. Bridge Server a correr em `localhost:9090` (ver `bridge-server/README.md`)

### Carregar extensão

1. Abrir `chrome://extensions/`
2. Activar **Developer mode** (canto superior direito)
3. Clicar **Load unpacked**
4. Seleccionar a pasta `chrome-extension/`
5. A extensão aparece na toolbar com o ícone verde "A"

## Workflow

1. Abrir portal de candidatura (Balcão 2030)
2. Clicar no ícone da extensão na toolbar
3. Escolher projecto (ex: `enredo-astuto-2026`)
4. **Connect** — cria sessão Claude (~5-10s, uma vez)
5. **Scan** — vê campos detectados na página
6. **Fill** — Claude analisa e preenche campos (~1-3s)
7. Campos preenchidos ficam com contorno verde
8. Campo errado? → escrever feedback no chat → Boris corrige
9. Dúvida? → "Ask Boris: o CAE está certo?"
10. Próxima página → **Fill** novamente (contexto mantido)
11. **Disconnect** quando terminar

## Ficheiros

| Ficheiro | Função |
|----------|--------|
| `manifest.json` | Manifest V3, permissões e content scripts |
| `popup.html` | UI principal (chat-style, dark theme) |
| `popup.js` | Lógica do popup (sessão, acções, chat) |
| `content.js` | Scan DOM, execução de acções, overlays |
| `background.js` | Service worker — routing entre popup, content e bridge |
| `styles.css` | Estilos dos overlays no content script |
| `icons/` | Ícones da extensão (16, 48, 128px) |

## Configuração

### Projectos

A lista de projectos no dropdown é estática em `popup.html`. Editar o `<select id="projectSelect">` para adicionar/remover projectos.

### Modo Confirmar vs Auto

- **Confirmar** (default): cada acção aparece com preview — OK / Skip / Stop
- **Auto**: executa tudo sem confirmação, reporta resultado

Toggle nas Settings (ícone engrenagem no header).

### Sessão Existente

Nas Settings, o dropdown "Sessão existente" lista sessões Claude Code recentes. Ao conectar com uma sessão existente, herda todo o contexto acumulado (conversas, ficheiros lidos, decisões).

## Desenvolvimento

Para recarregar após alterações:
1. `chrome://extensions/`
2. Clicar no botão de refresh na extensão
3. Recarregar a página do portal

## Autor

Rui Barbosa @rmblda 2026
