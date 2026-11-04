/** Shared shapes for the `yoinks meta` providers and the schema-1 document. */
import type {MetaError} from './errors.js'

export type LiveStatus = 'none' | 'live' | 'upcoming' | 'was_live' | 'post_live'

export type Chapter = {title: string | null; startSec: number; endSec: number | null}

export type Metadata = {
  title: string | null
  description: string | null
  channel: string | null
  channelId: string | null
  /** ISO 8601 UTC. */
  publishedAt: string | null
  durationSec: number | null
  audioLanguage: string | null
  liveStatus: LiveStatus
  /** Only yt-dlp knows chapters; null from the Data API. */
  chapters: Chapter[] | null
}

export type ThumbnailRef = {url: string; width: number | null; height: number | null}

export type MetadataProvider = 'youtube-api' | 'ytdlp'
export type CaptionsProvider = 'ytdlp'
export type ThumbnailProvider = 'youtube-api' | 'ytimg' | 'ytdlp'

export type CaptionOutput = {
  sourceLang: string
  requestedLangs: string[]
  kind: 'manual' | 'asr'
  translated: boolean
  vssId: string | null
  name: string | null
  format: 'json3' | 'vtt'
  path: string
  text: string
}

export type ThumbnailOutput = ThumbnailRef & {path: string}

export type MetaItem = {
  inputUrl: string
  videoId: string | null
  extractor: string | null
  webpageUrl: string | null
  metadata: Metadata | null
  /** null when not requested or failed; [] when requested and none exist. */
  captions: CaptionOutput[] | null
  thumbnail: ThumbnailOutput | null
  providers: {
    metadata: MetadataProvider | null
    captions: CaptionsProvider | null
    thumbnail: ThumbnailProvider | null
  }
  warnings: MetaError[]
  errors: MetaError[]
}

export type MetaDocument = {
  schema: 1
  generatedAt: string
  yoinksVersion: string
  items: MetaItem[]
}
