/**
 * Plain transcript text from a caption file (pure). The file on disk keeps
 * the timings; `text` in the JSON document is for search and summaries.
 */
import type {SubFormat} from './args.js'

type Json3 = {events?: {segs?: {utf8?: string}[]}[]}

export function transcriptText(format: SubFormat, content: string): string {
  return format === 'json3' ? fromJson3(content) : fromVtt(content)
}

function fromJson3(content: string): string {
  let parsed: Json3
  try {
    parsed = JSON.parse(content) as Json3
  } catch {
    return ''
  }
  const parts: string[] = []
  for (const event of parsed.events ?? []) {
    for (const seg of event.segs ?? []) {
      const text = seg.utf8 ?? ''
      if (text.trim()) parts.push(text)
    }
  }
  return squash(parts.join(' '))
}

function fromVtt(content: string): string {
  const lines: string[] = []
  let previous = ''
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/<[^>]*>/g, '').trim()
    if (!line || line === 'WEBVTT' || line.includes('-->') || /^\d+$/.test(line)) continue
    if (/^(Kind|Language|NOTE|STYLE|REGION)\b/.test(line)) continue
    // YouTube's auto captions repeat each cue as the next one's first line
    if (line === previous) continue
    previous = line
    lines.push(line)
  }
  return squash(lines.join(' '))
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
