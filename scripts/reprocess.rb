#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/reprocess.rb — re-run the Ollama fragment-selection prompt
# against every song in db.json that has a `lyric` field. Use this after
# editing PROMPT_TEMPLATE (or switching models) when you want to refresh
# fragments without re-downloading from letras.com.
#
# Songs without a `lyric` field are skipped — there's nothing to feed
# the LLM. To capture those, run `scripts/ingest.rb` first to populate
# tmp/ and the new lyric field.
#
# Usage:
#   ruby scripts/reprocess.rb
#
# Flags:
#   --db PATH            override db.json path (default ../db.json).
#   --model NAME         Ollama model tag (default gemma4).
#   --ollama-url URL     Ollama base URL (default http://localhost:11434).
#   --only ID,ID,...     comma-separated song ids to reprocess
#                        (default: every song with a lyric).
#   --artist ID          reprocess only songs for this artist id.

require_relative 'ingest'

db_path    = DEFAULT_DB
model      = DEFAULT_MODEL
ollama_url = DEFAULT_OLLAMA
only_ids   = nil
artist_id  = nil

args = ARGV.dup
while (a = args.shift)
  case a
  when '--db'         then db_path    = args.shift
  when '--model'      then model      = args.shift
  when '--ollama-url' then ollama_url = args.shift
  when '--only'       then only_ids   = args.shift.to_s.split(',').map(&:strip).reject(&:empty?)
  when '--artist'     then artist_id  = args.shift
  when '-h', '--help'
    puts <<~USAGE
      usage: ruby #{$PROGRAM_NAME} [flags]

      flags:
        --db PATH            db.json path (default #{DEFAULT_DB})
        --model NAME         Ollama model tag (default #{DEFAULT_MODEL})
        --ollama-url URL     Ollama base URL (default #{DEFAULT_OLLAMA})
        --only ID,ID,...     reprocess only these song ids
        --artist ID          reprocess only songs for this artist id
    USAGE
    exit 0
  else
    abort "unexpected argument: #{a.inspect}"
  end
end

abort "no such db.json: #{db_path}" unless File.exist?(db_path)

db = JSON.parse(File.read(db_path))
db['artists'] ||= []
db['songs']   ||= []

ollama = Ollama.new(base_url: ollama_url, model: model)
unless ollama.reachable?
  abort "Ollama unreachable at #{ollama_url} or model #{model.inspect} not pulled.\n" \
        "  Start Ollama and run: ollama pull #{model}"
end

only_set = only_ids && Set.new(only_ids)

candidates = db['songs'].select do |s|
  next false unless s['lyric'].is_a?(String) && !s['lyric'].strip.empty?
  next false if only_set && !only_set.include?(s['id'])
  next false if artist_id && s['artistId'] != artist_id
  true
end

skipped_no_lyric = db['songs'].count { |s| !s['lyric'].is_a?(String) || s['lyric'].strip.empty? }

$stderr.puts "reprocessing #{candidates.size} song(s); #{skipped_no_lyric} have no lyric and were skipped"

updated = 0
errors  = []

candidates.each do |song|
  artist = db['artists'].find { |a| a['id'] == song['artistId'] }
  if artist.nil?
    errors << "ERR #{song['id']}: artist #{song['artistId'].inspect} missing from db.json"
    $stderr.puts "× #{song['id']}: artist missing"
    next
  end

  $stderr.puts "→ #{song['id']}"
  begin
    frags = select_fragments_self_consistent(
      ollama,
      title:  song['song'],
      artist: artist['displayName'],
      lyric:  song['lyric']
    )
    song['fragments'] = frags
    updated += 1
    $stderr.puts "~ #{song['id']} (#{frags.size} fragments)"
  rescue StandardError => e
    errors << "ERR #{song['id']}: #{e.message}"
    $stderr.puts "× #{song['id']}: #{e.message}"
  end
end

File.write(db_path, JSON.pretty_generate(db) + "\n")

$stderr.puts
$stderr.puts '──── Summary ────'
$stderr.puts "songs updated: #{updated}"
$stderr.puts "errors:        #{errors.size}"
$stderr.puts "db:            #{db_path}"

exit 1 unless errors.empty?
