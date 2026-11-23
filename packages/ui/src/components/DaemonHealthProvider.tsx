import type { ReactNode } from "react";
import { DaemonHealthContext, useDaemonHealth } from "../hooks/useDaemonHealth.js";
import { DaemonOffline } from "./DaemonOffline.js";

export function DaemonHealthProvider({ children }: { children: ReactNode }) {
  const { query, signal } = useDaemonHealth();
  // The daemon didn't answer /healthz at all (not merely a slow event loop): explain and offer the start command.
  // It stays up while a retry is in flight (the query keeps its error status) and goes away on the first good answer.
  const offline = query.isError;
  return (
    <DaemonHealthContext.Provider value={signal}>
      {children}
      {offline ? <DaemonOffline onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
    </DaemonHealthContext.Provider>
  );
}
