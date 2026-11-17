import type { ComponentType } from 'react'
import { Icon } from '../../ui/sidebarIcons'
import type { EditorKind } from '../editor/BookEditor'

/*
 * The writing tools' icons, in the sidebar's own hand (`sidebarIcons.tsx`: the 24-unit set, a
 * 1.5 px line, round caps): drawn, never set as glyphs. They live in the writer's chunk.
 */

/** ¶: Paragraph. */
export function ParagraphIcon() {
  return (
    <Icon>
      <path className="sidebar-icon-fill" d="M11 4.75a3.6 3.6 0 0 0 0 7.2Z" />
      <path d="M11 19.25V4.75h6.5M15 4.75v14.5" />
    </Icon>
  )
}

/** Chapter: its numeral standing on the rule a chapter's title has beneath it. */
export function ChapterIcon() {
  return (
    <Icon>
      <path d="M10.3 7.1l2.7-2.1v10.5M6.75 19.25h10.5" />
    </Icon>
  )
}

/** Section: the section mark, §, as two linked strokes. */
export function SectionIcon() {
  return (
    <Icon>
      <path d="M15.2 6.3c-.6-1.1-1.8-1.8-3.2-1.8-1.8 0-3.1 1-3.1 2.4 0 3.1 6.4 2.7 6.4 6 0 1.2-.9 2.2-2.3 2.5" />
      <path d="M8.8 17.7c.6 1.1 1.8 1.8 3.2 1.8 1.8 0 3.1-1 3.1-2.4 0-3.1-6.4-2.7-6.4-6 0-1.2.9-2.2 2.3-2.5" />
    </Icon>
  )
}

/** Quote: lines set in from a rule. */
export function QuoteIcon() {
  return (
    <Icon>
      <path d="M5.75 5.75v12.5M9.75 8h8.5M9.75 12h8.5M9.75 16h5.5" />
    </Icon>
  )
}

/** List: three marks and their lines. */
export function ListIcon() {
  return (
    <Icon>
      <circle className="sidebar-icon-fill" cx="6" cy="7.25" r="1.05" />
      <circle className="sidebar-icon-fill" cx="6" cy="12" r="1.05" />
      <circle className="sidebar-icon-fill" cx="6" cy="16.75" r="1.05" />
      <path d="M9.75 7.25h9M9.75 12h9M9.75 16.75h9" />
    </Icon>
  )
}

/** Prompt: a note to the writer, a slip with its tail. */
export function PromptIcon() {
  return (
    <Icon>
      <path d="M6.3 5.5h11.4c.7 0 1.3.6 1.3 1.3v7.4c0 .7-.6 1.3-1.3 1.3H11.2l-3.7 3v-3H6.3c-.7 0-1.3-.6-1.3-1.3V6.8c0-.7.6-1.3 1.3-1.3ZM8.6 9.25h6.8M8.6 12h4.2" />
    </Icon>
  )
}

/** Bold: a B in a heavier line. */
export function BoldIcon() {
  return (
    <Icon>
      <path
        className="writing-icon-bold"
        d="M8 5.5h4.6a3.15 3.15 0 0 1 0 6.3H8ZM8 11.8h5.4a3.35 3.35 0 0 1 0 6.7H8Z"
      />
    </Icon>
  )
}

/** Italic: a slanted I with its serifs. */
export function ItalicIcon() {
  return (
    <Icon>
      <path d="M10.5 5.5h6.5M7 18.5h6.5M13.9 5.5l-3.3 13" />
    </Icon>
  )
}

/** Footnote: the lines of a page's foot and the small raised number of its anchor. */
export function FootnoteIcon() {
  return (
    <Icon>
      <path d="M4.75 13.25h9.5M4.75 17.75h14.5M16.4 6.4l2-1.4v6" />
    </Icon>
  )
}

/** Pin to board: a drawing pin. */
export function PinIcon() {
  return (
    <Icon>
      <path d="M9 4.75h6M10.25 4.75v4.9l-2.6 3.1h8.7l-2.6-3.1v-4.9M12 12.75v6.5" />
    </Icon>
  )
}

/** Text style's face: the kind of the caret's block. */
export const KIND_ICON: Partial<Record<EditorKind, ComponentType>> = {
  p: ParagraphIcon,
  h1: ChapterIcon,
  h2: SectionIcon,
  quote: QuoteIcon,
  li: ListIcon,
  prompt: PromptIcon,
}
