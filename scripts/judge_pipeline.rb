#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/judge_pipeline.rb — multi-model extractor × multi-model judge
# matrix. Each model can play either role. Self-judgments are skipped
# to neutralize in-family bias.
#
# Flow per song:
#   1. Every MODELS entry generates fragments. Cached in
#      tmp/candidates/<song>.json so iterating on the judge prompt does
#      not re-run extraction.
#   2. Code-verifiable scores computed: verbatim fidelity (substring vs
#      lyric), count_ok, length_ok, intra-set redundancy.
#   3. Each judge model scores every other model's set with the rubric
#      (1-5 per dimension, anchored examples, strict JSON).
#   4. Composite = iconicidad*2 + distintividad*2 + coherencia +
#      cobertura + estructural. Verbatim/redundancy NOT judged
#      (verifiable in code). Per (judge, song) we rank generators by
#      composite. Cross-judge agreement on top-1 is reported.
#
# Usage:
#   ruby scripts/judge_pipeline.rb
#   ruby scripts/judge_pipeline.rb --regen
#   ruby scripts/judge_pipeline.rb --skip-model llama3.3:70b

require 'json'
require 'fileutils'
require 'digest'
require_relative 'ingest'

MODELS = %w[
  gemma4:latest
  mistral-small:latest
  qwen2.5:14b
  llama3.3:70b
]

SAMPLES = %w[
  2-minutos__cancion-de-amor.json
  4-pesos-de-propina__pirata.json
  andres-calamaro__flaca.json
  andres-calamaro__estadio-azteca.json
  angeles-azules__17-anos.json
  astroboy__facil.json
  cuarteto-de-nos__el-empleado-y-la-muerte.json
  cuarteto-de-nos__al-cielo-no.json
  damas-gratis__no-te-creas-tan-importante.json
  damas-gratis__los-duenos-de-pabellon.json
  julieta-venegas__me-voy.json
  julieta-venegas__limon-y-sal.json
].map { |f| File.expand_path("../tmp/lyrics/#{f}", __dir__) }

DB_PATH    = File.expand_path('../db.json', __dir__)
CACHE_DIR  = File.expand_path('../tmp/candidates', __dir__)
JUDGE_DIR  = File.expand_path('../tmp/judgments', __dir__)
OLLAMA_URL = 'http://localhost:11434'

WEIGHTS = {
  'iconicidad'    => 2,
  'distintividad' => 2,
  'coherencia'    => 1,
  'cobertura'     => 1,
  'estructural'   => 1,
}.freeze
DIMENSIONS    = WEIGHTS.keys
MAX_COMPOSITE = WEIGHTS.values.sum * 5  # 35

# ── Code-verifiable scoring ──────────────────────────────────────

# Speaker tags in dialogue lyrics ("[Muerte]", "Barrancas:") are decorative.
# Extractors may legitimately drop them to compose tighter fragments. Strip
# both source and fragment before the verbatim substring check so this
# rewrite is not flagged as hallucination.
def strip_speaker_tags(text)
  text.to_s.lines.map { |ln|
    ln.sub(/\A\s*\[[^\]]+\]\s*/, '')                 # [Muerte]
      .sub(/\A\s*[A-ZÁÉÍÓÚÑ][\wáéíóúñ]*\s*:\s+/, '') # Barrancas:
  }.join
end

def norm_text(s)
  s.to_s.unicode_normalize(:nfd).gsub(/\p{Mn}/, '').downcase
   .gsub(/[^a-z0-9]+/, ' ').gsub(/\s+/, ' ').strip
end

def verbatim_rate(fragments, lyric)
  haystack = norm_text(strip_speaker_tags(lyric))
  return 0.0 if fragments.empty?
  fragments.count { |f| haystack.include?(norm_text(strip_speaker_tags(f))) }.to_f / fragments.size
end

def redundancy_score(fragments)
  return 0.0 if fragments.size < 2
  norms = fragments.map { |f| norm_text(f) }
  pairs = redundant = 0
  norms.combination(2) do |a, b|
    pairs += 1
    redundant += 1 if a.include?(b) || b.include?(a)
  end
  pairs.zero? ? 0.0 : redundant.to_f / pairs
end

# 1.0 if any fragment's normalized text contains the normalized song title
# (decorative parens stripped). 0.0 otherwise. The title-bearing line is by
# definition the most recognizable; this surfaces sets that miss it.
def title_match_rate(fragments, title)
  return nil if title.to_s.strip.empty?
  bare = title.gsub(/\s*\([^)]*\)\s*/, ' ').gsub(/\s+/, ' ').strip
  nt = norm_text(strip_speaker_tags(bare))
  return nil if nt.empty?
  fragments.any? { |f| norm_text(strip_speaker_tags(f)).include?(nt) } ? 1.0 : 0.0
end

def code_scores(fragments, lyric, title: nil)
  out = {
    'count'      => fragments.size,
    'count_ok'   => (FRAGMENT_MIN_COUNT..FRAGMENT_MAX_COUNT).cover?(fragments.size),
    'length_ok'  => fragments.all? { |f| (FRAGMENT_MIN_LEN..FRAGMENT_MAX_LEN).cover?(f.length) },
    'verbatim'   => verbatim_rate(fragments, lyric),
    'redundancy' => redundancy_score(fragments),
  }
  tm = title_match_rate(fragments, title) unless title.nil?
  out['title_match'] = tm unless tm.nil?
  out
end

# ── Extractor stage (cached) ─────────────────────────────────────

def cache_path(song_file)
  File.join(CACHE_DIR, "#{File.basename(song_file, '.json')}.json")
end

# Returns { 'candidates' => [ {model, fragments, latency_s, code_score}, ... ] }
def generate_for_song(song, db, models, force: false)
  FileUtils.mkdir_p(CACHE_DIR)
  path = cache_path(song['file'])
  cache = File.exist?(path) ? JSON.parse(File.read(path)) : nil
  cache ||= { 'song' => song['title'], 'artistId' => song['artistId'],
              'file' => song['file'], 'candidates' => [] }
  existing = cache['candidates'].each_with_object({}) { |c, h| h[c['model']] = c }
  artist   = db['artists'].find { |a| a['id'] == song['artistId'] }

  models.each do |model|
    if !force && existing[model] && !existing[model]['fragments'].empty?
      # Re-score with current metric definitions; fragments don't change.
      existing[model]['code_score'] = code_scores(existing[model]['fragments'], song['lyric'], title: song['title'])
      next
    end
    ollama = Ollama.new(base_url: OLLAMA_URL, model: model)
    unless ollama.reachable?
      $stderr.puts "  gen #{model} :: unreachable, skip"
      next
    end
    $stderr.puts "  gen #{model} :: #{song['title']}"
    t0 = Time.now
    frags = begin
              select_fragments_with_llm(ollama,
                title: song['title'], artist: artist['displayName'], lyric: song['lyric'])
            rescue StandardError => e
              $stderr.puts "    FAILED: #{e.message}"
              []
            end
    existing[model] = {
      'model'      => model,
      'fragments'  => frags,
      'latency_s'  => Time.now - t0,
      'code_score' => code_scores(frags, song['lyric'], title: song['title']),
    }
  end

  cache['candidates'] = models.map { |m| existing[m] }.compact
  File.write(path, JSON.pretty_generate(cache) + "\n")
  cache
end

# ── Judge stage ──────────────────────────────────────────────────

JUDGE_PROMPT = <<~PROMPT
  Sos un editor experto de un juego de adivinar canciones en español.
  El jugador ve un fragmento de letra y tiene que adivinar a qué artista pertenece.
  Por lo tanto, buenos fragmentos son los que un fan reconocería al instante
  como pertenecientes a esa canción y a ese artista — no versos genéricos.

  Vas a evaluar UNA selección de fragmentos. Asigná un puntaje de 1 a 5
  en cada dimensión. Sé estricto: usá toda la escala. Anclajes:

  ICONICIDAD — ¿Un fan reconocería estos versos como de ESTA canción específica?
    1 = versos genéricos, podrían ser de cualquier canción.
    3 = mezclados: algunos icónicos, otros relleno.
    5 = todos son hooks, frases marca de la canción.

  DISTINTIVIDAD — ¿Los fragmentos identifican al ARTISTA por estilo, vocabulario, temática?
    1 = podrían ser de cualquier cantante en español.
    3 = algunos marcadores estilísticos del artista.
    5 = vocabulario, voseo/lunfardo, referencias culturales muy del artista.

  COHERENCIA — Los fragmentos multi-línea, ¿se leen como unidades coherentes?
    1 = cortes arbitrarios a mitad de pensamiento.
    3 = algunos coherentes, otros mal cortados.
    5 = cada fragmento multi-línea es una unidad semántica completa.

  COBERTURA — ¿Los fragmentos cubren distintas secciones de la letra?
    1 = todos de una sola estrofa.
    3 = cubren parcialmente la letra.
    5 = estrofa, estribillo, puente, etc. bien distribuidos.

  ESTRUCTURAL — Para canciones con diálogo, estribillo repetido, llamada-respuesta:
    1 = ignora la estructura (estribillo repetido N veces, diálogo perdido).
    3 = parcialmente.
    5 = estribillo aparece una vez, diálogo preservado, estructura respetada.

  Devolvé EXCLUSIVAMENTE JSON con esta forma exacta:
  {
    "iconicidad": N,
    "distintividad": N,
    "coherencia": N,
    "cobertura": N,
    "estructural": N,
    "razon": "una oración breve"
  }

  Canción: %<title>s
  Artista: %<artist>s

  Letra completa:
  %<lyric>s

  Fragmentos a evaluar:
  %<block>s
PROMPT

def render_block(fragments)
  fragments.each_with_index.map { |f, i| "[#{i + 1}] #{f}" }.join("\n\n")
end

def parse_judge(raw)
  obj = JSON.parse(raw)
  DIMENSIONS.each do |d|
    v = obj[d]
    raise "#{d} not integer 1-5: #{v.inspect}" unless v.is_a?(Integer) && (1..5).cover?(v)
  end
  obj
end

def composite(scores)
  WEIGHTS.sum { |dim, w| w * scores[dim] }
end

def score_set(judge_model, song, candidate, db, max_retries: 3)
  artist = db['artists'].find { |a| a['id'] == song['artistId'] }
  prompt = format(JUDGE_PROMPT,
    title:  song['title'], artist: artist['displayName'],
    lyric:  song['lyric'], block: render_block(candidate['fragments']))

  ollama = Ollama.new(base_url: OLLAMA_URL, model: judge_model)
  t0 = Time.now
  parsed = nil
  err = nil
  max_retries.times do |attempt|
    raw = ollama.complete(prompt)
    begin
      parsed = parse_judge(raw)
      break
    rescue StandardError => e
      err = e
      $stderr.puts "    judge #{judge_model} attempt #{attempt + 1}: #{e.message}"
    end
  end
  raise "judge #{judge_model} gave up: #{err&.message}" unless parsed
  {
    'judge'        => judge_model,
    'generator'    => candidate['model'],
    'song'         => song['title'],
    'scores'       => parsed,
    'composite'    => composite(parsed),
    'composite_max'=> MAX_COMPOSITE,
    'latency_s'    => Time.now - t0,
  }
end

# ── Per-fragment judge (Tier A #4) ───────────────────────────────

PER_FRAGMENT_JUDGE_PROMPT = <<~PROMPT
  Sos un editor experto. El jugador ve UN fragmento de letra y adivina el artista.
  Calificá este fragmento de 1 a 5 en cada dimensión. Anclajes:

  ICONICIDAD — ¿Un fan reconocería este verso como de ESTA canción específica?
    1 = genérico, podría ser cualquier canción
    3 = parcialmente reconocible
    5 = hook icónico, frase marca de la canción

  DISTINTIVIDAD — ¿Identifica al ARTISTA por estilo, vocabulario, temática?
    1 = cualquier cantante en español
    3 = algunos marcadores estilísticos del artista
    5 = vocabulario, voseo/lunfardo, referencias culturales muy del artista

  COHERENCIA — ¿Se lee como una unidad semántica completa?
    1 = corte arbitrario, sin sentido por sí solo
    3 = parcialmente coherente
    5 = unidad semántica completa

  Devolvé EXCLUSIVAMENTE JSON con esta forma:
  { "iconicidad": N, "distintividad": N, "coherencia": N }

  Canción: %<title>s
  Artista: %<artist>s

  Letra completa (referencia):
  %<lyric>s

  Fragmento a calificar:
  %<fragment>s
PROMPT

FRAG_WEIGHTS = { 'iconicidad' => 2, 'distintividad' => 2, 'coherencia' => 1 }.freeze
FRAG_DIMENSIONS = FRAG_WEIGHTS.keys
FRAG_MAX_COMPOSITE = FRAG_WEIGHTS.values.sum * 5  # 25

def score_fragment(judge_model, song, fragment, db, max_retries: 3)
  artist = db['artists'].find { |a| a['id'] == song['artistId'] }
  prompt = format(PER_FRAGMENT_JUDGE_PROMPT,
    title:    song['title'], artist: artist['displayName'],
    lyric:    song['lyric'], fragment: fragment)
  ollama = Ollama.new(base_url: OLLAMA_URL, model: judge_model)
  parsed = nil
  err    = nil
  max_retries.times do |attempt|
    raw = ollama.complete(prompt)
    begin
      obj = JSON.parse(raw)
      FRAG_DIMENSIONS.each do |d|
        v = obj[d]
        raise "#{d} not integer 1-5: #{v.inspect}" unless v.is_a?(Integer) && (1..5).cover?(v)
      end
      parsed = obj
      break
    rescue StandardError => e
      err = e
      $stderr.puts "    frag-judge #{judge_model} attempt #{attempt + 1}: #{e.message}"
    end
  end
  raise "frag-judge #{judge_model} gave up: #{err&.message}" unless parsed
  composite = FRAG_WEIGHTS.sum { |d, w| w * parsed[d] }
  parsed.merge('composite' => composite, 'composite_max' => FRAG_MAX_COMPOSITE, 'fragment' => fragment)
end

# ── Reporting ────────────────────────────────────────────────────

def print_song_report(song, candidates_doc, judgments_for_song)
  puts
  puts "═══════ #{song['title']}  (#{song['artistId']}) ═══════"
  puts '  -- generators --'
  candidates_doc['candidates'].each do |c|
    cs = c['code_score']
    tm = cs['title_match']
    tm_str = tm.nil? ? '-' : (tm.zero? ? 'N' : 'Y')
    printf "  %-22s n=%-2s verbatim=%.2f redund=%.2f len_ok=%s title=%s  %.1fs\n",
      c['model'][0, 22], cs['count'], cs['verbatim'], cs['redundancy'],
      (cs['length_ok'] ? 'Y' : 'N'), tm_str, c['latency_s']
  end
  judges = judgments_for_song.map { |j| j['judge'] }.uniq
  judges.each do |judge|
    puts
    puts "  -- judge: #{judge} --"
    rows = judgments_for_song.select { |j| j['judge'] == judge }
    rows.sort_by { |r| -r['composite'] }.each_with_index do |r, i|
      crown = i.zero? ? '★ ' : '  '
      printf "  %s%-22s comp=%2d/%d  ", crown, r['generator'][0, 22], r['composite'], r['composite_max']
      DIMENSIONS.each { |d| printf "%s=%d ", d[0, 3], r['scores'][d] }
      printf " (%.1fs)\n", r['latency_s']
      puts "      razon: #{r['scores']['razon']}"
    end
  end
end

def print_summary(all_judgments, songs)
  puts
  puts '════════════════════════ Summary ════════════════════════'
  puts

  # Per (judge) ranking of generators across all songs (sum of composites)
  by_judge = all_judgments.group_by { |j| j['judge'] }
  puts '## Per-judge generator ranking (sum of composites across songs)'
  by_judge.each do |judge, js|
    by_gen = js.group_by { |x| x['generator'] }.transform_values { |xs| xs.sum { |x| x['composite'] } }
    sorted = by_gen.sort_by { |_, v| -v }
    avg_lat = js.sum { |j| j['latency_s'] } / js.size
    puts
    puts "judge: #{judge}  (#{format('%.1f', avg_lat)}s/call avg)"
    sorted.each_with_index do |(gen, sum), i|
      crown = i.zero? ? '★' : ' '
      printf "  %s %-22s total=%3d\n", crown, gen[0, 22], sum
    end
  end

  # Per-song top pick by each judge (where do judges agree?)
  puts
  puts '## Inter-judge agreement on top-pick per song'
  songs.each do |song|
    title = song['title']
    picks = by_judge.map do |judge, js|
      js_song = js.select { |j| j['song'] == title }
      top = js_song.max_by { |j| j['composite'] }
      [judge, top&.dig('generator')]
    end
    pick_set = picks.map(&:last).compact.uniq
    label = pick_set.size == 1 ? 'AGREE' : "DISAGREE(#{pick_set.size})"
    puts "  #{title[0, 50].ljust(50)} #{label}"
    picks.each { |judge, gen| puts "    #{judge.ljust(22)} → #{gen}" }
  end

  # Overall: count of top-pick votes per generator across all (judge, song)
  puts
  puts '## Overall: top-1 votes per generator (across all judge×song cells)'
  by_song_judge = all_judgments.group_by { |j| [j['song'], j['judge']] }
  votes = Hash.new(0)
  by_song_judge.each do |_, js|
    top = js.max_by { |j| j['composite'] }
    votes[top['generator']] += 1
  end
  votes.sort_by { |_, v| -v }.each { |gen, n| printf "  %-22s %2d votes\n", gen, n }
end

# ── Main ─────────────────────────────────────────────────────────

if __FILE__ == $PROGRAM_NAME

skip_models = []
force_regen = false
args = ARGV.dup
while (a = args.shift)
  case a
  when '--regen'      then force_regen = true
  when '--skip-model' then skip_models << args.shift
  else abort "unexpected arg: #{a}"
  end
end

models = MODELS - skip_models

# Reachability check — skip silently any model not pulled, warn loud
reachable_models = models.select do |m|
  ok = Ollama.new(base_url: OLLAMA_URL, model: m).reachable?
  $stderr.puts "WARN: #{m} not reachable / not pulled — excluded from run" unless ok
  ok
end
abort "no reachable models" if reachable_models.empty?

db    = JSON.parse(File.read(DB_PATH))
songs = SAMPLES.map { |p| JSON.parse(File.read(p)).merge('file' => File.basename(p)) }

FileUtils.mkdir_p(JUDGE_DIR)
all_judgments = []

songs.each do |song|
  $stderr.puts
  $stderr.puts "── #{song['title']} ──"
  candidates_doc = generate_for_song(song, db, reachable_models, force: force_regen)

  judgments_for_song = []
  reachable_models.each do |judge_model|
    candidates_doc['candidates'].each do |cand|
      next if cand['fragments'].empty?
      next if cand['model'] == judge_model  # skip self-judgment

      $stderr.puts "  judge #{judge_model} on #{cand['model']}"
      j = score_set(judge_model, song, cand, db)
      judgments_for_song << j
    end
  end
  all_judgments.concat(judgments_for_song)
  print_song_report(song, candidates_doc, judgments_for_song)
end

print_summary(all_judgments, songs)

out_path = File.join(JUDGE_DIR, "run_#{Time.now.strftime('%Y%m%d_%H%M%S')}.json")
File.write(out_path, JSON.pretty_generate(all_judgments) + "\n")
puts
puts "wrote #{out_path}"

end  # if __FILE__ == $PROGRAM_NAME
