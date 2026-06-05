#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/bench_large_pool.rb — Tier A #4 validation.
#
# A/B: current CoT default (5-8 fragments from one extractor call) vs
# large-pool + per-fragment judge filter (12-15 → top 6 by composite).
#
# Holds extractor fixed (gemma4:latest) and per-fragment judge fixed
# (mistral-small:latest — best inter-rater consensus from the matrix).
# Set-level judges (the rubric judges that score the kept set) are
# mistral-small + qwen2.5:14b, the same A/B reviewers as bench_cot.rb.

require 'json'
require 'fileutils'
require_relative 'ingest'
require_relative 'judge_pipeline'

EXTRACTOR    = 'gemma4:latest'
FRAG_JUDGE   = 'mistral-small:latest'
SET_JUDGES   = %w[mistral-small:latest qwen2.5:14b]
TARGET_KEEP  = 6

POOL_DIR     = File.expand_path('../tmp/lp_candidates', __dir__)
COT_DIR      = File.expand_path('../tmp/cot_candidates', __dir__)

def extract_pool(song, db, force: false)
  FileUtils.mkdir_p(POOL_DIR)
  path = File.join(POOL_DIR, "#{File.basename(song['file'], '.json')}__pool.json")
  if !force && File.exist?(path)
    cached = JSON.parse(File.read(path))
    return cached if cached['fragments']&.any?
  end
  artist = db['artists'].find { |a| a['id'] == song['artistId'] }
  ollama = Ollama.new(base_url: OLLAMA_URL, model: EXTRACTOR)
  $stderr.puts '  extract pool'
  t0 = Time.now
  frags = begin
            select_fragments_large_pool(ollama,
              title: song['title'], artist: artist['displayName'], lyric: song['lyric'])
          rescue StandardError => e
            $stderr.puts "    FAILED: #{e.message}"
            []
          end
  out = { 'model' => EXTRACTOR, 'fragments' => frags, 'latency_s' => Time.now - t0 }
  File.write(path, JSON.pretty_generate(out) + "\n")
  out
end

def filter_pool(song, pool, db, force: false)
  path = File.join(POOL_DIR, "#{File.basename(song['file'], '.json')}__filtered.json")
  if !force && File.exist?(path)
    cached = JSON.parse(File.read(path))
    return cached if cached['fragments']&.any?
  end
  scored = pool['fragments'].each_with_index.map do |f, i|
    $stderr.puts "    score frag #{i + 1}/#{pool['fragments'].size}"
    score_fragment(FRAG_JUDGE, song, f, db)
  end
  sorted = scored.sort_by { |s| -s['composite'] }
  kept   = sorted.first(TARGET_KEEP)
  out = {
    'model'           => EXTRACTOR,
    'variant'         => 'large_pool_filtered',
    'fragments'       => kept.map { |s| s['fragment'] },
    'kept_scores'     => kept,
    'rejected_scores' => sorted.drop(TARGET_KEEP),
  }
  out['code_score'] = code_scores(out['fragments'], song['lyric'], title: song['title'])
  File.write(path, JSON.pretty_generate(out) + "\n")
  out
end

# Comparison baseline: the cot variant from the bench_cot.rb v2 run.
def load_cot_baseline(song)
  path = File.join(COT_DIR, "#{File.basename(song['file'], '.json')}__cot.json")
  return nil unless File.exist?(path)
  doc = JSON.parse(File.read(path))
  doc['model']   = EXTRACTOR
  doc['variant'] = 'cot'
  doc['code_score'] ||= code_scores(doc['fragments'], song['lyric'], title: song['title'])
  doc
end

# ── Main ─────────────────────────────────────────────────────────

db    = JSON.parse(File.read(DB_PATH))
songs = SAMPLES.map { |p| JSON.parse(File.read(p)).merge('file' => File.basename(p)) }

abort "extractor #{EXTRACTOR} not reachable" unless Ollama.new(base_url: OLLAMA_URL, model: EXTRACTOR).reachable?
abort "frag-judge #{FRAG_JUDGE} not reachable" unless Ollama.new(base_url: OLLAMA_URL, model: FRAG_JUDGE).reachable?
SET_JUDGES.each { |j| abort "set-judge #{j} not reachable" unless Ollama.new(base_url: OLLAMA_URL, model: j).reachable? }

rows = []
songs.each do |song|
  $stderr.puts
  $stderr.puts "── #{song['title']} ──"

  pool = extract_pool(song, db)
  if pool['fragments'].empty?
    $stderr.puts '  pool empty, skipping'
    next
  end
  filtered = filter_pool(song, pool, db)

  cot = load_cot_baseline(song)
  if cot.nil? || cot['fragments'].empty?
    $stderr.puts '  no cot baseline cached, skipping'
    next
  end

  SET_JUDGES.each do |judge|
    [cot, filtered].each do |cand|
      $stderr.puts "  set-judge #{judge} on #{cand['variant']}"
      j = score_set(judge, song, cand, db)
      j['variant'] = cand['variant']
      rows << j
    end
  end
end

# ── Report ───────────────────────────────────────────────────────

puts
puts '════════════════════════ Per-song composites ════════════════════════'
songs.each do |song|
  rs = rows.select { |r| r['song'] == song['title'] }
  next if rs.empty?
  puts
  puts "═══ #{song['title']} ═══"
  SET_JUDGES.each do |judge|
    cot = rs.find { |r| r['judge'] == judge && r['variant'] == 'cot' }
    lp  = rs.find { |r| r['judge'] == judge && r['variant'] == 'large_pool_filtered' }
    next unless cot && lp
    delta = lp['composite'] - cot['composite']
    arrow = delta.positive? ? '↑' : (delta.negative? ? '↓' : '=')
    printf "  judge=%-22s cot=%2d  large_pool=%2d  delta=%+d %s\n",
      judge, cot['composite'], lp['composite'], delta, arrow
  end
end

puts
puts '════════════════════════ Aggregate ════════════════════════'
SET_JUDGES.each do |judge|
  rs = rows.select { |r| r['judge'] == judge }
  cot_sum = rs.select { |r| r['variant'] == 'cot' }.sum { |r| r['composite'] }
  lp_sum  = rs.select { |r| r['variant'] == 'large_pool_filtered' }.sum { |r| r['composite'] }
  n = rs.size / 2
  printf "  judge=%-22s cot=%4d  large_pool=%4d  delta=%+d  (n=%d)\n",
    judge, cot_sum, lp_sum, lp_sum - cot_sum, n
end

puts
puts '════════════════════════ Per-dimension (large_pool − cot) ════════════════════════'
DIMENSIONS.each do |d|
  cot_sum = rows.select { |r| r['variant'] == 'cot' }.sum { |r| r['scores'][d] }
  lp_sum  = rows.select { |r| r['variant'] == 'large_pool_filtered' }.sum { |r| r['scores'][d] }
  delta = lp_sum - cot_sum
  arrow = delta.positive? ? '↑' : (delta.negative? ? '↓' : '=')
  printf "  %-15s cot=%3d  large_pool=%3d  delta=%+d %s\n", d, cot_sum, lp_sum, delta, arrow
end

puts
puts '════════════════════════ Win count ════════════════════════'
wins = { 'cot' => 0, 'large_pool_filtered' => 0, 'tie' => 0 }
songs.each do |song|
  SET_JUDGES.each do |judge|
    rs = rows.select { |r| r['song'] == song['title'] && r['judge'] == judge }
    cot = rs.find { |r| r['variant'] == 'cot' }
    lp  = rs.find { |r| r['variant'] == 'large_pool_filtered' }
    next unless cot && lp
    if lp['composite'] > cot['composite']
      wins['large_pool_filtered'] += 1
    elsif cot['composite'] > lp['composite']
      wins['cot'] += 1
    else
      wins['tie'] += 1
    end
  end
end
puts "  cot wins:                #{wins['cot']}"
puts "  large_pool_filtered:     #{wins['large_pool_filtered']}"
puts "  ties:                    #{wins['tie']}"

out_dir  = File.expand_path('../tmp/judgments', __dir__)
FileUtils.mkdir_p(out_dir)
out_path = File.join(out_dir, "lp_#{Time.now.strftime('%Y%m%d_%H%M%S')}.json")
File.write(out_path, JSON.pretty_generate(rows) + "\n")
puts
puts "wrote #{out_path}"
