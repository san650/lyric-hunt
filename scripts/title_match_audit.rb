#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/title_match_audit.rb — title-inclusion audit over cached
# extractor outputs. For each candidate set in tmp/candidates/ and
# tmp/cot_candidates/, report whether at least one fragment contains
# the song title.
#
# Title-bearing lines are by definition the most recognizable hook;
# missing them is a recognition risk worth surfacing.

require 'json'
require_relative 'judge_pipeline'

MATRIX_CACHE = File.expand_path('../tmp/candidates', __dir__)
COT_CACHE    = File.expand_path('../tmp/cot_candidates', __dir__)
LYRICS_DIR   = File.expand_path('../tmp/lyrics', __dir__)

# Resolve a song title for a per-variant file by reading the matching sidecar.
def title_from_sidecar(filename_stem)
  slug = filename_stem.sub(/__(baseline|cot)\z/, '')
  sidecar = File.join(LYRICS_DIR, "#{slug}.json")
  return nil unless File.exist?(sidecar)
  JSON.parse(File.read(sidecar))['title']
end

def audit_matrix
  by_model = Hash.new { |h, k| h[k] = { hit: 0, total: 0, misses: [] } }
  Dir[File.join(MATRIX_CACHE, '*.json')].sort.each do |path|
    doc = JSON.parse(File.read(path))
    doc['candidates'].each do |c|
      next if c['fragments'].to_a.empty?
      tm = title_match_rate(c['fragments'], doc['song'])
      next if tm.nil?
      by_model[c['model']][:total] += 1
      tm == 1.0 ? by_model[c['model']][:hit] += 1 : by_model[c['model']][:misses] << doc['song']
    end
  end
  puts
  puts '## tmp/candidates (matrix run)'
  by_model.sort_by { |_, v| -v[:hit] }.each do |m, v|
    rate = v[:total].zero? ? 0.0 : v[:hit].to_f / v[:total]
    printf "  %-22s %2d/%2d  %.2f\n", m[0, 22], v[:hit], v[:total], rate
    v[:misses].each { |t| puts "    miss: #{t}" }
  end
end

def audit_cot_variants
  by_variant = Hash.new { |h, k| h[k] = { hit: 0, total: 0, misses: [] } }
  Dir[File.join(COT_CACHE, '*.json')].sort.each do |path|
    doc   = JSON.parse(File.read(path))
    stem  = File.basename(path, '.json')
    title = title_from_sidecar(stem)
    next if title.nil? || doc['fragments'].to_a.empty?
    tm = title_match_rate(doc['fragments'], title)
    next if tm.nil?
    key = doc['variant'] || 'unknown'
    by_variant[key][:total] += 1
    tm == 1.0 ? by_variant[key][:hit] += 1 : by_variant[key][:misses] << title
  end
  puts
  puts '## tmp/cot_candidates (A/B run, gemma4:latest)'
  by_variant.sort_by { |k, _| k }.each do |variant, v|
    rate = v[:total].zero? ? 0.0 : v[:hit].to_f / v[:total]
    printf "  %-22s %2d/%2d  %.2f\n", variant, v[:hit], v[:total], rate
    v[:misses].each { |t| puts "    miss: #{t}" }
  end
end

audit_matrix
audit_cot_variants
