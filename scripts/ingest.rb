#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/ingest.rb — fetch lyric pages from letras.com, run them through
# a local Ollama Gemma 4 model to pick out memorable sentences, and merge
# everything into db.json.
#
# Two-phase flow:
#   1. Download every URL into tmp/lyrics/<artistId>__<slug>.json
#      (one sidecar per song with the full lyric).
#   2. For each sidecar, ask the LLM to extract fragments and merge into
#      db.json. Existing songs are rewritten: `fragments` and `lyric` are
#      overwritten; album/year/aliases are preserved.
#
# Usage:
#   ruby scripts/ingest.rb input.txt
#
# Flags:
#   --db PATH            override db.json path (default ../db.json).
#   --model NAME         Ollama model tag (default gemma4).
#   --ollama-url URL     Ollama base URL (default http://localhost:11434).
#   --skip-download      reuse tmp/ contents; skip Phase 1.
#   --keep-tmp           don't prune tmp/ files after a successful run
#                        (default behavior is to keep them; reserved for
#                        future cleanup logic).
#
# Requires: nokogiri, a running Ollama daemon with the chosen model
# pulled (`ollama pull gemma4`).

require 'net/http'
require 'uri'
require 'json'
require 'set'
require 'zlib'
require 'stringio'
require 'fileutils'

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

# ── Ollama client ────────────────────────────────────────────────

class Ollama
  class Error < StandardError; end

  def initialize(base_url:, model:)
    @base = URI.parse(base_url)
    @model = model
  end

  def reachable?
    uri = URI.join(@base.to_s.sub(%r{/?$}, '/'), 'api/tags')
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: 3, read_timeout: 5) do |http|
      http.request(Net::HTTP::Get.new(uri.request_uri))
    end
    return false unless res.code.to_i == 200
    body = JSON.parse(res.body)
    Array(body['models']).any? { |m| m['name'].to_s.start_with?(@model) || m['name'].to_s == @model }
  rescue StandardError
    false
  end

  # Returns the raw assistant response string. Caller parses JSON.
  def complete(prompt)
    uri = URI.join(@base.to_s.sub(%r{/?$}, '/'), 'api/generate')
    req = Net::HTTP::Post.new(uri.request_uri, 'Content-Type' => 'application/json')
    req.body = JSON.generate(
      model:   @model,
      prompt:  prompt,
      stream:  false,
      format:  'json',
      options: { temperature: 0.2 }
    )

    res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: 10, read_timeout: 300) do |http|
      http.request(req)
    end
    raise Error, "Ollama HTTP #{res.code}: #{res.body}" unless res.code.to_i == 200

    body = JSON.parse(res.body)
    body['response'].to_s
  rescue JSON::ParserError => e
    raise Error, "Ollama non-JSON wrapper: #{e.message}"
  end
end

PROMPT_TEMPLATE = <<~PROMPT
  Sos un curador de un juego de adivinar canciones en español.
  Te paso la letra completa de una canción. Tu tarea es elegir entre 5 y 8
  fragmentos memorables que un fan reconocería al instante: versos icónicos,
  hooks, frases distintivas que identifiquen la canción.

  Reglas:
  - Evitá relleno o frases genéricas que podrían pertenecer a cualquier canción.
  - Si el coro es icónico, incluilo una sola vez (no repetido).
  - Cada fragmento puede ser de 1 a 4 líneas.
  - Conservá los saltos de línea originales dentro del fragmento (usá \\n entre líneas).
  - No traduzcas. No parafrasees. Copiá los versos tal como aparecen.

  Devolvé EXCLUSIVAMENTE un JSON válido con esta forma exacta:
  { "fragments": ["...", "...", ...] }

  No agregues texto fuera del JSON. No agregues comentarios.

  Canción: %<title>s
  Artista: %<artist>s
  Letra:
  %<lyric>s
PROMPT

FRAGMENT_MIN_LEN = 20
FRAGMENT_MAX_LEN = 400
FRAGMENT_MIN_COUNT = 3
FRAGMENT_MAX_COUNT = 12

def validate_fragments(raw_response)
  obj = JSON.parse(raw_response)
  frags = obj['fragments']
  raise "no fragments key" unless frags.is_a?(Array)
  raise "fragment count #{frags.size} outside [#{FRAGMENT_MIN_COUNT}, #{FRAGMENT_MAX_COUNT}]" \
    if frags.size < FRAGMENT_MIN_COUNT || frags.size > FRAGMENT_MAX_COUNT

  frags.each_with_index do |f, i|
    raise "fragment #{i} not a string" unless f.is_a?(String)
    stripped = f.strip
    raise "fragment #{i} too short (#{stripped.length} chars)" if stripped.length < FRAGMENT_MIN_LEN
    raise "fragment #{i} too long (#{stripped.length} chars)"  if stripped.length > FRAGMENT_MAX_LEN
  end

  frags.map(&:strip).reject(&:empty?)
end

def select_fragments_with_llm(ollama, title:, artist:, lyric:, max_retries: 3)
  prompt = format(PROMPT_TEMPLATE, title: title, artist: artist, lyric: lyric)
  last_error = nil
  max_retries.times do |attempt|
    begin
      raw = ollama.complete(prompt)
      return validate_fragments(raw)
    rescue StandardError => e
      last_error = e
      $stderr.puts "  llm attempt #{attempt + 1}/#{max_retries} failed: #{e.message}"
    end
  end
  raise Ollama::Error, "gave up after #{max_retries} attempts: #{last_error&.message}"
end

# ── Input parsing ────────────────────────────────────────────────

# Walks the input file. For each "Artist:" header, resolves (or registers)
# the artist in db. Yields (artist, url) for every URL line.
def each_artist_url(input_path, db)
  current_artist = nil
  File.foreach(input_path) do |raw|
    line = raw.strip
    next if line.empty?

    if line.end_with?(':')
      header = line[0..-2].strip
      current_artist = find_artist(db['artists'], header)
      if current_artist.nil?
        current_artist = register_artist!(db['artists'], header)
        $stderr.puts "+ new artist: #{current_artist['id']} (#{current_artist['displayName']})"
      end
      next
    end

    next unless line.start_with?('http')
    if current_artist.nil?
      $stderr.puts "WARN: URL #{line} has no preceding band header — skipping"
      next
    end
    yield current_artist, line
  end
end

# ── Phase 1: download ────────────────────────────────────────────

def sidecar_path(tmp_dir, artist_id, song_slug)
  File.join(tmp_dir, "#{artist_id}__#{song_slug}.json")
end

def download_phase(input_path, db, tmp_dir, fetcher)
  FileUtils.mkdir_p(tmp_dir)
  paths  = []
  errors = []

  each_artist_url(input_path, db) do |artist, url|
    sleep 0.5  # polite pacing
    begin
      html = fetcher.fetch(url)
      data = parse_lyric(html, url)
      song_slug = slug(strip_parens(data[:title]))
      path = sidecar_path(tmp_dir, artist['id'], song_slug)
      File.write(path, JSON.pretty_generate(
        'url'      => url,
        'artistId' => artist['id'],
        'title'    => data[:title],
        'lyric'    => data[:text]
      ) + "\n")
      paths << path
      $stderr.puts "↓ #{artist['id']} :: #{data[:title]}"
    rescue StandardError => e
      errors << "ERR #{url}: #{e.message}"
      $stderr.puts "× #{url}: #{e.message}"
    end
  end

  [paths, errors]
end

# For --skip-download: resolve which existing sidecars in tmp_dir
# correspond to the URLs in input_path by matching the `url` field.
def sidecars_for_input(input_path, db, tmp_dir)
  wanted = []
  each_artist_url(input_path, db) { |_artist, url| wanted << url }
  wanted_set = Set.new(wanted)

  found_by_url = {}
  Dir.glob(File.join(tmp_dir, '*.json')).each do |path|
    begin
      data = JSON.parse(File.read(path))
      found_by_url[data['url']] = path if wanted_set.include?(data['url'])
    rescue StandardError
      next
    end
  end

  paths   = []
  missing = []
  wanted.each do |url|
    if found_by_url.key?(url)
      paths << found_by_url[url]
    else
      missing << url
    end
  end
  [paths, missing]
end

# ── Phase 2: LLM + merge ─────────────────────────────────────────

# Returns artist matching the given id; raises if missing.
def artist_by_id!(db, artist_id)
  a = db['artists'].find { |x| x['id'] == artist_id }
  raise "artist #{artist_id.inspect} missing from db.json" if a.nil?
  a
end

def upsert_song!(db, artist, title, url, lyric, fragments)
  bare = strip_parens(title)
  song_id = "#{artist['id']}-#{slug(bare)}"
  existing = db['songs'].find { |s| s['id'] == song_id }

  if existing
    existing['url']       = url
    existing['lyric']     = lyric
    existing['fragments'] = fragments
    [:updated, existing]
  else
    song = {
      'id'           => song_id,
      'artistId'     => artist['id'],
      'song'         => bare,
      'album'        => '',
      'year'         => nil,
      'songAliases'  => song_aliases(title),
      'albumAliases' => [],
      'url'          => url,
      'lyric'        => lyric,
      'fragments'    => fragments,
    }
    db['songs'] << song
    [:added, song]
  end
end

def process_phase(sidecar_paths, db, ollama)
  added = []
  updated = []
  errors = []

  if sidecar_paths.empty?
    $stderr.puts "no sidecars to process"
    return [added, updated, errors]
  end

  sidecar_paths.each do |path|
    begin
      data = JSON.parse(File.read(path))
      artist = artist_by_id!(db, data['artistId'])
      title  = data['title']
      lyric  = data['lyric']
      url    = data['url']

      $stderr.puts "→ #{artist['id']} :: #{title}"
      frags = select_fragments_with_llm(
        ollama,
        title:  title,
        artist: artist['displayName'],
        lyric:  lyric
      )

      action, song = upsert_song!(db, artist, title, url, lyric, frags)
      if action == :added
        added << song
        $stderr.puts "+ #{song['id']} (#{frags.size} fragments)"
      else
        updated << song
        $stderr.puts "~ #{song['id']} (#{frags.size} fragments)"
      end
    rescue StandardError => e
      errors << "ERR #{path}: #{e.message}"
      $stderr.puts "× #{path}: #{e.message}"
    end
  end

  [added, updated, errors]
end

# ── Main ─────────────────────────────────────────────────────────

DEFAULT_DB     = File.expand_path('../db.json', __dir__)
DEFAULT_TMP    = File.expand_path('../tmp/lyrics', __dir__)
DEFAULT_MODEL  = 'gemma4'
DEFAULT_OLLAMA = 'http://localhost:11434'

# Guard main so other scripts (e.g. reprocess.rb) can `require_relative`
# this file to reuse Ollama, select_fragments_with_llm, etc.
if __FILE__ == $PROGRAM_NAME

input_path    = nil
db_path       = DEFAULT_DB
tmp_dir       = DEFAULT_TMP
model         = DEFAULT_MODEL
ollama_url    = DEFAULT_OLLAMA
skip_download = false

args = ARGV.dup
while (a = args.shift)
  case a
  when '--db'           then db_path = args.shift
  when '--model'        then model = args.shift
  when '--ollama-url'   then ollama_url = args.shift
  when '--tmp'          then tmp_dir = args.shift
  when '--skip-download' then skip_download = true
  when '--keep-tmp'     then nil # reserved; tmp is kept by default
  when '-h', '--help'
    puts <<~USAGE
      usage: ruby #{$PROGRAM_NAME} [flags] input.txt

      flags:
        --db PATH           db.json path (default #{DEFAULT_DB})
        --model NAME        Ollama model tag (default #{DEFAULT_MODEL})
        --ollama-url URL    Ollama base URL (default #{DEFAULT_OLLAMA})
        --tmp DIR           tmp/ directory (default #{DEFAULT_TMP})
        --skip-download     reuse tmp/ contents; skip download phase
        --keep-tmp          reserved (tmp/ is currently kept by default)
    USAGE
    exit 0
  else
    if input_path.nil?
      input_path = a
    else
      abort "unexpected argument: #{a.inspect}"
    end
  end
end

abort "usage: ruby #{$PROGRAM_NAME} [flags] input.txt" if input_path.nil?
abort "no such file: #{input_path}" unless File.exist?(input_path)

db = if File.exist?(db_path)
       JSON.parse(File.read(db_path))
     else
       { 'artists' => [], 'songs' => [] }
     end
db['artists'] ||= []
db['songs']   ||= []

ollama = Ollama.new(base_url: ollama_url, model: model)
unless ollama.reachable?
  abort "Ollama unreachable at #{ollama_url} or model #{model.inspect} not pulled.\n" \
        "  Start Ollama and run: ollama pull #{model}"
end

if skip_download
  $stderr.puts "── Phase 1: skipped (--skip-download) ──"
  sidecar_paths, missing = sidecars_for_input(input_path, db, tmp_dir)
  $stderr.puts "found #{sidecar_paths.size} matching sidecars in #{tmp_dir}"
  missing.each { |u| $stderr.puts "WARN no sidecar for #{u} — run without --skip-download to download it" } unless missing.empty?
else
  $stderr.puts '── Phase 1: downloading lyrics ──'
  sidecar_paths, dl_errors = download_phase(input_path, db, tmp_dir, Fetcher.new)
  $stderr.puts "downloaded #{sidecar_paths.size} lyrics into #{tmp_dir}"
  dl_errors.each { |e| $stderr.puts e } unless dl_errors.empty?
end

$stderr.puts
$stderr.puts '── Phase 2: extracting fragments via Ollama ──'
added, updated, llm_errors = process_phase(sidecar_paths, db, ollama)

File.write(db_path, JSON.pretty_generate(db) + "\n")

$stderr.puts
$stderr.puts '──── Summary ────'
$stderr.puts "songs added:   #{added.size}"
$stderr.puts "songs updated: #{updated.size}"
$stderr.puts "errors:        #{llm_errors.size}"
$stderr.puts "db:            #{db_path}"
$stderr.puts "tmp:           #{tmp_dir}"

exit 1 unless llm_errors.empty?

end  # if __FILE__ == $PROGRAM_NAME
