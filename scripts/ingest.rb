#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/ingest.rb — fetch lyric pages from letras.com and emit JS song
# objects ready to paste into the SONGS array in lyrics.js.
#
# Usage:
#   ruby scripts/ingest.rb input.txt > new-songs.js
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
# the ARTISTS constant below — which is the source of truth that lyrics.js
# also mirrors. Headers can use any registered alias for a band
# ("Los Redondos", "Patricio Rey y Sus Redonditos de Ricota", "Redondos",
# etc. all resolve to artistId 'redondos').
#
# Unknown bands report to STDERR and their URLs are skipped. Add new
# bands by editing BOTH this constant and the ARTISTS array in lyrics.js.
#
# Requires: nokogiri (gem install nokogiri).
#
# Note on letras.com fetching: the site fingerprints bots. The Fetcher
# below sends the full Chrome-like header set (Sec-Fetch-*, Sec-Ch-Ua,
# Upgrade-Insecure-Requests, Accept-Encoding gzip) and does a warmup GET
# of the homepage first to pick up the session cookies the subsequent
# lyric pages expect. If you still see repeated 403s, the cause is almost
# certainly TLS-fingerprint detection (JA3) — Ruby's OpenSSL handshake
# differs from Chrome's. In that case switch to a real browser:
#
#   gem install ferrum    # ~30MB Chromium controller, no Node required
#
# and replace Fetcher.fetch with `Ferrum::Browser.new.go_to(url).body`.
# The parse_lyric block below is reusable as-is against either source.

require 'net/http'
require 'uri'
require 'json'

begin
  require 'nokogiri'
rescue LoadError
  abort "Missing dependency: install with `gem install nokogiri` (or `bundle add nokogiri`)."
end

ARTISTS = [
  { id: 'cuarteto-de-nos',    aliases: ['El Cuarteto de Nos', 'Cuarteto de Nos', 'El Cuarteto', 'Cuarteto'] },
  { id: 'redondos',           aliases: [
                                'Los Redondos',
                                'Patricio Rey y Sus Redonditos de Ricota',
                                'Patricio Rey y Los Redonditos de Ricota',
                                'Los Redonditos de Ricota',
                                'Redonditos de Ricota',
                                'Patricio Rey',
                                'Redondos',
                                'Redonditos',
                              ] },
  { id: 'la-tabare',          aliases: ['La Tabaré', 'La Tabare', 'Tabaré', 'Tabare', 'La Tabaré Riverock Banda'] },
  { id: 'angeles-azules',     aliases: ['Los Ángeles Azules', 'Los Angeles Azules', 'Ángeles Azules', 'Angeles Azules'] },
  { id: 'damas-gratis',       aliases: ['Damas Gratis', 'Damas G'] },
  { id: 'julieta-venegas',    aliases: ['Julieta Venegas', 'Venegas Julieta', 'Julieta', 'Venegas'] },
  { id: 'ska-p',              aliases: ['Ska-P', 'SkaP', 'Skap', 'Ska P'] },
  { id: '2-minutos',          aliases: ['2 Minutos', 'Dos Minutos'] },
  { id: 'los-buitres',        aliases: ['Los Buitres', 'Buitres después de la una'] },
  { id: 'trotsky-vengaran',   aliases: ['Trotsky Vengaran'] },
  { id: 'la-vela',            aliases: ['La Vela Puerca', 'La Vela'] },
  { id: '4-pesos-de-propina', aliases: ['4 Pesos de Propina', '4 Pesos'] },
  { id: 'no-te-va-gustar',    aliases: ['No Te Va Gustar', 'NTVG'] },
].freeze

# ── Helpers ──────────────────────────────────────────────────────

def normalize(s)
  s.to_s.downcase
   .unicode_normalize(:nfd)
   .gsub(/\p{Mn}/, '')
   .gsub(/[^a-z0-9 ]/, ' ')
   .gsub(/\s+/, ' ')
   .strip
end

def find_artist(name)
  n = normalize(name)
  ARTISTS.find { |a| a[:aliases].any? { |al| normalize(al) == n } }
end

def slug(s)
  normalize(s).gsub(/[^a-z0-9]+/, '-').gsub(/^-|-$/, '')
end

def strip_parens(title)
  title.gsub(/\s*\([^)]*\)\s*/, ' ').gsub(/\s+/, ' ').strip
end

def song_aliases(title)
  bare = strip_parens(title)
  list = [title, bare]
  list << bare.gsub('Á', 'A').gsub('É', 'E').gsub('Í', 'I').gsub('Ó', 'O').gsub('Ú', 'U')
              .gsub('á', 'a').gsub('é', 'e').gsub('í', 'i').gsub('ó', 'o').gsub('ú', 'u')
              .gsub('ñ', 'n').gsub('Ñ', 'N')
  list.uniq.reject { |s| s.empty? }
end

# ── Fetching ─────────────────────────────────────────────────────
#
# A small browser-shaped fetcher with a shared cookie jar. A warmup GET
# of the homepage establishes whatever session cookies letras.com sets,
# and subsequent lyric GETs replay them — matching what a real Chrome
# session does in DevTools. Without the cookies we got HTTP 403; with
# them most networks pass.

require 'zlib'
require 'stringio'

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

  # Normalize <br> → \n and <p> → \n\n; then strip tags.
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

# ── JS emission ──────────────────────────────────────────────────

def js_string(s)
  '"' + s.gsub('\\', '\\\\').gsub('"', '\\"') + '"'
end

def js_template(s)
  '`' + s.gsub('\\', '\\\\').gsub('`', '\\`').gsub('${', '\\${') + '`'
end

def emit(songs, out: $stdout)
  out.puts "// Generated by scripts/ingest.rb. Paste each entry into the SONGS"
  out.puts "// array in lyrics.js. album/year start empty — fill them in by hand."
  out.puts
  songs.each do |s|
    out.puts "  {"
    out.puts "    id: #{js_string(s[:id])},"
    out.puts "    artistId: #{js_string(s[:artistId])},"
    out.puts "    song: #{js_string(s[:song])},"
    out.puts "    album: #{js_string(s[:album])},"
    out.puts "    year: #{s[:year].nil? ? 'null' : s[:year]},"
    out.puts "    songAliases: [#{s[:songAliases].map { |a| js_string(a) }.join(', ')}],"
    out.puts "    albumAliases: [#{s[:albumAliases].map { |a| js_string(a) }.join(', ')}],"
    out.puts "    fragments: ["
    s[:fragments].each { |f| out.puts "      #{js_template(f)}," }
    out.puts "    ],"
    out.puts "  },"
    out.puts
  end
end

# ── Main ─────────────────────────────────────────────────────────

input_path = ARGV[0]
abort "usage: ruby #{$PROGRAM_NAME} input.txt > new-songs.js" if input_path.nil?
abort "no such file: #{input_path}" unless File.exist?(input_path)

raw = File.read(input_path)
songs = []
errors = []
current_artist = nil

raw.each_line do |line|
  line = line.strip
  next if line.empty?

  if line.end_with?(':')
    header = line[0..-2].strip
    current_artist = find_artist(header)
    if current_artist.nil?
      errors << "Unknown band header: #{header.inspect}. Add it to ARTISTS in #{$PROGRAM_NAME} and lyrics.js."
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

    title = data[:title]
    songs << {
      id: "#{current_artist[:id]}-#{slug(strip_parens(title))}",
      artistId: current_artist[:id],
      song: strip_parens(title),
      album: '',
      year: nil,
      songAliases: song_aliases(title),
      albumAliases: [],
      fragments: frags,
    }
    $stderr.puts "✓ #{current_artist[:id]} :: #{strip_parens(title)}  (#{frags.size} fragments)"
  rescue StandardError => e
    errors << "ERR #{url}: #{e.message}"
  end
end

emit(songs)

unless errors.empty?
  $stderr.puts
  $stderr.puts '──── Errors ────'
  errors.each { |e| $stderr.puts e }
  exit 1
end
