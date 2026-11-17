import type { MouseEvent, ReactNode } from 'react'
import { navigate, type Route, routePath } from './router'

/** An in-app link: a real `href` (new tab, copy link) that navigates without a reload. */
export function RouteLink({
  to,
  className,
  label,
  current,
  children,
}: {
  to: Route
  className?: string
  /** The link's accessible name, when its content is an icon. */
  label?: string
  /** The link is the page the reader is on (a tab of a set). */
  current?: boolean
  children: ReactNode
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return (
    <a
      className={className ?? 'route-link'}
      href={routePath(to)}
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
    </a>
  )
}
