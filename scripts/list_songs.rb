#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/list_songs.rb — print every artist with their songs, grouped
# by artist and sorted alphabetically by display name.
#
# Usage:
#   ruby scripts/list_songs.rb [--db PATH]

require 'json'

DEFAULT_DB = File.expand_path('../db.json', __dir__)

db_path = DEFAULT_DB
args = ARGV.dup
while (a = args.shift)
  case a
  when '--db' then db_path = args.shift
  when '-h', '--help'
    puts "usage: ruby #{$PROGRAM_NAME} [--db PATH]"
    exit 0
  else
    abort "unexpected argument: #{a.inspect}"
  end
end

abort "no such db.json: #{db_path}" unless File.exist?(db_path)

db = JSON.parse(File.read(db_path))
artists = db['artists'] || []
songs   = db['songs']   || []

by_artist = songs.group_by { |s| s['artistId'] }

artists.sort_by { |a| a['displayName'].to_s.downcase }.each do |artist|
  list = by_artist[artist['id']] || []
  puts "#{artist['displayName']} (#{list.size})"
  list.sort_by { |s| s['song'].to_s.downcase }.each do |s|
    puts "  - #{s['song']}"
  end
  puts
end

$stderr.puts "#{artists.size} artists, #{songs.size} songs"
