/**
 * Visual body of one inline reference chip: the DecoratorNode's React
 * face. Pure display — identity, invalidation, and lifecycle live on the
 * ReferenceChipNode; this component renders whatever the node carries.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ReferenceIconRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReferenceIconKind } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ReferenceChip.module.css'
import referenceCss from './composer-editor.module.css'

/** Display inputs of one chip (the node's cached owner projections). */
export interface ReferenceChipProps {
  readonly label: string
  /** Domain glyph; absent renders the trigger marker instead of an icon. */
  readonly appearance?: ReferenceIconKind | undefined
  /** Owner-resolution failure styling bit. */
  readonly invalid: boolean
  /**
   * Take this chip off the draft, when the reader asks for it.
   *
   * Absent means no gesture is offered: the chip stays pure display, and whoever owns the editor
   * decides whether a removal is possible at all.
   */
  readonly onRemove?: (() => void) | undefined
}

/**
 * Render one inline reference chip.
 * @param props - label, optional domain glyph, and the invalid bit.
 * @returns the chip body (icon + truncating label).
 */
export function ReferenceChip({ label, appearance, invalid, onRemove }: ReferenceChipProps): ReactNode {
  return (
    <span className={clsx(referenceCss.reference, css.chip, appearance === 'file' && !invalid && referenceCss.openable, invalid && css.invalid)} title={label}>
      {appearance === undefined
        ? <span className={css.marker} aria-hidden>@</span>
        : <ReferenceIconRegular kind={appearance} size={14} className={css.icon} />}
      <span className={css.label}>{label}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          className={css.remove}
          data-composer-chip-remove
          aria-label={label}
          // An SVG, not a glyph: the chip element's text is its label and nothing else, and a
          // literal × would quietly become part of it.
          // The chip lives in a contenteditable, so a pointerdown that reached the editor would
          // start a selection and the click would move the caret; neither is let through.
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRemove() }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </span>
  )
}
