# ⏱️ Subathon Timer

Timer de **subathon** para a Twitch que roda **no seu computador**. Cada bits, sub e Pix (via PixGG) que você recebe adiciona tempo ao contador automaticamente, e o contador aparece na live como um overlay no OBS.

- 💎 **Bits**: a cada N bits, X minutos (proporcional: meio caminho vale meio tempo).
- ⭐ **Subs**: minutos diferentes para Tier 1 (e Prime), Tier 2 e Tier 3. Resubs também contam.
- 🎁 **Gifts**: cada sub presenteado vale os minutos do tier, creditados para quem presenteou.
- 💸 **Pix (PixGG)**: a cada R$ N, X minutos (proporcional).
- 🎛️ **Painel de controle**: iniciar, pausar, ajustar o tempo na mão, finalizar e ver o histórico.
- 🎨 **Overlay animado**: alertas de doação, "+tempo" subindo do relógio, aviso de pausa e de fim, e o último apoiador de cada tipo.
- 🧪 **Simulador**: teste tudo sem precisar de doação de verdade.
- 🔒 **Tudo local**: nada de servidor na nuvem. O programa só conversa com a Twitch e com o PixGG, e seus dados ficam na pasta `data/`.

---

## Sumário

1. [O que você precisa](#1-o-que-você-precisa)
2. [Instalação](#2-instalação)
3. [Abrindo o programa](#3-abrindo-o-programa)
4. [Criando o app na Twitch (só uma vez)](#4-criando-o-app-na-twitch-só-uma-vez)
5. [Conectando a sua conta](#5-conectando-a-sua-conta)
6. [Conectando o PixGG (Pix)](#6-conectando-o-pixgg-pix)
7. [Configurando o tempo](#7-configurando-o-tempo)
8. [Colocando o overlay no OBS](#8-colocando-o-overlay-no-obs)
9. [Testando com o simulador](#9-testando-com-o-simulador)
10. [Durante a live](#10-durante-a-live)
11. [Exportando o histórico](#11-exportando-o-histórico)
12. [Perguntas frequentes](#12-perguntas-frequentes)
13. [Solução de problemas](#13-solução-de-problemas)
14. [Atualizando o programa](#14-atualizando-o-programa)
15. [Para desenvolvedores](#15-para-desenvolvedores)

---

## 1. O que você precisa

- Um computador com **Windows, macOS ou Linux** (o mesmo onde roda o OBS é o ideal).
- O **Node.js versão 22 ou mais nova**. É o programa que faz o timer funcionar.
- Uma conta na Twitch com **autenticação em duas etapas (2FA) ativada**. A Twitch exige isso para criar o app do passo 4.

### Instalando o Node.js

1. Entre em **https://nodejs.org**.
2. Baixe a versão marcada como **LTS** (qualquer uma a partir da 22 serve).
3. Instale clicando em "Próximo" até o fim, sem mudar nada.

Para conferir se deu certo, abra o **Prompt de Comando** (Windows: tecla Windows, digite `cmd` e Enter) ou o **Terminal** (Mac/Linux) e digite:

```
node --version
```

Se aparecer algo como `v22.11.0` (ou maior), está pronto.

---

## 2. Instalação

**Opção A: baixar o ZIP (mais fácil)**

1. Nesta página do GitHub, clique no botão verde **Code** e depois em **Download ZIP**.
2. Extraia o ZIP numa pasta fácil de achar, por exemplo `Documentos\subathon-timer`.

**Opção B: com Git** (se você já usa)

```
git clone <endereço deste repositório>
```

O projeto **não tem dependências para baixar**: não precisa rodar `npm install`.

---

## 3. Abrindo o programa

1. Abra o Prompt de Comando ou o Terminal **dentro da pasta do projeto**.
   - No Windows: abra a pasta no Explorador, clique na barra de endereço, digite `cmd` e aperte Enter.
   - No Mac: clique com o botão direito na pasta e escolha **Novo Terminal na Pasta**.
2. Digite:

   ```
   npm start
   ```

3. Deve aparecer:

   ```
   ✅ Subathon Timer rodando!
      Painel:  http://localhost:3000
      Overlay: http://localhost:3000/overlay/
   ```

4. Abra **http://localhost:3000** no navegador. Esse é o seu painel.

> ⚠️ **Deixe essa janela preta aberta durante toda a live.** Fechar a janela desliga o timer (o tempo fica salvo e congelado, veja o FAQ).

Para fechar o programa, clique na janela e aperte **Ctrl + C**.

---

## 4. Criando o app na Twitch (só uma vez)

Para ler seus bits e subs, a Twitch exige que você tenha um "aplicativo" cadastrado. É grátis, leva 2 minutos e só precisa ser feito uma vez. Cada streamer cria o seu, então nenhuma senha ou chave sua passa por terceiros.

1. Entre em **https://dev.twitch.tv/console/apps** e faça login com a conta do seu canal.
   - Se pedir, ative a autenticação em duas etapas (2FA) nas configurações de segurança da Twitch.
2. Clique em **Registrar seu aplicativo** (*Register Your Application*).
3. Preencha assim:

   | Campo | O que colocar |
   |---|---|
   | **Nome** | Qualquer nome único, ex.: `subathon-timer-seunick` |
   | **URLs de redirecionamento OAuth** | `http://localhost` (não é usado, mas o campo é obrigatório) |
   | **Categoria** | `Broadcaster Suite` |
   | **Tipo de cliente** | **Público** (*Public*). ⚠️ Isso é importante! |

4. Clique em **Criar** e depois em **Gerenciar** no app que apareceu.
5. Copie o **ID do cliente** (*Client ID*), aquele código de letras e números.

> O Client ID não é secreto. **Não** é preciso gerar um "segredo do cliente" (*Client Secret*).

---

## 5. Conectando a sua conta

1. No painel, no card **🟣 Conexão com a Twitch**, cole o Client ID e clique em **Conectar com a Twitch**.
2. Vai aparecer um **código** (ex.: `ABCD1234`).
3. Abra **twitch.tv/activate** (o link aparece no painel), digite o código e autorize.
4. Em poucos segundos o painel mostra **"Conectado como seunick"**, e o indicador no topo fica verde.

Pronto! A partir daqui bits, subs, resubs e gifts entram no timer sozinhos. Nas próximas vezes que você abrir o programa, ele **reconecta sozinho**.

> Se aparecer o aviso *"Não foi possível receber: bits…"*, o seu canal provavelmente ainda não é afiliado ou parceiro, e a Twitch só libera bits e subs para esses canais.

---

## 6. Conectando o PixGG (Pix)

O programa recebe as doações Pix ouvindo o mesmo canal que o **widget de alertas do PixGG** usa no OBS. Você só precisa do link desse widget.

1. Entre no painel do **PixGG** e copie o link do seu **widget de alertas**: o mesmo que você colou no OBS para os alertas de Pix. Ele tem este formato: `https://api.pixgg.com/?apikey=…`
2. No painel do timer, no card **💸 Conexão com o PixGG**, cole o link e clique em **Conectar com o PixGG**.
3. O indicador **PixGG** no topo fica verde.

Pronto! Cada Pix soma tempo de acordo com a regra (seção 7). Nas próximas vezes, o programa reconecta sozinho.

> 🔐 **Esse link é pessoal**: quem tiver ele consegue ver as suas doações. Não mostre na tela durante a live e não compartilhe o arquivo `data/config.json`. O painel nunca mostra o link de novo depois de salvo.

> ⚠️ **Integração não oficial.** O PixGG não tem uma API pensada para programas que rodam no seu computador (a oficial só manda avisos para sites na internet). Por isso usamos o mesmo canal do widget. Se o PixGG mudar o widget, a integração pode parar até sair uma versão nova do programa. Faça sempre um teste antes da live.

**Como confirmar que está funcionando:** o jeito mais seguro é uma doação de teste de verdade (ex.: R$ 1,00) e ver se ela aparece no histórico. O simulador do painel testa o timer e o overlay, mas não a conexão com o PixGG.

---

## 7. Configurando o tempo

No card **⚙️ Regras do tempo**:

- **Tempo inicial**: com quanto tempo o subathon começa, **em minutos**. O painel mostra a conversão ao lado do campo.

  | Quero começar com… | Digite |
  |---|---|
  | 2 horas | `120` |
  | 4 horas | `240` |
  | 8 horas | `480` |
  | 12 horas | `720` |
  | 24 horas | `1440` |

  O tempo inicial vale quando você clica em **Iniciar**. Depois disso, mudar esse campo não altera o timer: para dar ou tirar tempo com a live rolando, use o **ajuste manual** (seção 10).
- **Bits**: "A cada **100** bits → **1** min". É proporcional: com essa regra, 250 bits dão 2min 30s e 50 bits dão 30s.
- **Subs**:
  - **Tier 1 / Prime**: minutos de cada sub Tier 1 ou Prime.
  - **Tier 2** e **Tier 3**: minutos dos tiers mais caros.
  - **Resub** usa o valor do tier.
  - **Gift**: cada sub presenteado vale o tier. Ex.: 5 gifts Tier 2 com Tier 2 = 10 min dão 50 min, creditados para quem presenteou.

- **Pix**: "A cada **R$ 10** → **5** min". Também é proporcional: com essa regra, um Pix de R$ 25 dá 12min 30s e um de R$ 2 dá 1 min. O valor usado é o total em reais que o PixGG informa, inclusive em doações vindas de outras moedas.

Clique em **Salvar regras**. Você pode mudar as regras a qualquer momento, e elas valem para os próximos eventos.

---

## 8. Colocando o overlay no OBS

1. No painel, no card **🎨 Overlay**, clique em **Copiar** para copiar o link (`http://localhost:3000/overlay/`).
2. No OBS, em **Fontes**, clique em **+** e escolha **Navegador**.
3. Dê um nome (ex.: "Subathon") e clique em OK.
4. Cole o link em **URL**.
5. Use **Largura: 800** e **Altura: 450**.
6. Clique em OK e posicione o timer onde quiser na cena.

O fundo é transparente. Para deixar o timer maior ou menor, redimensione a fonte no OBS: tudo escala junto.

**Personalizando:** no mesmo card, escolha a **cor principal**, a **cor do texto** e a **fonte**, e clique em **Salvar visual**. O overlay muda na hora, sem precisar recarregar nada no OBS.

> As fontes vêm do Google Fonts. Sem internet, o overlay usa a fonte padrão do sistema.

---

## 9. Testando com o simulador

Antes da live, teste tudo no card **🧪 Simulador**:

1. Escolha o tipo (Bits, Sub, Resub, Gift ou Pix), um nome e a quantidade, o tier ou o valor em reais.
2. Clique em **Simular evento**.

O evento passa exatamente pelo mesmo caminho de um evento real: soma tempo, aparece no overlay com animação e entra no histórico marcado como **simulado**.

> 💡 Testou antes de começar? Clique em **Finalizar subathon…** para zerar tudo antes de iniciar de verdade. Os testes ficam guardados no arquivo.

---

## 10. Durante a live

| Quero… | Faço… |
|---|---|
| **Começar o subathon** | Clique em **▶ Iniciar subathon** |
| **Pausar** (intervalo, queda da live) | Clique em **⏸ Pausar**. Bits e subs continuam somando tempo enquanto pausado |
| **Voltar a contar** | Clique em **▶ Continuar** |
| **Dar ou tirar tempo na mão** | Em "Ajustar tempo manualmente", digite os minutos e clique em **＋ Adicionar** ou **－ Remover** |
| **Encerrar e arquivar** | Clique em **Finalizar subathon…**, confirme e digite **FINALIZAR** na segunda confirmação |

**Quando o timer chega a zero**, o overlay mostra **FIM!** e o subathon acaba. Bits e subs que chegarem depois ainda aparecem no histórico, mas **não somam tempo** e não reabrem o timer.

**Finalizar** guarda tudo (estado final e histórico completo) num arquivo em `data/archive/` e deixa o painel pronto para um subathon novo.

> Por segurança, **Remover** não deixa o timer chegar a zero: um clique errado não encerra a sua live.

---

## 11. Exportando o histórico

No card **📜 Histórico**, clique em **⬇ Exportar CSV**. O arquivo abre direto no Excel ou no Google Planilhas, com data e hora, tipo, usuário, quantidade, tier, minutos adicionados e se foi simulado.

---

## 12. Perguntas frequentes

**O computador desligou (ou fechei a janela sem querer). Perdi o tempo?**
Não. O tempo restante é salvo a cada segundo. Ao abrir o programa de novo, o timer volta **pausado**, exatamente onde parou. O tempo com o programa fechado **não é descontado**. Clique em **Continuar** quando estiver pronto.

**Funciona com o PC desligado ou com a live offline?**
O programa precisa estar aberto para receber os eventos e contar o tempo. Se ele estiver fechado, os eventos da Twitch desse período não são recebidos.

**Posso abrir o painel no celular?**
Por segurança, o programa só aceita conexões do próprio computador. O painel funciona em telas pequenas, mas precisa ser aberto no PC onde o programa roda.

**Preciso deixar o painel aberto no navegador?**
Não. Só a janela do programa (a preta) precisa ficar aberta. O painel e o overlay podem ser fechados e abertos quando quiser.

**Onde ficam meus dados?**
Na pasta `data/`, dentro do projeto:
- `config.json`: suas regras, o visual, o login da Twitch e o link do PixGG. **Não compartilhe esse arquivo.**
- `state.json`: o estado do timer.
- `events.jsonl`: o histórico do subathon atual.
- `archive/`: os subathons finalizados.

**Doações anônimas aparecem como?**
Como **Anônimo**.

**Um sub presenteado conta duas vezes (para quem deu e para quem ganhou)?**
Não. Conta uma vez, para quem presenteou.

**Doações Pix contam mesmo com o alerta "sob demanda" no PixGG?**
Sim. A doação conta assim que chega. Se depois você reenviar ou tocar o alerta pelo painel do PixGG, ele **não** conta de novo.

**Reenviei no PixGG o alerta de uma doação antiga, de antes do subathon. Ela conta?**
Conta, porque para o programa ela é nova. Evite reenviar alertas antigos durante o subathon; se acontecer, use o **－ Remover** para corrigir.

**O que acontece com um Pix se o programa estiver fechado?**
Ele não é recebido, e o tempo dele não é somado (igual aos bits e subs). Some na mão com o **＋ Adicionar** se quiser.

---

## 13. Solução de problemas

**"A porta 3000 já está em uso"**
O programa provavelmente já está aberto em outra janela. Feche a outra janela. Se for outro programa usando a porta, abra `data/config.json`, troque `"port": 3000` por outro número (ex.: `3001`) e use esse número nos links do painel e do OBS.

**"node não é reconhecido como um comando"**
O Node.js não foi instalado, ou o terminal foi aberto antes da instalação. Instale (passo 1) e abra um terminal novo.

**O painel diz "Sem conexão com o programa"**
A janela do programa foi fechada ou travou. Abra de novo com `npm start`. O painel reconecta sozinho.

**O overlay no OBS está em branco**
- Confira se o programa está aberto.
- Confira se a URL é exatamente a do painel (com `/overlay/` no final).
- Nas propriedades da fonte no OBS, clique em **Atualizar cache da página atual**.

**"A Twitch recusou o Client ID"**
Confira se copiou o **Client ID** inteiro e se o app foi criado como **Público** (passo 4). Se foi criado como "Confidencial", crie outro app como Público.

**"Seu login da Twitch expirou"**
Acontece se o app ficar mais de 30 dias sem uso, ou se você removeu a permissão na Twitch. Clique em **Conectar com a Twitch** e repita o passo 5.

**Pix não está entrando**
- O indicador **PixGG** no topo está verde?
- O link colado é o do **widget de alertas** (com `apikey=` no endereço)? Desconecte e cole de novo.
- O widget de alertas do PixGG no OBS mostra a doação? Se nem ele mostra, o problema é no PixGG.
- Veja a janela do programa: cada Pix recebido aparece como `[evento] pix de …`, e uma doação que não deu para ler aparece como `[pixgg] doação ignorada`, com o número da transação.

**"O PixGG recusou a conexão"**
O PixGG provavelmente mudou o widget. Veja se há uma versão nova do programa.

**Bits e subs não estão entrando**
- O indicador no topo do painel está verde ("Twitch: seunick")?
- Seu canal é afiliado ou parceiro? Só esses recebem bits e subs.
- Veja a janela do programa: cada evento recebido aparece como `[evento] …`. Avisos e erros também aparecem lá.

**Apareceu "config.json estava corrompido"**
O arquivo foi danificado (por exemplo, numa edição manual). Uma cópia foi guardada ao lado, com `.corrompido-…` no nome, e o programa voltou às configurações padrão. Reconfigure pelo painel.

---

## 14. Atualizando o programa

1. Feche o programa (Ctrl + C na janela).
2. **Guarde a pasta `data/`**: é ali que estão suas configurações e históricos.
3. Baixe a versão nova (ZIP ou `git pull`) e coloque a pasta `data/` antiga dentro dela (se usou `git pull`, ela já fica no lugar).
4. Abra de novo com `npm start`.

---

## 15. Para desenvolvedores

Zero dependências: Node ≥ 22 (`node:http`, `fetch` e `WebSocket` nativos), HTML/CSS/JS puro sem build, e testes com `node:test`.

```
npm test     # testes do domínio (regras, timer, persistência, deduplicação, normalização da Twitch)
npm start    # sobe o servidor em 127.0.0.1
```

```
src/
  server.js          HTTP: arquivos estáticos, API, SSE (/api/stream), CSV
  subathon.js        domínio: regras (minutesFor), timer, histórico, persistência
  config.js          configuração e validação
  twitch.js          Device Code Flow, EventSub WebSocket, normalização dos eventos
  pixgg.js           canal Pusher do widget do PixGG, normalização das doações
  store.js           escrita atômica de JSON e histórico em JSON Lines
  csv.js             exportação do histórico
  subathon.test.js
public/
  panel/             painel de controle
  overlay/           overlay do OBS
  shared/format.js   formatação usada pelos dois
```

**Fluxo de um evento:** Twitch, PixGG ou simulador → evento normalizado `{ type, user, amount, tier }` → `subathon.apply(evento, { id })` → `data/` → SSE → painel e overlay. O `id` (`message_id` da Twitch, `pixgg:<TransactionId>` do PixGG) evita contar duas vezes. Pix trafega em **centavos**.

**PixGG:** a API oficial (Applications) só envia webhook para uma URL pública, o que não existe num programa local. Usamos o canal Pusher do widget de alertas: app `787e05d557a8480c3ee7`, cluster `mt1`, canal = `apikey` do widget, evento `messages` com `TransactionId`, `DonatorNickname`, `TotalAmount` (BRL). Mensagens sem `TransactionId` vêm de outros widgets (meta, PixAthon) e são ignoradas. Isso foi tirado do código do widget e pode mudar sem aviso.

**Variáveis de ambiente** (opcionais, para testes):

| Variável | Uso |
|---|---|
| `PORT` | Sobrescreve a porta do `config.json` |
| `SUBATHON_DATA_DIR` | Usa outra pasta de dados |
| `PIXGG_PUSHER_URL` | Aponta a conexão do PixGG para um mock do protocolo Pusher |
| `TWITCH_AUTH_URL`, `TWITCH_API_URL`, `TWITCH_EVENTSUB_URL` | Apontam para um mock, ex.: a [Twitch CLI](https://dev.twitch.tv/docs/cli/) (`twitch event websocket start-server`, com `TWITCH_EVENTSUB_URL=ws://127.0.0.1:8080/ws` e `TWITCH_API_URL=http://127.0.0.1:8080`) |

**Licença:** ainda não definida.
