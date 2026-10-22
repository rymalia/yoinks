import {createHash} from 'node:crypto'

export type NamingStyle = 'title' | 'slug'

export function isNamingStyle(value: string): value is NamingStyle {
  return value === 'title' || value === 'slug'
}

export function outputTemplate(
  style: NamingStyle,
  info: {
    id?: string
    title?: string
    webpage_url?: string
    extractor?: string
    width?: number
    height?: number
    formats?: Array<{width?: number; height?: number; vcodec?: string}>
  },
  kind: 'video' | 'audio',
): string {
  const dimension = isPortrait(info) ? 'width' : 'height'
  const suffix = kind === 'video'
    ? style === 'slug'
      ? `%(${dimension}&-{}p|)s`
      : `%(${dimension}& {}p|)s`
    : ''

  if (style === 'title') {
    if (typeof info.id === 'string' && info.id.length > 0) {
      return `%(title).60B [%(id)s]${suffix}.%(ext)s`
    }
    return `%(title).60B [${hashFallback(info)}]${suffix}.%(ext)s`
  }

  const slugify = (value: string) => value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  const title = slugify(info.title ?? '')

  const rawId = info.id
  const cleanId = rawId?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) ?? ''
  const changedId = Boolean(rawId) && cleanId !== rawId
  const idPart = rawId
    ? changedId
      ? `${cleanId}-${hash(rawId)}`
      : cleanId
    : hashFallback(info)
  const service = title ? '' : slugify(info.extractor ?? '')
  const prefix = title || (service ? `video-${service}` : 'video')
  const literal = `${prefix}-${idPart}`

  if (/[/%\\]/.test(literal)) {
    throw new Error('Generated filename contains an unsafe character.')
  }
  return `${literal}${suffix}.%(ext)s`
}

export function isPortrait(info: {
  width?: number
  height?: number
  formats?: Array<{width?: number; height?: number; vcodec?: string}>
}): boolean {
  if (isPositiveNumber(info.width) && isPositiveNumber(info.height)) {
    return info.width < info.height
  }

  const largestVideo = (info.formats ?? []).reduce<{
    width?: number
    height?: number
    vcodec?: string
  } | undefined>((largest, format) => {
    if (!format.vcodec || format.vcodec === 'none' || !isPositiveNumber(format.width) || !isPositiveNumber(format.height)) {
      return largest
    }
    if (!largest || format.width * format.height > (largest.width as number) * (largest.height as number)) {
      return format
    }
    return largest
  }, undefined)

  return Boolean(largestVideo && (largestVideo.width as number) < (largestVideo.height as number))
}

function isPositiveNumber(value: number | undefined): value is number {
  return typeof value === 'number' && value > 0
}

function hashFallback(info: {id?: string; title?: string; webpage_url?: string}): string {
  return hash(info.webpage_url || info.title || 'video')
}

function hash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}
