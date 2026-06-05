#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/list_missing_lyrics.rb — print every song in db.json that
# doesn't have a usable `lyric` field. These are the songs that need
# to be re-run through ingest.rb to populate the full lyric (and the
# URL, if it's also missing).
#
# Usage:
#   ruby scripts/list_missing_lyrics.rb
#
# Flags:
#   --db PATH    override db.json path (default ../db.json).
#   --urls       print only the source URL (one per line), suitable
#                for piping into a new artists.txt-style input file.

require 'json'

DEFAULT_DB = File.expand_path('../db.json', __dir__)

db_path   = DEFAULT_DB
urls_only = false

args = ARGV.dup
while (a = args.shift)
  case a
  when '--db'  then db_path = args.shift
  when '--urls' then urls_only = true
  when '-h', '--help'
    puts <<~USAGE
      usage: ruby #{$PROGRAM_NAME} [--db PATH] [--urls]

      Lists songs in db.json that are missing a `lyric` field.

      flags:
        --db PATH    db.json path (default #{DEFAULT_DB})
        --urls       print only the URL of each missing song
    USAGE
    exit 0
  else
    abort "unexpected argument: #{a.inspect}"
  end
end

abort "no such db.json: #{db_path}" unless File.exist?(db_path)

db = JSON.parse(File.read(db_path))
songs   = db['songs']   || []
artists = db['artists'] || []
artist_name = artists.each_with_object({}) { |a, h| h[a['id']] = a['displayName'] }

missing = songs.reject { |s| s['lyric'].is_a?(String) && !s['lyric'].strip.empty? }

if urls_only
  missing.each { |s| puts s['url'] if s['url'] && !s['url'].empty? }
  exit 0
end

if missing.empty?
  puts "all #{songs.size} songs have a lyric"
  exit 0
end

# Group by artist for easier scanning.
by_artist = missing.group_by { |s| s['artistId'] }
by_artist.keys.sort.each do |artist_id|
  puts "#{artist_name[artist_id] || artist_id}:"
  by_artist[artist_id].each do |s|
    url = s['url'].to_s.empty? ? '(no url)' : s['url']
    puts "  #{s['song'].ljust(40)}  #{url}"
  end
  puts
end

$stderr.puts "#{missing.size} of #{songs.size} songs missing a lyric"
