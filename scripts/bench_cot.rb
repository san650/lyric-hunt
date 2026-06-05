#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/bench_cot.rb — A/B test the baseline vs CoT extractor prompt.
#
# Holds extractor fixed (gemma4:latest, the per-cell winner from the
# 12-song matrix) and judge set fixed (mistral-small + qwen2.5:14b, the
# two judges with best inter-rater alignment). For each of 12 sample
# songs, generate fragments with BOTH prompts and score both sets with
# both judges. Reports per-song composite delta and per-dimension delta.
#
# Caches per-variant candidates in tmp/cot_candidates/.

require 'json'
require 'fileutils'
require_relative 'ingest'
require_relative 'judge_pipeline'

EXTRACTOR     = 'gemma4:latest'
JUDGES        = %w[mistral-small:latest qwen2.5:14b]
COT_CACHE_DIR = File.expand_path('../tmp/cot_candidates', __dir__)

VARIANTS = {
  'baseline' => PROMPT_TEMPLATE,
  'cot'      => COT_PROMPT_TEMPLATE,
}.freeze

def extract_variant(song, db, prompt_template, variant_name)
  FileUtils.mkdir_p(COT_CACHE_DIR)
  path = File.join(COT_CACHE_DIR, "#{File.basename(song['file'], '.json')}__#{variant_name}.json")
  if File.exist?(path)
    cached = JSON.parse(File.read(path))
    return cached if cached['fragments']&.any?
  end
  artist = db['artists'].find { |a| a['id'] == song['artistId'] }
  ollama = Ollama.new(base_url: OLLAMA_URL, model: EXTRACTOR)
  t0 = Time.now
  frags = begin
            select_fragments_with_llm(ollama,
              title: song['title'], artist: artist['displayName'], lyric: song['lyric'],
              prompt_template: prompt_template)
          rescue StandardError => e
            $stderr.puts "    FAILED #{variant_name}: #{e.message}"
            []
          end
  out = {
    'model'      => EXTRACTOR,
    'variant'    => variant_name,
    'fragments'  => frags,
    'latency_s'  => Time.now - t0,
    'code_score' => code_scores(frags, song['lyric'], title: song['title']),
  }
  File.write(path, JSON.pretty_generate(out) + "\n")
  out
end

db    = JSON.parse(File.read(DB_PATH))
songs = SAMPLES.map { |p| JSON.parse(File.read(p)).merge('file' => File.basename(p)) }

JUDGES.each do |j|
  abort "judge #{j} not reachable" unless Ollama.new(base_url: OLLAMA_URL, model: j).reachable?
end
abort "extractor #{EXTRACTOR} not reachable" unless Ollama.new(base_url: OLLAMA_URL, model: EXTRACTOR).reachable?

rows = []
songs.each do |song|
  $stderr.puts
  $stderr.puts "── #{song['title']} ──"
  by_variant = {}
  VARIANTS.each do |name, template|
    $stderr.puts "  extract #{name}"
    by_variant[name] = extract_variant(song, db, template, name)
  end

  JUDGES.each do |judge|
    by_variant.each do |name, cand|
      next if cand['fragments'].empty?
      $stderr.puts "  judge #{judge} on #{name}"
      j = score_set(judge, song, cand, db)
      j['variant']     = name
      j['code_score']  = cand['code_score']
      rows << j
    end
  end
end

# ── Per-song report ──────────────────────────────────────────────
puts
puts '════════════════════════ Per-song composites ════════════════════════'
songs.each do |song|
  puts
  puts "═══ #{song['title']} ═══"
  song_rows = rows.select { |r| r['song'] == song['title'] }
  JUDGES.each do |judge|
    rs = song_rows.select { |r| r['judge'] == judge }
    bl = rs.find { |r| r['variant'] == 'baseline' }
    co = rs.find { |r| r['variant'] == 'cot' }
    next unless bl && co
    delta = co['composite'] - bl['composite']
    arrow = delta.positive? ? '↑' : (delta.negative? ? '↓' : '=')
    printf "  judge=%-22s baseline=%2d  cot=%2d  delta=%+d %s\n",
      judge, bl['composite'], co['composite'], delta, arrow
  end
end

# ── Aggregate ────────────────────────────────────────────────────
puts
puts '════════════════════════ Aggregate ════════════════════════'
JUDGES.each do |judge|
  rs = rows.select { |r| r['judge'] == judge }
  bl_sum = rs.select { |r| r['variant'] == 'baseline' }.sum { |r| r['composite'] }
  co_sum = rs.select { |r| r['variant'] == 'cot' }.sum { |r| r['composite'] }
  n = rs.size / 2
  delta = co_sum - bl_sum
  printf "  judge=%-22s baseline=%4d  cot=%4d  delta=%+d  (n=%d songs)\n",
    judge, bl_sum, co_sum, delta, n
end

# ── Per-dimension breakdown ──────────────────────────────────────
puts
puts '════════════════════════ Per-dimension delta (cot − baseline, summed across all judges×songs) ════════════════════════'
DIMENSIONS.each do |d|
  bl_sum = rows.select { |r| r['variant'] == 'baseline' }.sum { |r| r['scores'][d] }
  co_sum = rows.select { |r| r['variant'] == 'cot' }.sum { |r| r['scores'][d] }
  delta = co_sum - bl_sum
  arrow = delta.positive? ? '↑' : (delta.negative? ? '↓' : '=')
  printf "  %-15s baseline=%3d  cot=%3d  delta=%+d %s\n", d, bl_sum, co_sum, delta, arrow
end

# ── Win count ────────────────────────────────────────────────────
puts
puts '════════════════════════ Win count (per judge×song cells) ════════════════════════'
wins = { 'baseline' => 0, 'cot' => 0, 'tie' => 0 }
songs.each do |song|
  JUDGES.each do |judge|
    rs = rows.select { |r| r['song'] == song['title'] && r['judge'] == judge }
    bl = rs.find { |r| r['variant'] == 'baseline' }
    co = rs.find { |r| r['variant'] == 'cot' }
    next unless bl && co
    if co['composite'] > bl['composite']
      wins['cot'] += 1
    elsif bl['composite'] > co['composite']
      wins['baseline'] += 1
    else
      wins['tie'] += 1
    end
  end
end
puts "  baseline wins: #{wins['baseline']}"
puts "  cot wins:      #{wins['cot']}"
puts "  ties:          #{wins['tie']}"

# Save raw
out_dir = File.expand_path('../tmp/judgments', __dir__)
FileUtils.mkdir_p(out_dir)
out_path = File.join(out_dir, "cot_#{Time.now.strftime('%Y%m%d_%H%M%S')}.json")
File.write(out_path, JSON.pretty_generate(rows) + "\n")
puts
puts "wrote #{out_path}"
