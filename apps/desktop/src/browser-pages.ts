/**
 * What counts as a page the built-in browser can offer an agent.
 *
 * A live guest is not the same thing as a page. A guest exists from the moment its
 * tab mounts, before anything has been navigated, and it survives while its tab is
 * retained or its pane is collapsed. Listing by liveness therefore offers documents
 * that carry no page — and it does so with a NAME: Chromium keeps the previous title
 * across a navigation to a blank document, so an entry can read "Example Domain"
 * while the guest sits on `about:blank`.
 *
 * That is not a cosmetic problem. An agent that asks which pages it may drive is
 * told about a page that is no longer there, and every later call against that entry
 * addresses a blank document. The shell asked for pages, so it must not answer with
 * a title alone.
 */

/**
 * Whether a guest is on a document worth offering to an agent.
 *
 * The lease-bearing bootstrap document is `about:blank#<lease>`: it is how the shell
 * hands a guest its partition before anyone navigates, so it is a reservation, not a
 * page.
 * @param url - the guest's current URL, as Electron reports it.
 * @returns whether the guest has a page an agent can address.
 */
export function offersPage(url: string): boolean {
  return url !== '' && url !== 'about:blank' && !url.startsWith('about:blank#')
}
