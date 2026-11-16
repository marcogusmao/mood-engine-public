#!/usr/bin/env node
"use strict";
// Receipts of mutation for the nightly on the Mac (21/10/2026): plants 141 defects (M128 to M141, of 15/11/2026: the memory of Tonight sent only after the publication, and the Board the MUBI step is handed; M125 to M127, of 14/11/2026, the switch of that memory; before them: the 25 of the specification plus M26 and M27, M28 to M42 of the first review of 21/10/2026, M39 to M42 being in the README, M43 to M107 of the operation review and the decisions of Marco of the same day, and M108 to M124 of the re-verification in a clean context of the same day), one at a time, in a COPY of scripts/noturna-mac.sh, of the launcher template, of the installer, of the plist or of the README,
// and requires that the named test of test/noturna-mac.test.js turns red. Lives in test-support/ and not in test/ because everything in test/ runs as a test.
//
//   node test-support/noturna-mutacoes.js [--sem-base] [--so M3,M7]
//     --sem-base   skip the first run of the whole suite (the original must be green; the default runs it first and aborts if it is not)
//     --so         only these ids
//
// How: the original suite first ("bateria original: verde"). For each mutation: the file is copied to a temporary folder and the edit applied, which must find EXACTLY ONE
// occurrence of the text ("MUTAÇÃO NÃO APLICÁVEL" otherwise: the instrument is blind, not the test); then `node --test` runs the test(s) that guard it, with
// NOTURNA_SCRIPT_SOB_TESTE / NOTURNA_LANCADOR_SOB_TESTE / NOTURNA_PLIST_SOB_TESTE pointing at the copy. Killed only when one of the named tests is among the red ones
// (a mutation that makes only other tests red is reported as "morta por outro teste" and does not count). A survivor is a test that is missing: write it, or write the reason
// in BACKLOG.md and in the commit; never delete the mutation. Run it with Node 22, at low priority (the project's rule): taskpolicy -b nice -n 19 <node22> test-support/noturna-mutacoes.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ARQUIVOS = {
  script: { caminho: path.join(ROOT, "scripts", "noturna-mac.sh"), env: "NOTURNA_SCRIPT_SOB_TESTE" },
  lancador: { caminho: path.join(ROOT, "scripts", "launchd", "noturna-mood-engine.modelo"), env: "NOTURNA_LANCADOR_SOB_TESTE" },
  plist: { caminho: path.join(ROOT, "scripts", "launchd", "com.marco.noturna-mood-engine.plist"), env: "NOTURNA_PLIST_SOB_TESTE" },
  readme: { caminho: path.join(ROOT, "README.md"), env: "NOTURNA_README_SOB_TESTE" },
  instalador: { caminho: path.join(ROOT, "scripts", "instalar-noturna-mac.sh"), env: "NOTURNA_INSTALADOR_SOB_TESTE" },
};
const T = {
  instalador: "^installer creates the dedicated clone",
  semMarca: "^refuses a clone without \\.git/noturna-dedicado",
  origem: "^refuses an unexpected origin",
  trava: "^a second run is refused",
  ensaio: "^--ensaio pushes nothing",
  agendada: "^--agendada saves only the named caches",
  mesmoDia: "^the same day",
  // review of 21/10/2026 (B1): the gh-pages parent. Replaces "two publications keep gh-pages at one commit", whose property (always one commit) is now the Sunday night's.
  paiPages: "^gh-pages: an ordinary night",
  paiRemoto: "^gh-pages: if the origin",
  semana: "^gh-pages: the weekday",
  // review of 21/10/2026 (B3, C6): installer and proximo-modo
  instaladorMantem: "^installer: a reinstall that gives one option",
  instaladorAnteriores: "^installer: the copy of a replaced file",
  proximoModo: "^launcher: proximo-modo",
  // review of 21/10/2026 (C1, C2, C3): signals, the lock, the time limits, index.lock
  sigterm: "^SIGTERM on the launcher during the build",
  sigtermFetch: "^SIGTERM on the launcher during the fetch",
  scriptMorto: "^the night.s script killed",
  travaVencida: "^a lock whose live owner is older",
  travaVelha: "^a stale lock",
  passosLimite: "^a step that hangs",
  fetchLimite: "^the launcher.s fetch has",
  exitTimeout: "^plist: ExitTimeOut",
  indexLock: "^an orphan index.lock",
  // finding C4: the two mutations the first round left alive
  caffeinate: "^the night runs under caffeinate -i",
  faxina: "^log cleanup:",
  manual: "^--manual: no MUBI",
  // 15/11/2026: the memory of Tonight after the publication, and the Board the MUBI step is handed
  memPub: "^Tonight memory, path 1",
  memPerdida: "^Tonight memory, path 2",
  memNaoPublica: "^Tonight memory, path 3",
  memSegunda: "^Tonight memory, path 4",
  memRetida: "^Tonight memory: when the cache commit was kept back",
  memRetry: "^Tonight memory: a rejected",
  memDois: "^Tonight memory: when another warning came first",
  mubiBoard: "^the MUBI step hands the collector",
  mubiVazio: "^the MUBI step does not hand over an EMPTY Board",
  verificacao: "^a failed site check blocks",
  fronteira: "^the boundary check refuses",
  python: "^failing Python tests stop",
  rebase: "^main moved during the build",
  json: "^after the rebase a cache file is not JSON",
  mubi: "^the MUBI watchdog",
  chave: "^the TMDB key never reaches",
  keychain: "^a Keychain read that fails",
  disco: "^low disk is refused",
  paridade: "^parity with the workflow",
  offline: "^NOTURNA_BUILD=offline turns",
  // review of 21/10/2026: the Git credential
  semToken: "^no-token mode",
  token: "^token mode: only",
  tokenFalha: "^token mode: an unreadable",
  instaladorToken: "^installer: --token-servico",
  readme: "^the README says what is not verified",
  // second review of 21/10/2026 (operation)
  diaInicio: "^the day mark is the day the night STARTED",
  // decisions A1 and A2 of Marco (21/10/2026): retry windows and battery
  bateria: "^battery: the scheduled night",
  bateriaManual: "^battery: --manual",
  janelas: "^windows: the history",
  janelasRelogio: "^windows: where the clock falls",
  // re-verification of 21/10/2026 (round 3): the zone of the recorded start time
  fusoLimite: "^limite\\.pgid written by a real night",
  // re-verification of 21/10/2026 (round 3): the launcher's fetch is ended through its whole group
  fetchGrupo: "^the launcher.s fetch is ended through its whole process group",
  fetchKill9: "^the launcher killed with SIGKILL during the fetch",
  rebaseMeio: "^a rebase left half-done",
  naoExiste: "^gh-pages: the log says",
  chromesLimite: "^a build ended by its limit still lists",
  readmeEscolhas: "^the README marks the eight choices",
  vigiaPerdido: "^com_limite does not wait for its limit",
  travaPadrao: "^the lock.s default maximum age",
};
const um = (arquivo, procura, troca) => ({ arquivo, procura, troca });

const MUTACOES = [
  { id: "M1", desc: "launcher: no check of .git/noturna-dedicado", edits: [um("lancador", 'if [ ! -f "$NOTURNA_CLONE/.git/noturna-dedicado" ]; then', "if false; then")], testes: [T.semMarca] },
  { id: "M2", desc: "launcher: no check of the origin", edits: [um("lancador", 'if [ "$url" != "$NOTURNA_ORIGEM" ]; then', "if false; then")], testes: [T.origem] },
  { id: "M3", desc: "launcher: mkdir of the lock becomes mkdir -p", edits: [um("lancador", 'if mkdir "$trava" 2>/dev/null; then', 'if mkdir -p "$trava" 2>/dev/null; then')], testes: [T.trava] },
  { id: "M4", desc: "launcher: a stale lock is treated as alive", edits: [um("lancador", 'if [ -n "$dpid" ] && kill -0 "$dpid" 2>/dev/null && [ "$(lstart_de "$dpid")" = "$dlstart" ]; then vivo=1; fi', 'if [ -n "$dpid" ]; then vivo=1; fi')], testes: [T.trava] },
  { id: "M5", desc: "script: salvar_caches without the rehearsal exit before the push", edits: [um("script", 'if [ "$MODO" = ensaio ]; then\n    registrar "ENSAIO: caches', 'if false; then\n    registrar "ENSAIO: caches')], testes: [T.ensaio] },
  { id: "M6", desc: "script: publicar_gh_pages without the rehearsal exit", edits: [um("script", 'if [ "$MODO" = ensaio ]; then\n    registrar "ENSAIO: gh-pages', 'if false; then\n    registrar "ENSAIO: gh-pages')], testes: [T.ensaio] },
  { id: "M7", desc: "script: publicar_site without requiring the green site check", edits: [um("script", 'if [ "$BUILD_OK" -eq 1 ] && [ "$FRONTEIRA_OK" -eq 1 ] && [ "$VERIF_OK" -eq 1 ]; then', 'if [ "$BUILD_OK" -eq 1 ] && [ "$FRONTEIRA_OK" -eq 1 ]; then')], testes: [T.verificacao] },
  { id: "M8", desc: "script: salvar_caches without requiring the boundary check", edits: [um("script", 'if [ "$FRONTEIRA_OK" -eq 1 ]; then passo salvar_caches salvar_caches;', 'if true; then passo salvar_caches salvar_caches;')], testes: [T.fronteira] },
  { id: "M9", desc: "script: a failing Python test does not stop the night", edits: [um("script", "passo testes_python testes_python || return $?", "passo testes_python testes_python")], testes: [T.python] },
  { id: "M10", desc: "script: the flags are added with `git add cache`", edits: [um("script", 'git add -- "$p"', "git add cache")], testes: [T.agendada] },
  { id: "M11", desc: "script: no rebase retry", edits: [um("script", 'elif ! git rebase "origin/$r"; then', "elif true; then")], testes: [T.rebase] },
  { id: "M12", desc: "script: no JSON check after the rebase", edits: [um("script", 'if [ -n "$bad" ]; then', "if false; then")], testes: [T.json] },
  { id: "M13", desc: "script: FRONT_MEMORY_WRITE=1 in --manual and --ensaio too", edits: [um("script", 'if [ "$MODO" = agendada ]; then FM=1; fi', "FM=1")], testes: [T.ensaio, T.manual] },
  { id: "M14", desc: "launcher: no masking filter on the log", edits: [um("lancador", "s/\\Q$k\\E/[TMDB]/g if length $k;", "1;")], testes: [T.chave] },
  { id: "M15", desc: "script: export TMDB_TOKEN at the top", edits: [um("script", "SEGREDO=${NOTURNA_TMDB:-}\n", 'SEGREDO=${NOTURNA_TMDB:-}\n  export TMDB_TOKEN="$SEGREDO"\n')], testes: [T.agendada] },
  { id: "M16", desc: "script: the Sunday night's commit has the previous gh-pages as parent too (the history never goes back to one commit). Redefined 21/10/2026: the text it mutated changed with the hybrid of finding B1", edits: [um("script", 'commit=$(git commit-tree "$arvore" ${PAI:+-p "$PAI"} -m', "commit=$(git commit-tree \"$arvore\" $(git rev-parse -q --verify refs/noturna/gh-pages-publicado | sed 's/^/-p /') -m")], testes: [T.paiPages] },
  { id: "M17", desc: "script: the tree comes from the clone and not from docs/", edits: [um("script", '( cd "$docs" && GIT_DIR="$NOTURNA_CLONE/.git" GIT_WORK_TREE="$docs" GIT_INDEX_FILE="$tmp/index" git add --all --force -- . )', '( cd "$NOTURNA_CLONE" && GIT_INDEX_FILE="$tmp/index" git add --all --force -- . )')], testes: [T.agendada] },
  { id: "M18", desc: "script: cache commit message without [skip ci]", edits: [um("script", 'readonly MSG_COMMIT_CACHES="Update TMDB cache [skip ci]"', 'readonly MSG_COMMIT_CACHES="Update TMDB cache"')], testes: [T.agendada, T.paridade] },
  { id: "M19", desc: "script: [skip ci] in the gh-pages message", edits: [um("script", '-m "Mood Engine site built from', '-m "[skip ci] Mood Engine site built from')], testes: [T.agendada] },
  { id: "M20", desc: "script: no local mark for the MUBI day", edits: [um("script", "printf '%s\\n' \"$hoje\" > \"$marca\"", "true")], testes: [T.mesmoDia] },
  { id: "M21", desc: "script: com_limite without the watchdog", edits: [um("script", "my $fim=time+$s;", "my $fim=time+100000;")], testes: [T.mubi] },
  { id: "M22", desc: "script and launcher: notificar does nothing", edits: [
    um("script", "notificar() { \"$NOTURNA_OSASCRIPT\"", "notificar() { true \"$NOTURNA_OSASCRIPT\""),
    um("lancador", "notificar() { \"$NOTURNA_OSASCRIPT\"", "notificar() { true \"$NOTURNA_OSASCRIPT\""),
  ], testes: [T.verificacao, T.keychain] },
  { id: "M23", desc: "script: the build subshells may ask a credential helper (GIT_ASKPASS no longer /usr/bin/false). Since the review of 21/10/2026 the NOSYSTEM part of sem_credencial is redundant (iniciar sets it for the whole night, see M31), so the original M23 would survive by design", edits: [um("script", "GIT_ASKPASS=/usr/bin/false", "GIT_ASKPASS=/usr/bin/true")], testes: [T.agendada] },
  { id: "M24", desc: "plist: RunAtLoad true", edits: [um("plist", "<key>RunAtLoad</key><false/>", "<key>RunAtLoad</key><true/>")], testes: [T.instalador], soDarwin: true },
  { id: "M28", desc: "plist: no ProcessType Background (review of 21/10/2026: the missed night runs when Marco opens the Mac)", edits: [um("plist", "  <key>ProcessType</key><string>Background</string>\n", "")], testes: [T.instalador], soDarwin: true },
  { id: "M29", desc: "script: the token is not exported to the network commands (review of 21/10/2026)", edits: [um("script", '    export NOTURNA_GH_TOKEN="$SEGREDO_GH"\n', "    true\n")], testes: [T.token] },
  { id: "M30", desc: "script: the helper list is not cleared before the token helper", edits: [um("script", "GIT_REDE=(-c \"credential.helper=\" -c '", "GIT_REDE=(-c '")], testes: [T.token] },
  { id: "M31", desc: "script and launcher: the night does not turn the system Git configuration off (the launcher alone is caught by its own local calls; the script alone survives, because the launcher exports it first)", edits: [
    um("script", "  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null\n  if [ -n \"$SEGREDO_GH\" ]", "  if [ -n \"$SEGREDO_GH\" ]"),
    um("lancador", "  export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null\n", "  export GIT_TERMINAL_PROMPT=0\n"),
  ], testes: [T.semToken, T.token] },
  { id: "M32", desc: "script: without a token the network commands do not get the system configuration back (the pushes could not authenticate)", edits: [um("script", "    unset GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_ASKPASS SSH_ASKPASS\n", "    true\n")], testes: [T.semToken] },
  { id: "M33", desc: "script: the token stays in the environment of the whole night, build included", edits: [um("script", "  SEGREDO_GH=${NOTURNA_GH_TOKEN:-}\n  unset NOTURNA_GH_TOKEN\n", "  SEGREDO_GH=${NOTURNA_GH_TOKEN:-}\n")], testes: [T.token] },
  { id: "M34", desc: "launcher: the token is not masked in the log", edits: [um("lancador", " s/\\Q$g\\E/[GITHUB]/g if length $g;", "")], testes: [T.token] },
  { id: "M35", desc: "launcher: the fetch runs without the network environment (no token; no system configuration)", edits: [um("lancador", "  ( rede_ambiente\n    com_limite \"$NOTURNA_LIMITE_FETCH_S\"", "  (\n    com_limite \"$NOTURNA_LIMITE_FETCH_S\"")], testes: [T.semToken, T.token] },
  { id: "M36", desc: "script: the cache push bypasses git_rede_limite", edits: [um("script", 'if git_rede_limite "$NOTURNA_LIMITE_PUSH_S" push origin "HEAD:refs/heads/$r"; then\n    registrar "Cache pushed"', 'if com_limite "$NOTURNA_LIMITE_PUSH_S" git push origin "HEAD:refs/heads/$r"; then\n    registrar "Cache pushed"')], testes: [T.semToken, T.token] },
  { id: "M37", desc: "launcher: a token that cannot be read does not stop the night", edits: [um("lancador", 'parar "$C_TOKEN" token', 'registrar "$C_TOKEN" token')], testes: [T.tokenFalha] },
  { id: "M38", desc: "template: the mark @TOKEN_SERVICO@ becomes an empty default, so --token-servico changes nothing", edits: [um("lancador", ': "${NOTURNA_TOKEN_SERVICO:=@TOKEN_SERVICO@}"', ': "${NOTURNA_TOKEN_SERVICO:=}"')], testes: [T.instaladorToken] },
  { id: "M39", desc: "README: the cause of the block is given as certain again", edits: [um("readme", "**The cause is not verified**", "The account ran out of GitHub Actions minutes")], testes: [T.readme] },
  { id: "M40", desc: "README: the decisions of the main session are no longer marked as awaiting Marco", edits: [um("readme", "TO CONFIRM WITH MARCO", "decided")], testes: [T.readme] },
  { id: "M41", desc: "README: the risk of having the root suite run nowhere is gone", edits: [um("readme", "**Risk of (2) and (3), to put in front of Marco:**", "**Note:**")], testes: [T.readme] },
  { id: "M42", desc: "README: the answer of the Pages research is gone (the branch route presented as settled)", edits: [um("readme", "may be refused exactly as the nightly was", "will work")], testes: [T.readme] },
  { id: "M26", desc: "script: the build's leftovers in tracked files are not restored before the rebase (beyond the 25 of the specification)", edits: [um("script", "  git reset --hard --quiet HEAD\n", "  true\n")], testes: [T.rebase] },
  { id: "M27", desc: "script: NOTURNA_BUILD=offline does not force the rehearsal (beyond the 25 of the specification)", edits: [um("script", 'if [ "${NOTURNA_BUILD:-completo}" = offline ] && [ "$MODO" != ensaio ]; then', "if false; then")], testes: [T.offline] },
  { id: "M43", desc: "script: agendada-ok-dia is written with the clock at the END of the night again (finding B2: the night that crosses midnight closed the next day)", edits: [um("script", "printf '%s\\n' \"$DIA_INICIO\" > \"$estado/agendada-ok-dia\"", "TZ=America/Sao_Paulo date +%F > \"$estado/agendada-ok-dia\"")], testes: [T.diaInicio] },
  { id: "M44", desc: "launcher: ja_rodou_hoje asks the clock again instead of using the day read at the start", edits: [um("lancador", "  hoje=$DIA_SP\n", "  hoje=$(TZ=America/Sao_Paulo date +%F)\n")], testes: [T.diaInicio] },
  { id: "M45", desc: "launcher: the day of the start is not handed to the night (it would read the clock by itself, after the launcher)", edits: [um("lancador", '  export NOTURNA_DIA_INICIO="$DIA_SP"\n', "")], testes: [T.diaInicio] },
  { id: "M46", desc: "plist: the 13:10 retry is gone", edits: [um("plist", "    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>10</integer></dict>\n", "")], testes: [T.instalador], soDarwin: true },
  { id: "M47", desc: "plist: the 20:10 retry is gone", edits: [um("plist", "    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>10</integer></dict>\n", "")], testes: [T.instalador], soDarwin: true },
  { id: "M48", desc: "launcher: the battery check also applies to --manual and --ensaio", edits: [um("lancador", '  [ "$MODO" = agendada ] || return 0\n  [ "$NOTURNA_BATERIA_MINIMA" -gt 0 ] 2>/dev/null || return 0', '  [ "$NOTURNA_BATERIA_MINIMA" -gt 0 ] 2>/dev/null || return 0')], testes: [T.bateriaManual] },
  { id: "M49", desc: "launcher: the charger is treated as battery (the percentage decides even when plugged in)", edits: [um("lancador", '    *"\'Battery Power\'"*) ;;\n    *) return 0 ;;\n  esac', "    *) ;;\n  esac")], testes: [T.bateria] },
  { id: "M50", desc: "launcher: exactly the minimum percentage is skipped (-lt becomes -le)", edits: [um("lancador", 'if [ "$pct" -lt "$NOTURNA_BATERIA_MINIMA" ]; then', 'if [ "$pct" -le "$NOTURNA_BATERIA_MINIMA" ]; then')], testes: [T.bateria] },
  { id: "M51", desc: "launcher: the battery skip is recorded as a failure, not as PULADO", edits: [um("lancador", 'pular_rodada "$C_BATERIA" bateria PULADO-BATERIA "PULADO:', 'parar "$C_BATERIA" bateria "PULADO:')], testes: [T.bateria] },
  { id: "M52", desc: "launcher: the battery skip does not notify", edits: [um("lancador", 'notificar "$4. Log:', 'true "$4. Log:')], testes: [T.bateria] },
  { id: "M53", desc: "launcher: 13:10 itself still belongs to the 06:10 window", edits: [um("lancador", 'if [ "$h" -lt 1310 ]; then', 'if [ "$h" -le 1310 ]; then')], testes: [T.janelasRelogio] },
  { id: "M54", desc: "launcher: the 20:10 window starts at 21:10", edits: [um("lancador", 'elif [ "$h" -lt 2010 ]; then', 'elif [ "$h" -lt 2110 ]; then')], testes: [T.janelasRelogio] },
  { id: "M55", desc: "script: historico.tsv loses the window column", edits: [um("script", '"${COMMIT_SITE:0:7}" "${NOTURNA_JANELA:-}" "$nota" >>', '"${COMMIT_SITE:0:7}" "" "$nota" >>')], testes: [T.janelas] },
  { id: "M56", desc: "launcher: the line of a night skipped because the day closed has no note", edits: [um("lancador", 'gravar_historico "$C_OK" PULADO-DIA-FECHADO', 'gravar_historico "$C_OK"')], testes: [T.janelas] },
  { id: "M57", desc: "launcher: the window is not handed to the night (ultima-rodada.json of the night has none)", edits: [um("lancador", '  export NOTURNA_JANELA="$JANELA"\n', "")], testes: [T.janelas] },
  { id: "M58", desc: "script: no night has a parent (the old behaviour: the whole site travels every night)", edits: [um("script", '  PAI=$ref\n  PAI_MOTIVO', '  PAI=""\n  PAI_MOTIVO')], testes: [T.paiPages] },
  { id: "M59", desc: "script: Sunday is not special (its commit keeps the parent and the history grows)", edits: [um("script", 'if [ -z "$dow" ] || [ "$dow" = 0 ]; then', 'if [ -z "$dow" ]; then')], testes: [T.paiPages] },
  { id: "M60", desc: "script: the special night is Monday, not Sunday", edits: [um("script", '[ "$dow" = 0 ]', '[ "$dow" = 1 ]')], testes: [T.paiPages] },
  { id: "M61", desc: "script: an ordinary night is forced too", edits: [um("script", '    git_rede_limite "$NOTURNA_LIMITE_PUSH_S" push --quiet origin', '    git_rede_limite "$NOTURNA_LIMITE_PUSH_S" push --force --quiet origin')], testes: [T.paiPages] },
  { id: "M62", desc: "script: the parent is used even when the origin's gh-pages is not the commit this clone published", edits: [um("script", 'if [ "$remoto" != "$ref" ]; then', "if false; then")], testes: [T.paiRemoto] },
  { id: "M63", desc: "script: the published commit is not kept locally (tomorrow has no parent)", edits: [um("script", '  git update-ref refs/noturna/gh-pages-publicado "$commit"\n', "  true\n")], testes: [T.paiPages] },
  { id: "M64", desc: "script: the weekday formula forgets the day of the month", edits: [um("script", "+ t[m - 1] + d) % 7", "+ t[m - 1]) % 7")], testes: [T.semana] },
  { id: "M65", desc: "installer: --destino not given → the default, not the installed value (finding B3)", edits: [um("instalador", 'if [ "$DESTINO_DADO" = 0 ]; then', "if false; then")], testes: [T.instaladorMantem] },
  { id: "M66", desc: "installer: --conferir-site not given → the default", edits: [um("instalador", 'if [ "$CONFERIR_DADO" = 0 ]; then', "if false; then")], testes: [T.instaladorMantem] },
  { id: "M67", desc: "installer: --token-servico not given → no token", edits: [um("instalador", 'if [ "$TOKEN_DADO" = 0 ]; then', "if false; then")], testes: [T.instaladorMantem] },
  { id: "M68", desc: "installer: what it kept is not printed", edits: [um("instalador", 'if [ -n "$MANTIDO" ]; then printf', "if false; then printf")], testes: [T.instaladorMantem] },
  { id: "M69", desc: "installer: a destination read from the installed file is accepted whatever it says", edits: [um("instalador", "case \"$v\" in gh-pages|nenhum) DESTINO=$v;", "case \"$v\" in *) DESTINO=$v;")], testes: [T.instaladorMantem] },
  { id: "M70", desc: "installer: the copy of a replaced file stays next to it again (finding C6)", edits: [um("instalador", '    copia="$ANTERIORES/$(basename "$destino").anterior-$(date +%Y%m%d-%H%M%S)"\n    while', '    copia="$destino.anterior-$(date +%Y%m%d-%H%M%S)"\n    while')], testes: [T.instaladorAnteriores] },
  { id: "M71", desc: "installer: the old copies left next to the originals are not moved", edits: [um("instalador", 'if [ -f "$velho" ]; then mv', 'if false; then mv')], testes: [T.instaladorAnteriores] },
  { id: "M72", desc: "installer: two copies with the same stamp overwrite each other", edits: [um("instalador", 'while [ -e "$copia" ]; do', "while false; do")], testes: [T.instaladorAnteriores] },
  { id: "M73", desc: "installer: the daytime rehearsal is printed without taskpolicy -b (finding C7)", edits: [um("instalador", "ensaio, de dia, no Terminal:   taskpolicy -b %s/bin/noturna-mood-engine --ensaio", "ensaio, de dia, no Terminal:   %s/bin/noturna-mood-engine --ensaio")], testes: [T.instaladorAnteriores] },
  { id: "M74", desc: "installer: the rehearsal in launchd's environment is printed with kickstart -k (it would kill a night in progress)", edits: [um("instalador", "launchctl kickstart gui/$(id -u)/com.marco.noturna-mood-engine\\n' \"$ESTADO_DIR\"", "launchctl kickstart -k gui/$(id -u)/com.marco.noturna-mood-engine\\n' \"$ESTADO_DIR\"")], testes: [T.instaladorAnteriores] },
  { id: "M75", desc: "launcher: proximo-modo is not consumed", edits: [um("lancador", "tr -d '[:space:]')\n  rm -f \"$f\"\n", "tr -d '[:space:]')\n")], testes: [T.proximoModo] },
  { id: "M76", desc: "launcher: an old proximo-modo is honoured (no age limit)", edits: [um("lancador", 'if [ -n "$(find "$f" -mmin +"$NOTURNA_PROXIMO_MODO_MIN" 2>/dev/null)" ]; then', "if false; then")], testes: [T.proximoModo] },
  { id: "M77", desc: "launcher: --manual consumes proximo-modo too", edits: [um("lancador", '  [ "$MODO" = agendada ] || return 0\n  [ -f "$f" ] || return 0', '  [ -f "$f" ] || return 0')], testes: [T.proximoModo] },
  { id: "M78", desc: "launcher: any content of proximo-modo turns the night into a rehearsal", edits: [um("lancador", 'if [ "$conteudo" = ensaio ]; then\n    MODO=ensaio', 'if true; then\n    MODO=ensaio')], testes: [T.proximoModo] },
  { id: "M79", desc: "launcher: a signal does not end the job being waited for (the night's group survives; finding C1)", edits: [um("lancador", 'if [ "$alvo" -gt 1 ]; then matar_grupo "$alvo" "$NOTURNA_GRACA_TERM_S"; fi', "true")], testes: [T.sigterm] },
  { id: "M80", desc: "script: the TERM handler of the night does not end the command under the limit (it sits in a group of its own and survives)", edits: [um("script", '  matar_limitado\n  falhar "$C_INTERROMPIDA"', '  falhar "$C_INTERROMPIDA"')], testes: [T.sigterm] },
  { id: "M81", desc: "launcher: no trap for TERM (the launcher dies at once, without cleaning or recording)", edits: [um("lancador", "  trap 'interromper TERM' TERM\n", "")], testes: [T.sigterm, T.sigtermFetch] },
  { id: "M82", desc: "launcher: an interruption before the night started leaves no history line", edits: [um("lancador", '    gravar_historico "$C_INTERROMPIDA" INTERROMPIDA\n', "")], testes: [T.sigtermFetch] },
  { id: "M83", desc: "launcher: no job control (set -m): the background jobs share the launcher's group and the group kill finds nothing", edits: [um("lancador", "  set -m\n  limpar_ambiente", "  limpar_ambiente")], testes: [T.sigterm] },
  { id: "M84", desc: "launcher: the maximum age of the lock is ignored (a hung night holds every later one)", edits: [um("lancador", 'if [ "$idade" -gt "$NOTURNA_TRAVA_IDADE_MAX_S" ]; then', "if false; then")], testes: [T.travaVencida] },
  { id: "M85", desc: "launcher: a recorded group is ended without checking the start time of its leader (a reused pid would be killed)", edits: [um("lancador", 'if [ "$(lstart_de "$1")" = "$2" ] && kill -0 -- "-$1" 2>/dev/null; then', 'if kill -0 -- "-$1" 2>/dev/null; then')], testes: [T.travaVelha] },
  { id: "M86", desc: "launcher: a stale lock does not end the groups its owner left", edits: [um("lancador", '      matar_orfaos "$trava" "$gpid" "$glstart"\n', "")], testes: [T.travaVelha] },
  { id: "M87", desc: "launcher: the night's group is not recorded in the lock", edits: [um("lancador", `  printf '%s\\t%s\\n' "$pid" "$(lstart_de "$pid")" >> "$NOTURNA_TRAVA/dono"\n`, "")], testes: [T.sigterm] },
  { id: "M88", desc: "script: com_limite does not record the group of the command in the lock", edits: [um("script", 'if [ -d "${NOTURNA_TRAVA:-/nonexistent}" ]; then printf', "if false; then printf")], testes: [T.sigterm] },
  { id: "M89", desc: "script: the watchdog of com_limite does not look at the night (a command outlives a night that was killed)", edits: [um("script", "if (!kill 0, $dono) {", "if (0) {")], testes: [T.scriptMorto] },
  { id: "M90", desc: "script: limitado does not say that the limit ended the step", edits: [um("script", 'if [ "$rc" -eq 124 ]; then falhar "$cod" "$texto (passou', 'if false; then falhar "$cod" "$texto (passou')], testes: [T.passosLimite] },
  { id: "M91", desc: "script: the Python tests have no time limit", edits: [um("script", 'limitado "$C_TESTES_PY" "$NOTURNA_LIMITE_PY_S"', 'limitado "$C_TESTES_PY" 100000')], testes: [T.passosLimite] },
  { id: "M92", desc: "script: build-people.js has no time limit", edits: [um("script", 'com_limite "$NOTURNA_LIMITE_PEOPLE_S"', "com_limite 100000")], testes: [T.passosLimite] },
  { id: "M93", desc: "script: the boundary check has no time limit", edits: [um("script", 'limitado "$C_FRONTEIRA" "$NOTURNA_LIMITE_FRONTEIRA_S"', 'limitado "$C_FRONTEIRA" 100000')], testes: [T.passosLimite] },
  { id: "M94", desc: "script: verify.js has no time limit", edits: [um("script", 'limitado "$C_VERIFY" "$NOTURNA_LIMITE_VERIFY_S"', 'limitado "$C_VERIFY" 100000')], testes: [T.passosLimite] },
  { id: "M95", desc: "script: the seen-film guard has no time limit", edits: [um("script", 'limitado "$C_GUARDA" "$NOTURNA_LIMITE_VERIFY_S"', 'limitado "$C_GUARDA" 100000')], testes: [T.passosLimite] },
  { id: "M96", desc: "script: verify-public has no time limit", edits: [um("script", 'limitado "$C_PUBLICO" "$NOTURNA_LIMITE_VERIFY_S"', 'limitado "$C_PUBLICO" 100000')], testes: [T.passosLimite] },
  { id: "M97", desc: "launcher: the fetch has no time limit", edits: [um("lancador", 'com_limite "$NOTURNA_LIMITE_FETCH_S" git -C', 'com_limite 100000 git -C')], testes: [T.fetchLimite] },
  { id: "M98", desc: "script: the fetch after a rejected push has no time limit", edits: [um("script", 'git_rede_limite "$NOTURNA_LIMITE_REDE_S" fetch origin', "git_rede fetch origin")], testes: [T.fetchLimite] },
  { id: "M99", desc: "script: the ls-remote before the gh-pages commit has no time limit", edits: [um("script", 'saida=$(git_rede_limite "$NOTURNA_LIMITE_REDE_S" ls-remote origin refs/heads/gh-pages)\n  rc=$?', 'saida=$(git_rede ls-remote origin refs/heads/gh-pages)\n  rc=$?')], testes: [T.fetchLimite] },
  { id: "M100", desc: "script: the ls-remote that checks the update has no time limit", edits: [um("script", 'remoto=$(git_rede_limite "$NOTURNA_LIMITE_REDE_S" ls-remote origin refs/heads/gh-pages | cut -f1)\n  if [ "$remoto" != "$commit" ]', 'remoto=$(git_rede ls-remote origin refs/heads/gh-pages | cut -f1)\n  if [ "$remoto" != "$commit" ]')], testes: [T.fetchLimite] },
  { id: "M101", desc: "plist: ExitTimeOut shorter than the launcher's own shutdown (launchd would KILL it in the middle)", edits: [um("plist", "<key>ExitTimeOut</key><integer>60</integer>", "<key>ExitTimeOut</key><integer>30</integer>")], testes: [T.exitTimeout], soDarwin: true },
  { id: "M102", desc: "launcher: an orphan index.lock is not removed (finding C3)", edits: [um("lancador", '  rm -f "$lock"\n', "  true\n")], testes: [T.indexLock] },
  { id: "M103", desc: "launcher: index.lock is removed even with a Git process alive in the clone", edits: [um("lancador", '  if git_vivo_no_clone; then\n    registrar "INDEX.LOCK: ', '  if false; then\n    registrar "INDEX.LOCK: ')], testes: [T.indexLock] },
  { id: "M104", desc: "launcher: the message of Git's checkout does not go to the dated log", edits: [um("lancador", 'checkout --quiet --force -B "$r" "origin/$r" >> "$NOTURNA_LOG" 2>&1', 'checkout --quiet --force -B "$r" "origin/$r"')], testes: [T.indexLock] },
  { id: "M105", desc: "launcher: the night runs without caffeinate -i (the Mac may idle-sleep in the middle of it; it survived the first round)", edits: [um("lancador", '"$NOTURNA_CAFFEINATE" -i /bin/bash', '"$NOTURNA_CAFFEINATE" /bin/bash')], testes: [T.caffeinate] },
  { id: "M106", desc: "launcher: log cleanup of +0 days (every log older than a day goes; it survived the first round)", edits: [um("lancador", "-mtime +30 -delete", "-mtime +0 -delete")], testes: [T.faxina] },
  { id: "M107", desc: "launcher: log cleanup of +90 days (nothing is ever cleaned in practice)", edits: [um("lancador", "-mtime +30 -delete", "-mtime +90 -delete")], testes: [T.faxina] },
  { id: "M108", desc: "launcher: the start time is read in the Mac's own zone again while the night writes it in UTC (re-verification, MEDIUM 1: the orphan build of the step under the limit survived)", edits: [um("lancador", 'lstart_de() { TZ=UTC ps -o lstart= -p "$1"', 'lstart_de() { ps -o lstart= -p "$1"')], testes: [T.fusoLimite] },
  { id: "M109", desc: "script: com_limite writes the start time in the machine's zone (no TZ=UTC) while the launcher reads it in UTC", edits: [um("script", '"$(TZ=UTC ps -o lstart= -p "$pid"', '"$(env -u TZ ps -o lstart= -p "$pid"')], testes: [T.fusoLimite] },
  { id: "M110", desc: "launcher: the fetch under `perl alarm` again (SIGALRM ends git alone; the transport child holds the pipe of the log; re-verification, MEDIUM 2)", edits: [
    um("lancador", '    com_limite "$NOTURNA_LIMITE_FETCH_S" git -C', "    /usr/bin/perl -e 'alarm shift; exec @ARGV' \"$NOTURNA_LIMITE_FETCH_S\" git -C"),
    um("lancador", 'if [ "$rc" -eq 124 ]; then\n    parar "$C_REDE" rede "FETCH: git fetch passou', 'if [ "$rc" -eq 142 ]; then\n    parar "$C_REDE" rede "FETCH: git fetch passou'),
  ], testes: [T.fetchGrupo, T.fetchKill9, T.sigtermFetch] },
  { id: "M111", desc: "launcher: a signal does not end the command that is under a limit (the fetch sits in a group of its own and survives)", edits: [um("lancador", '  matar_orfaos "$NOTURNA_TRAVA" "" ""\n', "")], testes: [T.sigtermFetch] },
  { id: "M112", desc: "launcher: the watchdog of the fetch does not look at the launcher (a fetch outlives a launcher killed with KILL)", edits: [um("lancador", "if (!kill 0, $dono) {", "if (0) {")], testes: [T.fetchKill9] },
  { id: "M113", desc: "launcher: the group of the command under a limit is not recorded in the lock", edits: [um("lancador", 'if [ -d "${NOTURNA_TRAVA:-/nonexistent}" ]; then printf', 'if false; then printf')], testes: [T.sigtermFetch] },
  { id: "M114", desc: "launcher: the orphan index.lock is removed AFTER the aborts of rebase and merge (the abort fails without a word and the old rebase stays; re-verification, LOW 3)", edits: [um("lancador", '  limpar_index_lock\n  git -C "$c" rebase --abort >/dev/null 2>&1\n  git -C "$c" merge --abort >/dev/null 2>&1\n', '  git -C "$c" rebase --abort >/dev/null 2>&1\n  git -C "$c" merge --abort >/dev/null 2>&1\n  limpar_index_lock\n')], testes: [T.rebaseMeio] },
  { id: "M115", desc: "launcher: the default maximum age of the lock is a year (a hung night holds every later one; re-verification, LOW 4: only the tests that set the variable were guarding it)", edits: [um("lancador", ': "${NOTURNA_TRAVA_IDADE_MAX_S:=21600}"', ': "${NOTURNA_TRAVA_IDADE_MAX_S:=31536000}"')], testes: [T.travaPadrao] },
  { id: "M116", desc: "launcher: the default maximum age of the lock is 10 minutes (a night that is working is ended)", edits: [um("lancador", ': "${NOTURNA_TRAVA_IDADE_MAX_S:=21600}"', ': "${NOTURNA_TRAVA_IDADE_MAX_S:=600}"')], testes: [T.travaPadrao] },
  { id: "M117", desc: "script: a gh-pages branch that does not exist is logged as 'não lido' (a failure of the network) again (re-verification, LOW 9)", edits: [um("script", 'lido="não existe"', 'lido="não lido"')], testes: [T.naoExiste] },
  { id: "M118", desc: "launcher: an interruption notifies twice (the night's closing step already did) (re-verification, LOW 9)", edits: [um("lancador", '    gravar_historico "$C_INTERROMPIDA" INTERROMPIDA\n    notificar "Rodada interrompida por sinal $1. Log: $(basename "${NOTURNA_LOG:-sem-log}")"\n  fi\n', '    gravar_historico "$C_INTERROMPIDA" INTERROMPIDA\n  fi\n  notificar "Rodada interrompida por sinal $1. Log: $(basename "${NOTURNA_LOG:-sem-log}")"\n')], testes: [T.sigterm] },
  { id: "M119", desc: "script: the list of headless Chromes left alive is written only after a build that succeeded (the old behaviour: the case of the README sentence, the build ended by its limit, listed nothing; re-verification, LOW 7)", edits: [um("script", '  rc=$?\n  avisar_chromes\n', '  rc=$?\n  if [ "$rc" -eq 0 ]; then avisar_chromes; fi\n')], testes: [T.chromesLimite] },
  { id: "M120", desc: "README: the 6 hours of the lock are presented as decided again (re-verification, LOW 8)", edits: [um("readme", "the 6 hours are chosen by the session, to confirm with Marco (BACKLOG 21/10/2026)", "the 6 hours are settled")], testes: [T.readmeEscolhas] },
  { id: "M121", desc: "README: code 16 is presented as decided again (re-verification, LOW 8)", edits: [um("readme", "keeping code 16 is chosen by the session, to confirm with Marco (BACKLOG 21/10/2026)", "code 16 is settled")], testes: [T.readmeEscolhas] },
  { id: "M122", desc: "README: the unsourced 35 to 76 minutes of a night are back (re-verification, LOW 6)", edits: [um("readme", "a night is expected to take about 10 minutes on an ordinary day and about 35 on the weekly night, an estimate from the GitHub runs, not measured on the Mac; the 42 to 76 minutes of the runs above include the root suite, which the Mac does not run", "a normal night takes 35 to 76 minutes")], testes: [T.readmeEscolhas] },
  { id: "M123", desc: "script: the watchdog of com_limite does not end by itself when its command is gone (a TERM lost before the watchdog's exec made a step that had succeeded wait for its limit and return 124; found in the mutation run of round 3)", edits: [um("script", " exit 0 if !kill 0, $p;", "")], testes: [T.vigiaPerdido] },
  { id: "M124", desc: "launcher: the same, in the launcher's com_limite (the fetch)", edits: [um("lancador", " exit 0 if !kill 0, $p;", "")], testes: [T.vigiaPerdido] },
  // 14/11/2026: the memory of Tonight (lib/tonight-memory.js) is written by every night that PUBLISHES: TONIGHT_MEMORY_WRITE=1 in --agendada and --manual, empty in a rehearsal (review of the Tonight branch, R5)
  { id: "M125", desc: "script: TONIGHT_MEMORY_WRITE=1 in --ensaio too (a rehearsal records a Tonight nobody saw)", edits: [um("script", 'if [ "$MODO" = agendada ] || [ "$MODO" = manual ]; then TM=1; fi', "TM=1")], testes: [T.ensaio] },
  { id: "M126", desc: "script: --manual publishes Tonight and does not record it (the switch follows the front memory's)", edits: [um("script", 'if [ "$MODO" = agendada ] || [ "$MODO" = manual ]; then TM=1; fi', 'if [ "$MODO" = agendada ]; then TM=1; fi')], testes: [T.manual] },
  { id: "M127", desc: "script: the build does not receive TONIGHT_MEMORY_WRITE", edits: [um("script", ' TONIGHT_MEMORY_WRITE="$TM"\n      sem_credencial\n      com_limite "$NOTURNA_LIMITE_BUILD_S" "$NOTURNA_NODE" build.js --out', '\n      sem_credencial\n      com_limite "$NOTURNA_LIMITE_BUILD_S" "$NOTURNA_NODE" build.js --out')], testes: [T.agendada, T.manual] },
  // 15/11/2026: the memory of Tonight reaches main only AFTER the site is published (the night of 15/11 saved it with the caches and then failed to publish), and the MUBI step reads the Board of the last published site
  { id: "M128", desc: "script: salvar_caches commits the memory of Tonight with the other caches, before the publication (the defect of 15/11/2026)", edits: [um("script", '    [ "$f" = "$CACHE_DEPOIS_DE_PUBLICAR" ] && continue', "    true")], testes: [T.memNaoPublica, T.memSegunda, T.memPub] },
  { id: "M129", desc: "script: the memory of Tonight is sent even when nothing was published", edits: [um("script", 'if [ -n "$COMMIT_SITE" ]; then passo salvar_memoria_tonight', "if true; then passo salvar_memoria_tonight")], testes: [T.memNaoPublica, T.memSegunda] },
  { id: "M130", desc: "script: after the publication the memory of Tonight is never sent", edits: [um("script", 'if [ -n "$COMMIT_SITE" ]; then passo salvar_memoria_tonight', "if false; then passo salvar_memoria_tonight")], testes: [T.memPub, T.memSegunda] },
  { id: "M131", desc: "script: the loss of the day's memory is silent (no warning 53, no line in the log)", edits: [um("script", '  ressalvar "$C_TONIGHT_MEMORIA" "$perda"\n', '  : "$C_TONIGHT_MEMORIA" "$perda"\n')], testes: [T.memPerdida] },
  { id: "M140", desc: "script: with another warning first (the 52 of the caches), the closing line and the notification do not say that the memory of Tonight was lost", edits: [um("script", '  if [ "$RESSALVA_COD" != "$C_TONIGHT_MEMORIA" ]; then RESSALVA_TXT="$RESSALVA_TXT; E TAMBÉM (aviso $C_TONIGHT_MEMORIA) $perda"; fi\n', "")], testes: [T.memDois] },
  { id: "M141", desc: "script: the loss of the memory of Tonight takes the night's code from the warning that came first", edits: [um("script", '  ressalvar "$C_TONIGHT_MEMORIA" "$perda"\n', '  RESSALVA_COD=$C_TONIGHT_MEMORIA; RESSALVA_TXT=$perda; registrar "$perda"\n')], testes: [T.memDois] },
  { id: "M132", desc: "script: the memory commit sits on HEAD, so a cache commit that was kept back (the warning 52) is sent along with it", edits: [um("script", '-p "$base" -m "$MSG_COMMIT_TONIGHT"', '-p "$(git rev-parse HEAD)" -m "$MSG_COMMIT_TONIGHT"')], testes: [T.memRetida] },
  { id: "M133", desc: "script: the memory commit carries no [skip ci]", edits: [um("script", 'readonly MSG_COMMIT_TONIGHT="Update Tonight memory [skip ci]"', 'readonly MSG_COMMIT_TONIGHT="Update Tonight memory"')], testes: [T.memPub] },
  { id: "M134", desc: "script: a rejected push of the memory is not tried again", edits: [um("script", 'if [ "$n" -ge 2 ]; then motivo="a $r recusou', 'if [ "$n" -ge 1 ]; then motivo="a $r recusou')], testes: [T.memRetry, T.memPerdida] },
  { id: "M135", desc: "script: the step takes the working file (which salvar_caches put back to main's) instead of the copy the boundary check accepted", edits: [um("script", 'origem=".context/noturna/cache-stage/cache/$CACHE_DEPOIS_DE_PUBLICAR"', 'origem="cache/$CACHE_DEPOIS_DE_PUBLICAR"')], testes: [T.memPub] },
  { id: "M136", desc: "script: the push of the memory of Tonight has no time limit", edits: [um("script", 'if git_rede_limite "$NOTURNA_LIMITE_PUSH_S" push --quiet origin "$commit:refs/heads/$r"; then', 'if git_rede push --quiet origin "$commit:refs/heads/$r"; then')], testes: [T.memRetry] },
  { id: "M139", desc: "script: the fetch of main's tip before the memory commit has no time limit", edits: [um("script", 'if ! git_rede_limite "${NOTURNA_LIMITE_REDE_S}" fetch origin', "if ! git_rede fetch origin")], testes: [T.memRetry] },
  { id: "M137", desc: "script: the MUBI step never hands the published Board over (always the offline build, which has not ended inside its limit since 30/10/2026)", edits: [um("script", 'if git cat-file -e "refs/noturna/gh-pages-publicado:data/index-board.json" 2>/dev/null && ', "if false && ")], testes: [T.mubiBoard] },
  { id: "M138", desc: "script: the MUBI step hands over the Board of a site that has none (an empty file)", edits: [um("script", 'if git cat-file -e "refs/noturna/gh-pages-publicado:data/index-board.json" 2>/dev/null && git show', "if git show"), um("script", ' && [ -s "$indice" ]; then', "; then")], testes: [T.mubiVazio] },
  { id: "M25", desc: "launcher: the key is read before the battery and disk checks", edits: [um("lancador", "  ja_rodou_hoje\n  verificar_bateria\n", "  ja_rodou_hoje\n  ler_chave\n  verificar_bateria\n")], testes: [T.disco] },
];

function rodarSuite({ padroes = [], env = {} } = {}) {
  const args = ["--test", "--test-concurrency=3", "--test-timeout=900000", "--test-reporter=tap", ...padroes.map((p) => `--test-name-pattern=${p}`), path.join(ROOT, "test", "noturna-mac.test.js")];
  const comando = process.platform === "darwin" ? "taskpolicy" : process.execPath;
  const todos = process.platform === "darwin" ? ["-b", "nice", "-n", "19", process.execPath, ...args] : args;
  const r = spawnSync(comando, todos, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, cwd: ROOT });
  const saida = (r.stdout || "") + (r.stderr || "");
  const vermelhos = [...saida.matchAll(/^ {4,}not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  return { status: r.status, vermelhos, saida };
}

// 15/11/2026 (second review of the nightly branch): EVERY MUTATION STARTS FROM THE ORIGINAL. Until then this function read the copy of the folder when one was already there
// (`fs.existsSync(destino) ? fs.readFileSync(destino) : original`), which was meant for the second edit of ONE mutation in the same file, and the folder is the same for the whole run: each
// mutation ran on top of every mutation applied before it to that file. A run of several ids could therefore call a mutation dead that survives alone (M138 after M137, found by that review)
// and call one alive that dies alone (M126 after M125). The receipts written before this date with more than one id in a run are not reliable one by one; the whole list was run again.
// Now the edits of one mutation pile up in memory, from the original, and the copy is written once; a file an earlier mutation copied and this one does not touch is removed, so that no
// leftover is ever pointed at. Each edit must still find its text exactly once in the original, and must find it in what the earlier edits of the same mutation left.
function aplicar(m, pasta) {
  const env = {}, textos = new Map();
  for (const antigo of fs.readdirSync(pasta)) fs.rmSync(path.join(pasta, antigo), { force: true });
  for (const e of m.edits) {
    const f = ARQUIVOS[e.arquivo];
    const original = fs.readFileSync(f.caminho, "utf8");
    const partes = original.split(e.procura);
    if (partes.length !== 2) return { erro: `MUTAÇÃO NÃO APLICÁVEL: ${partes.length - 1} ocorrências de ${JSON.stringify(e.procura.slice(0, 70))} em ${e.arquivo}` };
    const destino = path.join(pasta, `${e.arquivo}-${path.basename(f.caminho)}`);
    const atual = textos.has(destino) ? textos.get(destino) : original;
    if (!atual.includes(e.procura)) return { erro: `MUTAÇÃO NÃO APLICÁVEL: a edição anterior desta mesma mutação tirou ${JSON.stringify(e.procura.slice(0, 70))} de ${e.arquivo}` };
    textos.set(destino, atual.split(e.procura).join(e.troca));
    env[f.env] = destino;
  }
  for (const [destino, texto] of textos) fs.writeFileSync(destino, texto);
  return { env };
}

function main() {
  const args = process.argv.slice(2);
  const so = args.includes("--so") ? new Set(args[args.indexOf("--so") + 1].split(",")) : null;
  if (!args.includes("--sem-base")) {
    const base = rodarSuite();
    if (base.status !== 0) {
      console.log(`bateria original: VERMELHA (${base.vermelhos.length} testes) — abortando\n${base.vermelhos.join("\n")}`);
      process.exit(1);
    }
    console.log("bateria original: verde");
  }
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "noturna-mutacoes-"));
  let mortas = 0, total = 0, puladas = 0;
  const sobreviventes = [];
  try {
    for (const m of MUTACOES) {
      if (so && !so.has(m.id)) continue;
      if (m.soDarwin && process.platform !== "darwin") { puladas++; console.log(`${m.id} pulada (não-darwin): ${m.desc}`); continue; }
      total++;
      const a = aplicar(m, pasta);
      if (a.erro) { console.log(`${m.id} ${a.erro}`); sobreviventes.push(m.id); continue; }
      const r = rodarSuite({ padroes: m.testes, env: a.env });
      const esperados = r.vermelhos.filter((nome) => m.testes.some((p) => new RegExp(p).test(nome)));
      if (r.status !== 0 && esperados.length > 0) { mortas++; console.log(`${m.id} morta (${r.vermelhos.length} testes vermelhos: ${r.vermelhos.map((n) => n.slice(0, 40)).join(" | ")}) — ${m.desc}`); }
      else if (r.status !== 0) { console.log(`${m.id} morta por outro teste (${r.vermelhos.join(" | ")}), não pelos esperados — ${m.desc}`); sobreviventes.push(m.id); }
      else { console.log(`${m.id} SOBREVIVEU — ${m.desc}`); sobreviventes.push(m.id); }
    }
  } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
  console.log(`${mortas} de ${total} mortas${puladas ? `, ${puladas} pulada(s) (não-darwin)` : ""}${sobreviventes.length ? `; sobreviventes: ${sobreviventes.join(", ")}` : ""}`);
  process.exit(sobreviventes.length ? 1 : 0);
}

main();
