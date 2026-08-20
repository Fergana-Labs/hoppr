/**
 * Error taxonomy. The distinction that matters operationally is `terminal` —
 * a terminal failure must not be retried by a sweep, or one poison row wedges
 * the queue forever. See db/reconcile.
 */
export type HopprErrorKind =
  | 'user' // bad input / config; show the message, don't retry
  | 'notfound'
  | 'conflict' // e.g. an install target we don't own
  | 'transient' // network, lock contention; retry is reasonable
  | 'terminal' // this row will never succeed; stop retrying it
  | 'internal'

export class HopprError extends Error {
  readonly kind: HopprErrorKind
  readonly detail?: unknown

  constructor(kind: HopprErrorKind, message: string, detail?: unknown) {
    super(message)
    this.name = 'HopprError'
    this.kind = kind
    this.detail = detail
  }

  static user(msg: string, detail?: unknown) {
    return new HopprError('user', msg, detail)
  }
  static notFound(msg: string, detail?: unknown) {
    return new HopprError('notfound', msg, detail)
  }
  static conflict(msg: string, detail?: unknown) {
    return new HopprError('conflict', msg, detail)
  }
  static transient(msg: string, detail?: unknown) {
    return new HopprError('transient', msg, detail)
  }
  static terminal(msg: string, detail?: unknown) {
    return new HopprError('terminal', msg, detail)
  }
  static internal(msg: string, detail?: unknown) {
    return new HopprError('internal', msg, detail)
  }
}
