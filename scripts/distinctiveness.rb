#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/distinctiveness.rb — cross-artist distinctiveness analyzer.
#
# For each candidate fragment in tmp/candidates/*.json, compute the
# fraction of its word 3-grams that also appear in fragments belonging
# to OTHER artists in db.json. High overlap = generic ("te amo te
# quiero"-type); low overlap = distinctive of the artist.
#
# Reports:
#   1. Per-(song, extractor) mean/min/max overlap.
#   2. Per-extractor average distinctiveness across all cached samples.
#   3. The most-generic fragments observed (worst offenders).
#   4. Correlation with judge top-1 votes from the latest judge run
#      (does distinctiveness predict judge preference?).
#
# Usage:
#   ruby scripts/distinctiveness.rb
#   ruby scripts/distinctiveness.rb --n 4    # change n-gram size
#   ruby scripts/distinctiveness.rb --judge-run tmp/judgments/run_X.json

require 'json'
require 'set'

DB_PATH    = File.expand_path('../db.json', __dir__)
CACHE_DIR  = File.expand_path('../tmp/candidates', __dir__)
JUDGE_DIR  = File.expand_path('../tmp/judgments', __dir__)

# ── Normalization (same approach as ingest.rb / judge_pipeline.rb) ──

def strip_speaker_tags(text)
  text.to_s.lines.map { |ln|
    ln.sub(/\A\s*\[[^\]]+\]\s*/, '')
      .sub(/\A\s*[A-ZÁÉÍÓÚÑ][\wáéíóúñ]*\s*:\s+/, '')
  }.join
end

def norm_words(s)
  s.to_s.unicode_normalize(:nfd).gsub(/\p{Mn}/, '').downcase
   .gsub(/[^a-z0-9]+/, ' ').split
end

def ngrams(text, n)
  words = norm_words(strip_speaker_tags(text))
  return [] if words.size < n
  (0..words.size - n).map { |i| words[i, n].join(' ') }
end

# ── Index build ──────────────────────────────────────────────────

# Returns { artistId => Set<ngram> } from existing curated fragments.
def build_ngram_index(db, n)
  by_artist = Hash.new { |h, k| h[k] = Set.new }
  db['songs'].each do |s|
    next unless s['fragments'].is_a?(Array)
    s['fragments'].each do |f|
      ngrams(f, n).each { |g| by_artist[s['artistId']] << g }
    end
  end
  by_artist
end

# Fraction of `fragment`'s n-grams that appear in some OTHER artist's set.
# 0.0 = every n-gram is unique to this artist (distinctive).
# 1.0 = every n-gram also appears in another artist (generic).
def overlap_fraction(fragment, artist_id, by_artist, n)
  grams = ngrams(fragment, n)
  return nil if grams.empty?  # too short for n-grams
  others = by_artist.reject { |k, _| k == artist_id }.values
  hits = grams.count { |g| others.any? { |s| s.include?(g) } }
  hits.to_f / grams.size
end

# Returns the OTHER artists in which a given n-gram appears.
def other_artists_with(gram, artist_id, by_artist)
  by_artist.select { |k, s| k != artist_id && s.include?(gram) }.keys
end

# ── Candidate-side analysis ──────────────────────────────────────

# Returns per-fragment overlap details for one candidate set.
def analyze_candidate(candidate, artist_id, by_artist, n)
  rows = candidate['fragments'].map do |frag|
    ov = overlap_fraction(frag, artist_id, by_artist, n)
    grams = ngrams(frag, n)
    matched = grams.select { |g| by_artist.any? { |k, s| k != artist_id && s.include?(g) } }
    { 'fragment' => frag, 'overlap' => ov, 'ngrams' => grams.size, 'matched' => matched }
  end
  valid = rows.map { |r| r['overlap'] }.compact
  {
    'model'    => candidate['model'],
    'mean'     => valid.empty? ? nil : valid.sum / valid.size,
    'max'      => valid.empty? ? nil : valid.max,
    'min'      => valid.empty? ? nil : valid.min,
    'distinct' => valid.empty? ? nil : 1.0 - (valid.sum / valid.size),
    'rows'     => rows,
  }
end

# ── Reporting ────────────────────────────────────────────────────

def print_song_report(song_doc, results)
  puts
  puts "═══ #{song_doc['song']}  (#{song_doc['artistId']}) ═══"
  results.each do |r|
    next if r['mean'].nil?
    printf "  %-22s overlap mean=%.2f max=%.2f min=%.2f  distinct=%.2f\n",
      r['model'][0, 22], r['mean'], r['max'], r['min'], r['distinct']
  end
end

def print_extractor_summary(by_extractor)
  puts
  puts '════════════════ Extractor distinctiveness ════════════════'
  printf "  %-22s  songs  mean-overlap  distinct\n", 'model'
  rows = by_extractor.map do |model, ms|
    valid = ms.compact
    next nil if valid.empty?
    avg = valid.sum / valid.size
    [model, valid.size, avg, 1.0 - avg]
  end.compact.sort_by { |_, _, avg, _| avg }  # lowest overlap = best
  rows.each do |model, n, avg, dist|
    crown = model == rows.first[0] ? '★' : ' '
    printf "  %s %-22s  %3d    %.3f         %.3f\n", crown, model[0, 22], n, avg, dist
  end
end

def print_worst_fragments(all_rows, k: 10)
  puts
  puts "════════════════ #{k} most-generic fragments observed ════════════════"
  ranked = all_rows.compact.reject { |r| r['overlap'].nil? }
                   .sort_by { |r| -r['overlap'] }
                   .first(k)
  ranked.each do |r|
    printf "  overlap=%.2f (%d/%d 3-grams shared)  [%s :: %s]\n",
      r['overlap'], r['matched'].size, r['ngrams'],
      r['song'], r['model'][0, 14]
    puts "    #{r['fragment'].gsub("\n", ' / ')[0, 100]}"
  end
end

def print_judge_correlation(by_extractor, judge_run_path)
  return unless File.exist?(judge_run_path.to_s)
  judgments = JSON.parse(File.read(judge_run_path))

  # Top-1 votes per extractor (across all judge×song cells)
  by_song_judge = judgments.group_by { |j| [j['song'], j['judge']] }
  votes = Hash.new(0)
  by_song_judge.each do |_, js|
    top = js.max_by { |j| j['composite'] }
    votes[top['generator']] += 1 if top
  end

  puts
  puts '════════════════ Distinctiveness vs judge top-1 votes ════════════════'
  printf "  %-22s  votes  mean-overlap  distinct\n", 'model'
  rows = by_extractor.map do |model, ms|
    valid = ms.compact
    next nil if valid.empty?
    avg = valid.sum / valid.size
    [model, votes[model] || 0, avg, 1.0 - avg]
  end.compact.sort_by { |_, v, _, _| -v }
  rows.each do |model, v, avg, dist|
    printf "  %-22s  %4d   %.3f         %.3f\n", model[0, 22], v, avg, dist
  end

  # Correlation (Spearman-style; here just rank-by-rank agreement).
  ranked_by_votes  = rows.sort_by { |_, v, _, _| -v }.map(&:first)
  ranked_by_distin = rows.sort_by { |_, _, avg, _| avg }.map(&:first)
  agree = ranked_by_votes.zip(ranked_by_distin).count { |a, b| a == b }
  puts
  puts "  rank agreement (top-1 votes vs lowest-overlap): #{agree}/#{rows.size}"
end

# ── Main ─────────────────────────────────────────────────────────

n = 3
judge_run_path = nil
args = ARGV.dup
while (a = args.shift)
  case a
  when '--n'         then n = args.shift.to_i
  when '--judge-run' then judge_run_path = args.shift
  else abort "unexpected arg: #{a}"
  end
end

# Default to latest judge run
if judge_run_path.nil?
  candidates = Dir[File.join(JUDGE_DIR, 'run_*.json')].sort
  judge_run_path = candidates.last if candidates.any?
end

db = JSON.parse(File.read(DB_PATH))
by_artist = build_ngram_index(db, n)

# Sanity: corpus sizes
total_ngrams = by_artist.values.map(&:size).sum
puts "corpus: #{by_artist.size} artists, #{total_ngrams} unique #{n}-grams across curated fragments"

by_extractor = Hash.new { |h, k| h[k] = [] }
all_rows = []
song_files = Dir[File.join(CACHE_DIR, '*.json')].sort

song_files.each do |path|
  song_doc = JSON.parse(File.read(path))
  results = song_doc['candidates'].map { |c| analyze_candidate(c, song_doc['artistId'], by_artist, n) }
  print_song_report(song_doc, results)

  results.each do |r|
    by_extractor[r['model']] << r['mean']
    r['rows'].each { |row| all_rows << row.merge('model' => r['model'], 'song' => song_doc['song']) }
  end
end

print_extractor_summary(by_extractor)
print_worst_fragments(all_rows)
print_judge_correlation(by_extractor, judge_run_path)
