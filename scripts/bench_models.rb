#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/bench_models.rb — compare local Ollama models on the lyric-
# fragment extraction task. Reuses Ollama client + prompt + validator
# from ingest.rb.
#
# Metrics per (model, song):
#   parse_ok      — response was JSON-parseable
#   schema_ok     — { "fragments": [strings, ...] }
#   count_ok      — fragment count in [3, 12]
#   length_ok     — every fragment in [20, 400] chars
#   halluc_rate   — fraction of fragments whose normalized text is NOT
#                   a substring of the normalized source lyric. 0.0 is
#                   perfect verbatim selection.
#   latency_s     — wall-clock seconds for the Ollama call
#
# Usage:
#   ruby scripts/bench_models.rb [--out report.json]

require 'json'
require 'time'
require_relative 'ingest'

MODELS = %w[
  gemma4:latest
  gemma4:e2b
  mistral-nemo:latest
  mistral-small:latest
  qwen2.5:1.5b
]

SAMPLES = %w[
  andres-calamaro__flaca.json
  cuarteto-de-nos__el-empleado-y-la-muerte.json
  damas-gratis__no-te-creas-tan-importante.json
].map { |f| File.expand_path("../tmp/lyrics/#{f}", __dir__) }

DB_PATH    = File.expand_path('../db.json', __dir__)
OLLAMA_URL = 'http://localhost:11434'

def norm_lyric(s)
  s.to_s
   .unicode_normalize(:nfd)
   .gsub(/\p{Mn}/, '')
   .downcase
   .gsub(/[^a-z0-9]+/, ' ')
   .gsub(/\s+/, ' ')
   .strip
end

def halluc_rate(fragments, lyric)
  haystack = norm_lyric(lyric)
  miss = fragments.count { |f| !haystack.include?(norm_lyric(f)) }
  fragments.empty? ? 1.0 : miss.to_f / fragments.size
end

def score_response(raw, lyric)
  result = {
    parse_ok: false, schema_ok: false, count_ok: false,
    length_ok: false, fragments: [], error: nil
  }

  obj = JSON.parse(raw)
  result[:parse_ok] = true

  frags = obj['fragments']
  return result.merge(error: 'missing fragments key') unless frags.is_a?(Array)
  return result.merge(error: 'non-string element')    unless frags.all?(String)
  result[:schema_ok] = true
  result[:fragments] = frags.map(&:strip).reject(&:empty?)

  result[:count_ok] = (FRAGMENT_MIN_COUNT..FRAGMENT_MAX_COUNT).cover?(result[:fragments].size)
  result[:length_ok] = result[:fragments].all? do |f|
    (FRAGMENT_MIN_LEN..FRAGMENT_MAX_LEN).cover?(f.length)
  end
  result[:halluc_rate] = halluc_rate(result[:fragments], lyric)
  result
rescue JSON::ParserError => e
  result.merge(error: "json parse: #{e.message[0, 80]}")
end

def display_row(model, song, r)
  fmt = lambda do |v|
    case v
    when true  then 'Y'
    when false then 'N'
    when nil   then '-'
    when Float then format('%.2f', v)
    else v.to_s
    end
  end
  printf(
    "  %-22s %-6s parse=%s schema=%s n=%-2s count=%s len=%s halluc=%s  %ss\n",
    model[0, 22], song[0, 6],
    fmt[r[:parse_ok]], fmt[r[:schema_ok]],
    (r[:fragments] || []).size,
    fmt[r[:count_ok]], fmt[r[:length_ok]],
    fmt[r[:halluc_rate]], format('%.1f', r[:latency_s] || 0)
  )
end

def run_bench
  db = JSON.parse(File.read(DB_PATH))
  songs = SAMPLES.map { |p| JSON.parse(File.read(p)).merge('file' => File.basename(p)) }
  rows  = []

  MODELS.each do |model|
    puts "── #{model} ──"
    ollama = Ollama.new(base_url: OLLAMA_URL, model: model)
    unless ollama.reachable?
      puts "  unreachable / not pulled — skipping"
      next
    end

    songs.each do |s|
      artist = db['artists'].find { |a| a['id'] == s['artistId'] }
      prompt = format(PROMPT_TEMPLATE,
                      title: s['title'], artist: artist['displayName'], lyric: s['lyric'])

      t0 = Time.now
      raw = begin
              ollama.complete(prompt)
            rescue StandardError => e
              "ERR: #{e.message}"
            end
      dt = Time.now - t0

      r = if raw.start_with?('ERR:')
            { parse_ok: false, schema_ok: false, count_ok: false,
              length_ok: false, fragments: [], error: raw, halluc_rate: nil }
          else
            score_response(raw, s['lyric'])
          end
      r[:latency_s] = dt
      r[:model] = model
      r[:song]  = s['file']
      r[:raw]   = raw
      rows << r
      display_row(model, s['file'], r)
    end
  end

  rows
end

def summarize(rows)
  by_model = rows.group_by { |r| r[:model] }
  puts
  puts '────────────────────── Summary ──────────────────────'
  printf "%-22s %5s %5s %5s %5s %7s %7s\n",
         'model', 'parse', 'schm', 'cnt', 'len', 'halluc', 'sec/req'
  by_model.each do |model, rs|
    n = rs.size
    sum = lambda do |k|
      vals = rs.map { |r| r[k] }
      case vals.first
      when true, false then vals.count(true).to_f / n
      else vals.compact.sum.to_f / [vals.compact.size, 1].max
      end
    end
    printf "%-22s %5.2f %5.2f %5.2f %5.2f %7.2f %7.1f\n",
           model[0, 22],
           sum[:parse_ok], sum[:schema_ok], sum[:count_ok], sum[:length_ok],
           sum[:halluc_rate], sum[:latency_s]
  end
end

out_path = nil
args = ARGV.dup
while (a = args.shift)
  case a
  when '--out' then out_path = args.shift
  else abort "unexpected arg: #{a}"
  end
end

rows = run_bench
summarize(rows)

if out_path
  File.write(out_path, JSON.pretty_generate(rows) + "\n")
  puts "wrote #{out_path}"
end
