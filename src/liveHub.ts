/**
 * In-process pub/sub for the API's own live connections (/v1/live). Messages carry no personal data,
 * only "something changed" pings; apps re-fetch from the API, which checks the login again.
 * One API instance → one hub. With several instances this would move to Postgres LISTEN/NOTIFY or Redis.
 */
type Listener = (msg: { topic: string; event: string; payload: Record<string, unknown> }) => void;
const topics = new Map<string, Set<Listener>>();

export function listen(topic: string, fn: Listener) {
  let set = topics.get(topic);
  if (!set) topics.set(topic, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) topics.delete(topic);
  };
}

export function publish(topic: string, event: string, payload: Record<string, unknown>) {
  for (const fn of topics.get(topic) ?? []) {
    try {
      fn({ topic, event, payload });
    } catch {
      // a closed socket; its cleanup removes it
    }
  }
}
