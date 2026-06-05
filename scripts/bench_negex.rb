#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/bench_negex.rb — Tier B #8 validation.
#
# A/B: current CoT prompt (no negative examples) vs CoT with anchored
# anti-patterns and a parallel "preferí" block. Reuses the cot variant
# from tmp/cot_candidates/ as the no-negex baseline.
#
# Holds extractor fixed (gemma4:latest), single-shot extraction (no
# self-consistency) for cheap iteration. Judges: mistral-small + qwen2.5:14b.

require 'json'
require 'fileutils'
require_relative 'ingest'
require_relative 'judge_pipeline'

EXTRACTOR  = 'gemma4:latest'
SET_JUDGES = %w[mistral-small:latest qwen2.5:14b]

NEGEX_DIR = File.expand_path('../tmp/negex_candidates', __dir__)
COT_DIR   = File.expand_path('../tmp/cot_candidates', __dir__)

def extract_negex(song, db, force: false)
  FileUtils.mkdir_p(NEGEX_DIR)
  path = File.join(NEGEX_DIR, "#{File.basename(song['file'], '.json')}__negex.json")
  if !force && File.exist?(path)
    cached = JSON.parse(File.read(path))
    return cached if cached['fragments']&.any?
  end
  artist = db['artists'].find { |a| a['id'] == song['artistId'] }
  ollama = Ollama.new(base_url: OLLAMA_URL, model: EXTRACTOR)
  t0 = Time.now
  frags = begin
            select_fragments_with_llm(ollama,
              title: song['title'], artist: artist['displayName'], lyric: song['lyric'],
              prompt_template: COT_NEGEX_PROMPT_TEMPLATE)
          rescue StandardError => e
            $stderr.puts "    FAILED: #{e.message}"
            []
          end
  out = {
    'model'     => EXTRACTOR,
    'variant'   => 'cot_negex',
    'fragments' => frags,
    'latency_s' => Time.now - t0,
  }
  out['code_score'] = code_scores(frags, song['lyric'], title: song['title'])
  File.write(path, JSON.pretty_generate(out) + "\n")
  out
end

def load_cot_baseline(song)
  path = File.join(COT_DIR, "#{File.basename(song['file'], '.json')}__cot.json")
  return nil unless File.exist?(path)
  doc = JSON.parse(File.read(path))
  doc['model']   = EXTRACTOR
  doc['variant'] = 'cot'
  doc['code_score'] ||= code_scores(doc['fragments'], song['lyric'], title: song['title'])
  doc
end

db    = JSON.parse(File.read(DB_PATH))
songs = SAMPLES.map { |p| JSON.parse(File.read(p)).merge('file' => File.basename(p)) }

abort "extractor #{EXTRACTOR} not reachable" unless Ollama.new(base_url: OLLAMA_URL, model: EXTRACTOR).reachable?
SET_JUDGES.each { |j| abort "judge #{j} not reachable" unless Ollama.new(base_url: OLLAMA_URL, model: j).reachable? }

rows = []
songs.each do |song|
  $stderr.puts
  $stderr.puts "── #{song['title']} ──"

  negex = extract_negex(song, db)
  cot   = load_cot_baseline(song)

  if negex['fragments'].empty?
    $stderr.puts '  negex empty, skipping'
    next
  end
  if cot.nil? || cot['fragments'].empty?
    $stderr.puts '  no cot baseline cached, skipping'
    next
  end

  SET_JUDGES.each do |judge|
    [cot, negex].each do |cand|
      $stderr.puts "  judge #{judge} on #{cand['variant']}"
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
    cot   = rs.find { |r| r['judge'] == judge && r['variant'] == 'cot' }
    negex = rs.find { |r| r['judge'] == judge && r['variant'] == 'cot_negex' }
    next unless cot && negex
    delta = negex['composite'] - cot['composite']
    arrow = delta.positive? ? '↑' : (delta.negative? ? '↓' : '=')
    printf "  judge=%-22s cot=%2d  negex=%2d  delta=%+d %s\n",
      judge, cot['composite'], negex['composite'], delta, arrow
  end
end

puts
puts '════════════════════════ Aggregate ════════════════════════'
SET_JUDGES.each do |judge|
  rs = rows.select { |r| r['judge'] == judge }
  cot_sum   = rs.select { |r| r['variant'] == 'cot' }.sum { |r| r['composite'] }
  negex_sum = rs.select { |r| r['variant'] == 'cot_negex' }.sum { |r| r['composite'] }
  n = rs.size / 2
  printf "  judge=%-22s cot=%4d  negex=%4d  delta=%+d  (n=%d)\n",
    judge, cot_sum, negex_sum, negex_sum - cot_sum, n
end

puts
puts '════════════════════════ Per-dimension (negex − cot) ════════════════════════'
DIMENSIONS.each do |d|
  cot_sum   = rows.select { |r| r['variant'] == 'cot' }.sum { |r| r['scores'][d] }
  negex_sum = rows.select { |r| r['variant'] == 'cot_negex' }.sum { |r| r['scores'][d] }
  delta = negex_sum - cot_sum
  arrow = delta.positive? ? '↑' : (delta.negative? ? '↓' : '=')
  printf "  %-15s cot=%3d  negex=%3d  delta=%+d %s\n", d, cot_sum, negex_sum, delta, arrow
end

puts
puts '════════════════════════ Win count ════════════════════════'
wins = { 'cot' => 0, 'cot_negex' => 0, 'tie' => 0 }
songs.each do |song|
  SET_JUDGES.each do |judge|
    rs = rows.select { |r| r['song'] == song['title'] && r['judge'] == judge }
    cot   = rs.find { |r| r['variant'] == 'cot' }
    negex = rs.find { |r| r['variant'] == 'cot_negex' }
    next unless cot && negex
    if negex['composite'] > cot['composite']
      wins['cot_negex'] += 1
    elsif cot['composite'] > negex['composite']
      wins['cot'] += 1
    else
      wins['tie'] += 1
    end
  end
end
puts "  cot wins:    #{wins['cot']}"
puts "  cot_negex:   #{wins['cot_negex']}"
puts "  ties:        #{wins['tie']}"

out_dir  = File.expand_path('../tmp/judgments', __dir__)
FileUtils.mkdir_p(out_dir)
out_path = File.join(out_dir, "negex_#{Time.now.strftime('%Y%m%d_%H%M%S')}.json")
File.write(out_path, JSON.pretty_generate(rows) + "\n")
puts
puts "wrote #{out_path}"
