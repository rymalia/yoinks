import React, {type ReactNode} from 'react'
import {Text} from 'ink'
import {useTheme} from '../theme.js'

// non-breaking spaces keep a hint on one line, so a narrow terminal wraps
// the footer between hints (never "^t" / "theme:auto") and click targets,
// which match a single rendered line, keep working
const glue = (text: string) => text.replace(/ /g, ' ')

/** The hint's text exactly as it appears in the rendered frame. */
export const hintText = (key: string, label: string) => glue(`${key} ${label}`)

/** `leading` renders before the shortcut items, joined by the same `·`. */
export function Shortcuts({items, leading}: {items: Array<[key: string, label: string]>; leading?: ReactNode}) {
  const theme = useTheme()
  return (
    <Text>
      {leading ? (
        <>
          {leading}
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{'  ·  '}</Text>
        </>
      ) : null}
      {items.map(([key, label], index) => (
        <Text key={`${key}-${label}`}>
          {index > 0 ? <Text color={theme.gray} dimColor={theme.dimSecondary}>{'  ·  '}</Text> : null}
          <Text color={theme.primary}>{glue(key)}</Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{glue(` ${label}`)}</Text>
        </Text>
      ))}
    </Text>
  )
}
