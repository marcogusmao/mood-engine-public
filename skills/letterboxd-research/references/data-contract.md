# Contrato de dados e evidência

O repositório de execução é `marcogusmao/mood-engine`. Descubra a raiz autorizada da sessão; dados pessoais, índices e snapshots continuam privados.

## Fontes existentes

| Caminho no Mood Engine | Estrutura e uso |
|---|---|
| `cache/tmdb.json` | `movie` contém entradas `{t,v}`. Escolher somente os campos necessários de `v`: IMDb, ID TMDB, título, ano, gêneros, keywords, overview, diretores, runtime, idioma. `t` é a data do cache; a data do relatório não a substitui. |
| `cache/friends.json` | `films` liga slug a IMDb/TMDB e fatos públicos; `users` registra cobertura e histórico de contas. `gone` exige tratamento próprio. Ler amigos configurados pelo mecanismo do motor, não pelo total de seguidos. |
| `cache/lists.json` e `config.json` | Listas, autoria e confiança. A classificação `critic`/`director`/`fan` é explícita. Critérios e exceções vêm do contrato atual e de `lib/recommendation-quality.js`. |
| `data/letterboxd/*.csv` | Export pessoal já usado pelo motor. Watched, diary, ratings, watchlist e likes são sinais diferentes. `profile.csv`, e-mail, comentários e reviews não entram nesta projeção. |
| `cache/mubi.json` | Cache do MUBI (12/10/2026; em `cache/` desde 13/10/2026, antes `.context/mubi/`): por IMDb id, texto editorial (Our Take), sinopse curta e média da comunidade, com `status`, identidade e data de captura. Escrito só por `scripts/collect-mubi.py`, à mão e, desde 14/10/2026, pela rotina noturna do workflow (`scripts/mubi-nightly.js`, até 100 pedidos por dia); o MCP só lê (`film_dossier`). Formato e estados em `skills/mubi-research/references/cache-contract.md`. Texto de terceiros: desde 13/10/2026 é versionado (repositório privado) e entra nas descrições públicas com o crédito `MUBI: ` (decisão de Marco, PRODUCT.md). A nota do MUBI não se mistura com a do Letterboxd nem a do TMDB |
| `.context/learning-private/snapshots` | Registros históricos privados. Um cálculo atual não explica sozinho por que um filme apareceu num build anterior. |

Não deduza identidade por um ID TMDB de TV tratado como filme. Conferir IMDb evita emprestar título, duração ou tags de outra obra. Cortes de cinema e de TV podem ter IDs diferentes e estados de visto distintos.

## Pesquisa iniciada em 12/10/2026

Gerados na área isolada `2026-10-12-film-research` e integrados em 12/10/2026 (decisão do Marco) no ramo `research-evidence`, sobre `06cc791`. Os caminhos versionados abaixo (`scripts/`, `research/2026-10-12-film-research/`, `test/`) chegam à `main` com o merge desse ramo (PR #13; antes dele, só no ramo). `.context/` nunca é versionado: fica na máquina que coletou. O pacote é lido pelo MCP com `film_research_evidence`:

- `scripts/research-films.py`: inventário público, IMDb bulk, Wikidata, Wikipedia e Letterboxd com checkpoints.
- `scripts/review-film-research.py`: dossiês e CSV para revisão.
- `scripts/verify-film-research.py`: auditoria de identidade e de cobertura.
- `.context/film-research/{inventory,coverage}.json` e `{imdb,wikidata,wikipedia,letterboxd}.jsonl`: checkpoints locais; a última linha por ID é o estado vigente.
- `research/2026-10-12-film-research/{coverage.json,review.csv,films.jsonl.gz,editorial.json}`: pacote de revisão (export de 2026-10-12T16:00Z; `generatedAt` em `coverage.json`). Pode estar atrás da coleta; confira `generatedAt`. O `README.md` da pasta traz o estado final, a procedência e a licença (prévias com até 18 palavras e fonte por registro; sem texto da Wikipedia; repositório privado, não publicar). Os scripts estão em `scripts/` e o teste em `test/film_research_test.py` (23 testes).

O inventário dessa revisão tem 12.931 registros: 12.871 com IMDb e 60 sem IMDb. Há 11.610 registros TMDB não nulos, 1.685 sem keywords e três sem overview. Na união inteira, 1.324 não têm sinopse TMDB, incluindo 1.321 sem registro TMDB. Sempre nomeie o denominador.

Um dossiê contém `sourceStatus`, `sourceFacts`, `sourceGenres`, `sourceTaxonomies`, `candidateFacets`, `moodReview`, `synopsisReview`, `issues`, `editorialStatus` e `applied`. As inferências têm origem e estado de revisão. Fonte ausente, identidade recusada e erro temporário são estados diferentes.

Wikipedia usa o QID da ligação exata `P345` e uma revisão `oldid`. Redirecionamento para um QID diferente fica recusado como fonte de premissa. Letterboxd usa página canônica e identidade IMDb; sem IMDb, confira slug e TMDB. Páginas legítimas podem omitir ano ou TMDB ID; um erro temporário com título genérico nunca conta como filme pesquisado.

`UNKNOWN` é informação ausente. Zero, falso, rejeição e “o filme não tem esta característica” têm outros significados.

## Privacidade e cópia

Índices com histórico e notas pessoais ficam em destino privado. Use projeções de campos permitidos antes de mostrar dados. URLs configuradas de addons, chaves, arquivos de autenticação, `.env`, Keychain e backups de clientes não são fontes desta pesquisa.

Preserve pequenos resumos atribuídos e URLs. Não publique os textos integrais coletados nem exporte dados pessoais para um artefato público. Reconcilie licença e tamanho do material antes de distribuir um pacote de evidências.
