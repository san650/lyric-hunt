#!/usr/bin/env ruby
# frozen_string_literal: true
#
# scripts/fetch_lyrics.rb — read-only sibling of ingest.rb. Reuses the
# browser-shaped Fetcher to download lyric pages and dumps them to
# stdout as plain text, grouped by band. Use this when you want to
# curate fragments by hand (pick out the recognizable lines) before
# pasting song entries into db.json. Does NOT touch db.json.
#
# Usage:
#   ruby scripts/fetch_lyrics.rb input.txt > dump.txt
#
# Input format: same as ingest.rb (band header followed by URLs, blank
# lines separate bands). Both letras.com and musica.com URLs are
# supported; the title selector for musica.com is fragile (its pages
# wrap the song name in different tags depending on layout), so verify
# the dumped TITLE line before trusting it.

require 'net/http'
require 'uri'
require 'zlib'
require 'stringio'
require 'nokogiri'

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
    $stderr.puts "warmup failed (#{e.message})"
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
    when 'deflate' then (Zlib::Inflate.inflate(body) rescue body)
    else                body
    end
  end
end

FETCHER = Fetcher.new

def parse_letras(html, url)
  doc = Nokogiri::HTML(html)
  title = doc.css('h1').first&.text&.strip
  raise "no <h1> at #{url}" if title.nil? || title.empty?
  node = doc.css('.lyric-original').first || doc.css('.cnt-letra').first
  raise "no lyric body at #{url}" if node.nil?
  node.css('br').each { |br| br.replace("\n") }
  node.css('p').each { |p| p.add_next_sibling("\n\n") }
  text = node.text.gsub(/\r/, '').gsub(/[ \t]+\n/, "\n").gsub(/\n{3,}/, "\n\n").strip
  { title: title, text: text }
end

def parse_musica(html, url)
  doc = Nokogiri::HTML(html)
  title = doc.css('h2').first&.text&.strip || doc.css('h1').first&.text&.strip
  raise "no title at #{url}" if title.nil? || title.empty?
  node = doc.css('p.letra').first || doc.css('.letra').first || doc.css('#letra').first
  raise "no lyric body at #{url}" if node.nil?
  node.css('br').each { |br| br.replace("\n") }
  text = node.text.gsub(/\r/, '').gsub(/[ \t]+\n/, "\n").gsub(/\n{3,}/, "\n\n").strip
  { title: title, text: text }
end

input_path = ARGV[0]
abort "usage: ruby #{$PROGRAM_NAME} input.txt > dump.txt" if input_path.nil?
abort "no such file: #{input_path}" unless File.exist?(input_path)
input = File.read(input_path)
current = nil
input.each_line do |line|
  line = line.strip
  next if line.empty?
  if line.end_with?(':')
    current = line[0..-2]
    puts
    puts "==== #{current} ===="
    next
  end
  next unless line.start_with?('http')
  begin
    sleep 0.6
    host = URI.parse(line).host
    if host && host.include?('musica.com')
      html = Net::HTTP.get(URI.parse(line))
      data = parse_musica(html, line)
    else
      html = FETCHER.fetch(line)
      data = parse_letras(html, line)
    end
    puts
    puts "---- #{data[:title]}  [#{line}]"
    puts data[:text]
  rescue => e
    puts
    puts "!!!! #{line}: #{e.message}"
  end
end
