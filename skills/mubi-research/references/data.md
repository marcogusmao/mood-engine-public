# Dados do MUBI: a API e a identidade

Medido em 12/10/2026 (sessão principal, antes da implementação; 20 filmes do piloto e 2 sondas). Respostas de amostra, não versionadas, ficam em `.context/mubi-contrato/` da máquina que mediu. O texto do MUBI é de terceiros; este arquivo não traz nenhum. O formato do cache está em [cache-contract.md](cache-contract.md).

## Onde fica

`cache/mubi.json` do repositório em produção (desde 13/10/2026; antes `.context/mubi/mubi.json`) (detalhes em [cache-contract.md](cache-contract.md)). O servidor só lê; quem escreve é `scripts/collect-mubi.py`: à mão e, desde 14/10/2026, pela rotina noturna do workflow (`scripts/mubi-nightly.js`, até 100 pedidos por dia, decisão do Marco de 13/10/2026).

## A API (o que o coletor chama)

- `GET https://api.mubi.com/v3/search/films?query=<título>&per_page=10` → `{ films[], meta{current_page,next_page,total_pages,total_count,per_page}, zero_results }`. **Cada item da busca já traz os mesmos campos do detalhe**, então uma busca por filme basta.
- `GET https://api.mubi.com/v3/films/<id ou slug>` → o detalhe (200 JSON). O coletor só o pede quando falta uma chave que o item da busca devia trazer, ou, se a busca responder 5xx, pelo slug derivado do título.
- Cabeçalhos enviados, sempre os mesmos: `Client: web`, `Client-Country: US`, `Accept-Language: en`, `Accept: application/json`, `Accept-Encoding: identity` e `User-Agent: MoodEngineMubiCollector/1.0 (personal film catalogue; https://github.com/marcogusmao/mood-engine)`. Sem proxy e sem seguir redirecionamento (regra da correção do coletor de 12/10/2026; confira em `scripts/collect-mubi.py` antes de citar como verificado). Na rede vai só o título do filme.
- **O idioma não se deduz do cabeçalho.** `Client-Country: US` e `BR`, ambos com `Accept-Language: en`, devolveram `title_locale: en-US` e textos em inglês. Registre o `title_locale` devolvido (campo `locale`; no MCP, `language`).

## Campos usados

| Conteúdo | Campo da API | Observado |
|---|---|---|
| Our Take | `default_editorial` (texto puro); `default_editorial_html` (HTML: não usar) | ~300 caracteres |
| Sinopse comum | `short_synopsis` (texto puro); `short_synopsis_html` | ~300 caracteres. Nas respostas medidas (20 filmes do piloto e 2 sondas, 12/10/2026) não há campo de sinopse longa: é sempre `kind: "short"` |
| Avaliação | `average_rating_out_of_ten` (escala 10) e `average_rating` (escala 5) | `average ≈ outOfTen / 2`, arredondado a 1 casa |
| Votos | `number_of_ratings` | inteiro |
| Identidade | `id`, `slug`, `title`, `original_title` (pode ser `"東京物語 \| Tōkyō Monogatari"`: partes separadas por ` \| `), `year`, `duration`, `directors[].name`, `web_url` | sem IMDb id; a grafia de diretor difere (`Yasujirô Ozu` no MUBI, `Yasujirō Ozu` no TMDB): compare sem diacríticos |
| Fora de escopo, não guardar | `critic_review_rating` (nota de críticos), `star_rating` (pessoal), `press_quote`, comentários | |

## Formato do `mubi.json`

Está em [cache-contract.md](cache-contract.md): o formato, o `status` do registro, o estado de cada campo, a regra de `votes 0`, a atualização que falha e o `report.json`.

## Identidade (regra do coletor)

Normalização: NFKD, sem diacríticos, minúsculas, `&` vira `and`, pontuação vira espaço, espaços colapsados. Um filme do MUBI é `confirmed` só quando **todas** valem para exatamente um candidato:

1. título normalizado igual ao `title` OU a uma parte de `original_title` (dividido em ` | `); registra-se em `evidence` qual bateu;
2. diferença de ano ≤ 1 (se for 1, `note` registra);
3. pelo menos um diretor em comum, após a normalização;
4. se as duas durações existem e diferem mais de 20 minutos, não confirma (possível outro corte): vira candidato.

Dois ou mais candidatos passando: `ambiguous`. Na rota por slug (busca 5xx), sem duração para conferir a regra 4: `ambiguous`, nunca `confirmed`. O primeiro resultado nunca basta por ser o primeiro.

## O que o MCP serve de cada estado

Ver a seção "MUBI" de `tools/letterboxd-mcp/README.md` e o final de [cache-contract.md](cache-contract.md).
