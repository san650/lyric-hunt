#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/ingest.rb — fetch lyric pages from letras.com and merge them
# into db.json (artists + songs). Idempotent: running with the same
# input twice does not duplicate songs.
#
# Usage:
#   ruby scripts/ingest.rb input.txt
#
# Optional flag:
#   --db PATH    override the db.json path (defaults to ../db.json
#                relative to this script).
#
# Input format (blank-line separated band sections):
#
#   El Cuarteto de Nos:
#   https://www.letras.com/cuarteto-de-nos/.../
#   https://www.letras.com/cuarteto-de-nos/.../
#
#   Los Redondos:
#   https://www.letras.com/los-redonditos-de-ricota/.../
#
# Band headers are matched (diacritic-tolerant, case-insensitive) against
# the artists registered in db.json. Unknown headers are auto-registered
# as new artists (id = kebab-slug of header, displayName = header,
# aliases = [header]); edit db.json afterwards if you want richer aliases.
#
# Song ids are derived as "<artistId>-<slug(title)>". If a song with that
# id is already in db.json it is skipped (no overwrite).
#
# Requires: nokogiri (gem install nokogiri).
#
# Note on letras.com fetching: the site fingerprints bots. The Fetcher
# below sends the full Chrome-like header set and warms up with a GET of
# the homepage to pick up session cookies. If you still see 403s, the
# cause is likely TLS-fingerprint detection (JA3); swap in a Ferrum-
# driven headless Chrome and reuse parse_lyric as-is.

require 'net/http'
require 'uri'
require 'json'
require 'set'
require 'zlib'
require 'stringio'

begin
  require 'nokogiri'
rescue LoadError
  abort "Missing dependency: install with `gem install nokogiri` (or `bundle add nokogiri`)."
end

# ── Normalization helpers ────────────────────────────────────────

def normalize(s)
  s.to_s.downcase
   .unicode_normalize(:nfd)
   .gsub(/\p{Mn}/, '')
   .gsub(/[^a-z0-9 ]/, ' ')
   .gsub(/\s+/, ' ')
   .strip
end

def slug(s)
  normalize(s).gsub(/[^a-z0-9]+/, '-').gsub(/^-|-$/, '')
end

def strip_parens(title)
  title.gsub(/\s*\([^)]*\)\s*/, ' ').gsub(/\s+/, ' ').strip
end

def song_aliases(title)
  bare = strip_parens(title)
  unaccented = bare.gsub('Á', 'A').gsub('É', 'E').gsub('Í', 'I').gsub('Ó', 'O').gsub('Ú', 'U')
                   .gsub('á', 'a').gsub('é', 'e').gsub('í', 'i').gsub('ó', 'o').gsub('ú', 'u')
                   .gsub('ñ', 'n').gsub('Ñ', 'N')
  [title, bare, unaccented].uniq.reject(&:empty?)
end

# ── Artist registry (db.json-backed) ─────────────────────────────

def find_artist(artists, name)
  n = normalize(name)
  artists.find { |a| Array(a['aliases']).any? { |al| normalize(al) == n } }
end

def register_artist!(artists, header)
  id = slug(header)
  raise "couldn't derive id from header #{header.inspect}" if id.empty?
  if artists.any? { |a| a['id'] == id }
    raise "id collision: #{id.inspect} already in db.json — add an alias to the existing entry instead"
  end
  artist = { 'id' => id, 'displayName' => header, 'aliases' => [header] }
  artists << artist
  artist
end

# ── HTTP fetcher (browser-shaped, with cookie jar) ───────────────

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

class Fetcher
  def initialize
    @cookies = {}
    @warmed  = false
  end

  def fetch(url, referer: nil)
    warmup! unless @warmed
    do_fetch(url, referer: referer || 'https://www.letras.com/')
  end

  private

  def warmup!
    do_fetch('https://www.letras.com/', referer: nil, site: 'none')
    sleep 0.4
    @warmed = true
  rescue StandardError => e
    $stderr.puts "warmup failed (#{e.message}); continuing without session cookies"
    @warmed = true
  end

  def headers(site:, referer:)
    h = {
      'User-Agent'                => UA,
      'Accept'                    => 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language'           => 'es-ES,es;q=0.9,en;q=0.8',
      'Accept-Encoding'           => 'gzip, deflate',
      'Cache-Control'             => 'max-age=0',
      'Connection'                => 'keep-alive',
      'Upgrade-Insecure-Requests' => '1',
      'Sec-Ch-Ua'                 => '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile'          => '?0',
      'Sec-Ch-Ua-Platform'        => '"macOS"',
      'Sec-Fetch-Dest'            => 'document',
      'Sec-Fetch-Mode'            => 'navigate',
      'Sec-Fetch-Site'            => site,
      'Sec-Fetch-User'            => '?1',
    }
    h['Referer'] = referer if referer
    h['Cookie']  = @cookies.map { |k, v| "#{k}=#{v}" }.join('; ') unless @cookies.empty?
    h
  end

  def do_fetch(url, referer:, site: nil)
    uri = URI.parse(url)
    req = Net::HTTP::Get.new(uri.request_uri)
    headers(site: site || (@cookies.empty? ? 'none' : 'same-origin'), referer: referer).each { |k, v| req[k] = v }

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == 'https')
    http.read_timeout = 20
    http.open_timeout = 10
    res = http.request(req)

    update_cookies!(res)
    raise "HTTP #{res.code}" unless res.code.to_i == 200

    decompress(res)
  end

  def update_cookies!(res)
    Array(res.get_fields('set-cookie')).each do |sc|
      pair = sc.split(';', 2).first
      key, val = pair.to_s.split('=', 2)
      @cookies[key.strip] = val if key && val
    end
  end

  def decompress(res)
    body = res.body
    enc = res['content-encoding'].to_s.downcase
    case enc
    when 'gzip'    then Zlib::GzipReader.new(StringIO.new(body)).read
    when 'deflate' then Zlib::Inflate.inflate(body) rescue body
    else                body
    end
  end
end

FETCHER = Fetcher.new

def fetch_html(url)
  FETCHER.fetch(url)
end

# ── Parsing ──────────────────────────────────────────────────────

def parse_lyric(html, url)
  doc = Nokogiri::HTML(html)
  title = doc.css('h1').first&.text&.strip
  raise "no <h1> at #{url}" if title.nil? || title.empty?

  lyric_node = doc.css('.lyric-original').first || doc.css('.cnt-letra').first
  raise "no lyric body at #{url}" if lyric_node.nil?

  lyric_node.css('br').each { |br| br.replace("\n") }
  lyric_node.css('p').each { |p| p.add_next_sibling("\n\n") }
  text = lyric_node.text
                  .gsub(/\r/, '')
                  .gsub(/[ \t]+\n/, "\n")
                  .gsub(/\n{3,}/, "\n\n")
                  .strip
  { title: title, text: text }
end

def fragments_from(text)
  parts = text.split(/\n\s*\n/).map(&:strip).reject(&:empty?)
  seen = {}
  uniq = parts.select { |p| !seen[p] && (seen[p] = true) }
  uniq.reject { |p| p.length < 30 || (p.split("\n").size < 2 && p.length < 50) }
end

# ── Main ─────────────────────────────────────────────────────────

DEFAULT_DB = File.expand_path('../db.json', __dir__)

input_path = nil
db_path    = DEFAULT_DB

args = ARGV.dup
while (a = args.shift)
  case a
  when '--db'  then db_path = args.shift
  when '-h', '--help'
    puts "usage: ruby #{$PROGRAM_NAME} [--db db.json] input.txt"
    exit 0
  else
    if input_path.nil?
      input_path = a
    else
      abort "unexpected argument: #{a.inspect}"
    end
  end
end

abort "usage: ruby #{$PROGRAM_NAME} [--db db.json] input.txt" if input_path.nil?
abort "no such file: #{input_path}" unless File.exist?(input_path)

db = if File.exist?(db_path)
       JSON.parse(File.read(db_path))
     else
       { 'artists' => [], 'songs' => [] }
     end
db['artists'] ||= []
db['songs']   ||= []

existing_song_ids = Set.new(db['songs'].map { |s| s['id'] })

added_artists = []
added_songs   = []
skipped       = []
errors        = []
current_artist = nil

File.read(input_path).each_line do |line|
  line = line.strip
  next if line.empty?

  if line.end_with?(':')
    header = line[0..-2].strip
    current_artist = find_artist(db['artists'], header)
    if current_artist.nil?
      current_artist = register_artist!(db['artists'], header)
      added_artists << current_artist
      $stderr.puts "+ new artist: #{current_artist['id']} (#{current_artist['displayName']})"
    end
    next
  end

  next unless line.start_with?('http')
  url = line

  if current_artist.nil?
    errors << "URL #{url} has no preceding band header."
    next
  end

  begin
    sleep 0.5  # polite pacing between requests
    html = fetch_html(url)
    data = parse_lyric(html, url)
    frags = fragments_from(data[:text])
    raise 'no usable fragments extracted' if frags.empty?

    title  = data[:title]
    bare   = strip_parens(title)
    new_id = "#{current_artist['id']}-#{slug(bare)}"

    if existing_song_ids.include?(new_id)
      skipped << "#{new_id} (already in db.json)"
      $stderr.puts "= #{current_artist['id']} :: #{bare} (skipped — already present)"
      next
    end

    song = {
      'id'           => new_id,
      'artistId'     => current_artist['id'],
      'song'         => bare,
      'album'        => '',
      'year'         => nil,
      'songAliases'  => song_aliases(title),
      'albumAliases' => [],
      'fragments'    => frags,
    }
    db['songs'] << song
    existing_song_ids << new_id
    added_songs << song
    $stderr.puts "+ #{current_artist['id']} :: #{bare} (#{frags.size} fragments)"
  rescue StandardError => e
    errors << "ERR #{url}: #{e.message}"
  end
end

# Persist with stable 2-space indentation. Always rewrite to keep
# formatting consistent — easier to diff than mixed indentation.
File.write(db_path, JSON.pretty_generate(db) + "\n")

$stderr.puts
$stderr.puts '──── Summary ────'
$stderr.puts "artists added: #{added_artists.size}"
$stderr.puts "songs added:   #{added_songs.size}"
$stderr.puts "songs skipped: #{skipped.size}"
$stderr.puts "db: #{db_path}"

unless errors.empty?
  $stderr.puts
  $stderr.puts '──── Errors ────'
  errors.each { |e| $stderr.puts e }
  exit 1
end
