export const CHANNELS = {
  motion:   (sessionId: string) => `session:${sessionId}:motion`,
  scores:   (sessionId: string) => `session:${sessionId}:scores`,
  state:    (sessionId: string) => `session:${sessionId}:state`,
  // Dedicated channel for Presence tracking — kept separate from motion so
  // that presence callbacks (which must be registered before subscribe()) can
  // be added independently of the already-subscribed motion channel.
  presence: (sessionId: string) => `session:${sessionId}:presence`,
};

export type ChannelType = keyof typeof CHANNELS;

/**
 * Returns the full Realtime channel name for a given type and session.
 * Prefer this over calling CHANNELS[type](sessionId) directly so that
 * call sites don't need to know the naming convention.
 */
export function getChannelName(type: ChannelType, sessionId: string): string {
  return CHANNELS[type](sessionId);
}
