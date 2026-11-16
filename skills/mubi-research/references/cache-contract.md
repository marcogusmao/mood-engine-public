# Contrato do cache `mubi.json`

Fonte versionada do formato que o coletor `scripts/collect-mubi.py` escreve e o MCP `letterboxd` lê. Medido em 12/10/2026 a partir das respostas da API (20 filmes do piloto e 2 sondas) e atualizado no mesmo dia com as regras da correção do coletor. Este arquivo não traz texto do MUBI: onde havia um trecho de resposta real, há `<texto do MUBI>`. A API, os cabeçalhos e a identidade estão em [data.md](data.md).

## Onde fica

Produção: `cache/mubi.json` do repositório (Marco, 13/10/2026: versionado, o repositório é privado; antes `~/Claude/mood-engine/.context/mubi/mubi.json`, fora do Git). O MCP resolve `MOOD_MUBI` ou `<raiz>/cache/mubi.json` **uma vez, na partida**; nenhuma entrada de ferramenta e nenhuma releitura das fontes muda o caminho. Escrita atômica pelo coletor (arquivo temporário e `rename` na mesma pasta); o MCP só lê.

Acrescentado em 14/10/2026: a rotina noturna do workflow (`scripts/mubi-nightly.js`) também escreve nesse arquivo, em lotes de até 100 pedidos por dia, e funde o resultado sem perder registro antigo. Só os campos da lista permitida de `lib/mubi-cache.js` entram nele; registros que não são `confirmed` (`not_found_in_search`, `ambiguous`, `error`) passam a existir ali, e o leitor do MCP os trata como já trata.

## Formato (schema 1)

```json
{
  "schema": 1,
  "source": "api.mubi.com/v3",
  "updatedAt": "2026-10-12T23:00:00.000Z",
  "films": {
    "tt0000000": {
      "status": "confirmed",
      "capturedAt": "2026-10-12T23:00:00.000Z",
      "request": { "country": "US", "acceptLanguage": "en", "query": "Título", "detail": "not-needed" },
      "mubi": { "id": 1, "slug": "titulo", "url": "https://mubi.com/films/titulo" },
      "identity": {
        "asked": { "title": "Título", "year": 2016, "directors": ["Nome"], "runtime": 118 },
        "found": { "title": "Título", "originalTitle": "Título", "year": 2016, "directors": ["Nome"], "duration": 119 },
        "evidence": ["title", "year", "director"],
        "note": ""
      },
      "locale": "en-US",
      "ourTake": { "state": "available", "text": "<texto do MUBI>" },
      "synopsis": { "state": "available", "kind": "short", "text": "<texto do MUBI>" },
      "rating": { "state": "available", "outOfTen": 0.0, "average": 0.0, "votes": 0 }
    }
  }
}
```

Os números do exemplo são marcadores, não medidas. A chave de `films` é o IMDb id (`tt\d+`).

## `status` do registro

| `status` | quando | leva |
|---|---|---|
| `confirmed` | a identidade passou (regras em [data.md](data.md)) | `ourTake`, `synopsis`, `rating`, `locale`, `mubi`, `identity` |
| `ambiguous` | dois ou mais candidatos passaram, **ou a rota por slug não pôde verificar a duração** | `candidates: [{ mubi, found, evidence, why }]`, **sem conteúdo** |
| `not_found_in_search` | **só** quando a busca respondeu 200 e nenhum resultado correspondeu. Não é "não existe no MUBI": a busca é limitada | nada de conteúdo |
| `error` | falha da requisição, inclusive **busca com 5xx e a rota por slug com 404** | `error: { at, reason }` |

Só `confirmed` leva campos de conteúdo. O MCP serve qualquer outro `status` como `unknown`, `reason: "identity-unconfirmed"`, sem nada do registro.

**Rota por slug.** Quando a busca responde 5xx (e só então), o coletor tenta `/v3/films/<slug derivado do título>` e julga o resultado pelas mesmas regras de identidade. Busca 5xx + slug 404 → `error` (não `not_found_in_search`: a busca nem respondeu). Resposta por slug sem duração para conferir (a regra 4 da identidade não pode ser verificada) → `ambiguous`, nunca `confirmed`. Um registro produzido por essa rota (`confirmed` ou `ambiguous`) leva, em `request`, `via: "slug-fallback"` e `slug` (o slug que foi pedido); na confirmação, `identity.evidence` ganha `"slug-fallback"` e `identity.note` diz que a busca respondeu 5xx. Na rota comum, `request.detail` diz se o detalhe foi preciso (`not-needed`) ou foi pedido e serviu (`ok`). `not_found_in_search` leva `searched: { results }` (quantos resultados a busca devolveu). Um `ambiguous` por duração não verificável leva um só candidato, com `why: "slug-fallback-runtime-unverifiable"`.

## Estado de cada campo

Todo campo de conteúdo (`ourTake`, `synopsis`, `rating`) tem um `state`:

- `available`: texto não vazio, ou número válido.
- `absent`: a resposta trouxe a chave com `null` ou `""` (o MUBI respondeu vazio).
- `unknown`: **a chave não veio** na resposta, ou o valor é inválido, e então `reason` diz por quê (`missing`, `invalid`, `too-long`, `inconsistent`, `no-out-of-ten`…).

Chave ausente → `unknown`; `null` → `absent`. Nunca se trocam. (Na nota, que tem duas escalas e uma contagem de votos, vale a tabela da seção própria, abaixo.)

### Texto (`ourTake`, `synopsis`)

O campo puro da API (`default_editorial`, `short_synopsis`; nunca o `_html`), com os caracteres de controle trocados por espaço, no máximo 4.000 caracteres por texto (acima: `unknown`, `reason: "too-long"`). `synopsis.kind` é sempre `"short"`. **O coletor não tira tag HTML: guarda o texto como a API mandou. Quem tira as tags (e o conteúdo de `<script>`/`<style>`) é o MCP, ao servir**, e é ele que corta em 600.

### Nota (`rating`)

Decisão do coletor, na ordem em que vale (a primeira que casar):

| situação | resultado |
|---|---|
| `number_of_ratings` presente e que não é uma contagem (negativo, fracionário, texto, booleano, lista…) | `state: "unknown"`, `reason: "invalid"`, `votes: "unknown"` |
| `votes` é `0` | `state: "absent"`, `reason: "no-votes"`, `votes: 0`, qualquer que seja o número guardado ao lado |
| qualquer escala fora da faixa ou do tipo (`outOfTen` em [0,10], `average` em [0,5]) | `unknown`, `reason: "invalid"` |
| as duas escalas válidas e `\|average×2 − outOfTen\| ≤ 0,15` | `available`, os dois valores originais |
| as duas válidas e a diferença maior | `unknown`, `reason: "inconsistent"` |
| só `outOfTen` válido (a outra escala ausente **ou `null`**) | `available`, `outOfTen` e **`average: null`** |
| só `average` válido, e `outOfTen` é `null` | `unknown`, `reason: "inconsistent"` |
| só `average` válido, e `outOfTen` ausente | `unknown`, `reason: "no-out-of-ten"` (não se converte 5 em 10) |
| as duas escalas `null` | `absent`, com os `votes` |
| nenhuma escala válida e pelo menos uma chave ausente (ausente + ausente, ausente + `null`) | `unknown`, `reason: "missing"` |

- **`average: null` dentro de um `available` é previsto**: a nota de escala 10 é a obrigatória; sem a de escala 5, a nota continua `available` e o MCP mostra `average: "unknown"`. O MCP aceita o `null` e a ausência da chave do mesmo jeito. Já um `outOfTen` `null` nunca é `available`.
- `votes`: inteiro ≥ 0. **`"unknown"` é só a contagem que não veio** (chave ausente ou `null`); uma contagem que veio errada não vira `"unknown"`, torna a nota `unknown`/`invalid`.
- Uma média de zero avaliações não é nota, e também não é nota zero. O MCP aplica a mesma regra de `votes: 0` ao ler (o cache pode ter sido escrito por outro programa).
- Nota ausente com votos positivos: `absent`, com os `votes`. Nota zero com votos positivos é `available` com `outOfTen: 0`.
- Nunca converter nem arredondar: o valor original.

## Atualização que falha

Uma atualização que falha (erro, bloqueio, ou um veredito que não confirma) nunca joga fora o último registro bom:

- registro `confirmed`: fica como estava e ganha `stale: true` e `lastError: { at, reason }`; o `reason` é o erro, ou `refresh-<status>` quando a nova busca não confirmou (`refresh-ambiguous`, `refresh-not_found_in_search`). O MCP repassa os dois em cada campo. Uma execução seguinte, mesmo sem `--refresh`, pede de novo o filme `stale`; um `--refresh` interrompido continua com `--resume`.
- registro `ambiguous` que a nova tentativa só errou (`error`): fica com os candidatos e ganha `lastError`, **sem `stale`** (uma ambiguidade não é uma confirmação velha). O MCP o serve como `identity-unconfirmed`, sem candidato.
- qualquer outro caso: o veredito novo substitui o registro, e o `lastError` e o `stale` somem.



## Idioma

`locale` é o `title_locale` devolvido pela API (por exemplo `en-US`), não o idioma pedido: `Client-Country` US e BR, ambos com `Accept-Language: en`, devolveram `en-US`. O MCP o mostra como `language`, ou `"unknown"` se não parecer um código de idioma.

## O que nunca entra

`critic_review_rating` (nota de críticos), `star_rating` (pessoal), `press_quote`, comentários, o HTML, qualquer dado pessoal do Marco (notas, watchlist, justificativas). Na rede vai só o título do filme: ano, diretores, duração e IMDb id ficam locais e servem para confirmar a identidade.

## `report.json`

O coletor escreve, ao lado do `mubi.json`, o `report.json`: o resumo do cache para os filmes pedidos (`cache`: contagem por `status`, quantos `stale`, quantos campos disponíveis entre os confirmados), `thisRun` (a execução que acabou de rodar) e **`runs[]`**, o histórico, um item por execução (`startedAt`, `finishedAt`, `refresh`, `resumedFrom` quando foi `--resume`, `requests`, `outcomes`, `stopped`). Quando para, `stopped` traz `reason`, o filme (`film`/`resumeFrom`), `requestsMade`, `exitCode`, `retryAfter` e `waitBeforeRetry` nos bloqueios, e `how`. **Retomada:** uma execução comum que parou se repete com o mesmo comando; um `--refresh` que parou se retoma com `--resume`, que recomeça no `resumeFrom` e não pede de novo os filmes atualizados antes dele nessa execução (a mensagem de parada imprime o comando exato). O MCP não lê o `report.json`.

## O que o MCP serve de cada estado

Ver a seção "MUBI" de `tools/letterboxd-mcp/README.md`. Resumo: `unknown` com `no-cache`, `cache-invalid`, `too-large`, `not-captured`, `record-invalid`, `identity-unconfirmed`, `invalid`, `inconsistent`, `too-long` ou o motivo do próprio cache; `absent` com fonte, endereço e data (e, na nota, `reason: "no-votes"` quando `votes` é 0); `available` com texto limpo e cortado, ou a nota com os dois valores originais e `scales`.
