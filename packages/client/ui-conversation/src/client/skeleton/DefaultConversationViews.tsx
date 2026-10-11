import { useEffect, useRef } from 'react'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft persisted while blank Hero chrome is visible.
 *
 * Every View the reader has opened stays MOUNTED for as long as its Session
 * does; only the one being looked at is visible. A View is not always a picture
 * of state the shell can rebuild: the Browser's 「网页」 holds a live guest page,
 * attached to the element the View renders into and torn down with it. Unmounting
 * the View on a switch away therefore reloads that page — losing its scroll, its
 * form input, and its place — which the reader sees as "it went back to the start".
 *
 * Retention is bounded in both directions: a View that was never opened is never
 * rendered, and the blank Hero keeps rendering no View at all.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the visited View areas, only the active one shown, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, useSession, useConversation, useConversationViews, inputActions, useStore, actions,
  renderSlot, bindDraftPersistence, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const viewRequest = useStore(s => s.viewRequest ?? null)
  // First-visit order of the mounted View areas, and the one being looked at.
  // Both are refs rather than state: mounting a View is what renders the area
  // appended here, so this render already has to produce it — a state update
  // would re-render the same tree with the same answer. Declared with the other
  // hooks because the blank-Hero return below must stay the last statement.
  const visited = useRef<readonly string[]>([])
  const shown = useRef<string | undefined>(undefined)

  useEffect(() => {
    const unbindDraftPersistence = bindDraftPersistence(actions.setDraft)
    inputActions.persistDraft()
    return () => { unbindDraftPersistence() }
    // The Session input owns content before this persistence writer is attached.
  }, [inputActions])

  if (session.blank && conversationPhase(session, conversation) === 'blank') return null
  const viewId = view ?? active?.id
  if (viewId !== undefined) {
    shown.current = viewId
    if (!visited.current.includes(viewId)) visited.current = [...visited.current, viewId]
  }
  const areas = visited.current
  const owner = {
    inspectCall,
    viewRequest,
    openView,
    completeViewRequest: actions.completeViewRequest,
  }
  return (
    <div className={css.viewArea}>
      {areas.map(id => (
        // One area per visited View, kept in the document so the element a guest
        // page is attached to never leaves it; the others are hidden, not removed.
        <div key={id} hidden={id !== shown.current} data-conversation-view={id}>
          {renderSlot('conversation.view', owner, { only: id })}
        </div>
      ))}
    </div>
  )
}
