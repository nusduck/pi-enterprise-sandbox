/** HMAC claims attached to the current fetch Request after the internal middleware. */
export const internalClaimsByRequest = new WeakMap<
  Request,
  { sandbox_session_id?: string; agent_session_id?: string }
>();
